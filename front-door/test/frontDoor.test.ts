import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Env } from "../src/config";
import { resetDiscoveryCache } from "../src/descope";
import worker from "../src/index";

const DISCOVERY = "https://api.descope.test/v1/apps/P123/.well-known/openid-configuration";
const ISSUER = "https://api.descope.test/P123";
const BC = "https://api.descope.test/oauth2/v1/apps/bc-authorize";
const TOKEN = "https://api.descope.test/oauth2/v1/apps/token";
const DEVICE = "https://api.descope.test/oauth2/v1/apps/device/authorize";
const HINT_SECRET = "hint-secret";

const env: Env = {
  SITE_NAME: "Northbound",
  DESCOPE_DISCOVERY_URL: DISCOVERY,
  UNVERIFIED_CLIENT_ID: "client-unverified",
  VERIFIED_CLIENT_ID: "client-verified",
  TRUSTED_PLATFORMS: JSON.stringify({ "https://agent.example": "client-trusted" }),
  TRUSTED_SCOPES: "openid orders:read cart:write",
  UNVERIFIED_SCOPES: "openid orders:read",
  STATE_SECRET: "state-secret",
  HINT_SIGNING_SECRET: HINT_SECRET,
  CLIENT_SECRETS: JSON.stringify({ "client-unverified": "s1", "client-verified": "s2", "client-trusted": "s3" }),
};

/** A fake Descope that records CIBA calls and answers token polls from a queue. */
let calls: { url: string; params: URLSearchParams }[];
let tokenAnswers: { status: number; body: unknown }[];
/** Whether the fake Descope advertises the device flow. Off by default, like the real inbound app today. */
let deviceFlow = false;
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  tokenAnswers = [];
  deviceFlow = false;
  resetDiscoveryCache();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === DISCOVERY) {
      return Response.json({
        issuer: ISSUER, token_endpoint: TOKEN, backchannel_authentication_endpoint: BC,
        ...(deviceFlow ? { device_authorization_endpoint: DEVICE } : {}),
      });
    }
    const params = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ url, params });
    if (url === BC) return Response.json({ auth_req_id: "req-1", expires_in: 300, interval: 2 });
    if (url === DEVICE) {
      return Response.json({
        device_code: "dc-1", user_code: "WDJB-MJHT", verification_uri: "https://auth.test/device",
        verification_uri_complete: "https://auth.test/device?user_code=WDJB-MJHT", expires_in: 600, interval: 5,
      });
    }
    if (url === TOKEN) {
      const answer = tokenAnswers.shift() ?? { status: 400, body: { error: "authorization_pending" } };
      return Response.json(answer.body, { status: answer.status });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const call = (request: Request, overrides: Partial<Env> = {}) => worker.fetch(request as never, { ...env, ...overrides }, {} as never);
const connectJson = (body: Record<string, string>) =>
  call(new Request("https://front-door.test/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

/** Signs a hint the way the edge integration does (cloudflare/src/hint.ts). */
async function edgeHint(payload: Record<string, unknown>, secret = HINT_SECRET): Promise<string> {
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
  const body = b64(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${body}.${b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))))}`;
}
const now = () => Math.floor(Date.now() / 1000);

test("the connect page has an email form and keeps return_to and agent_hint", async () => {
  const response = await call(new Request("https://front-door.test/?return_to=https://shop.test/login&agent_hint=abc.def"));
  const html = await response.text();
  assert.match(html, /<input id="email" name="email" type="email"/);
  assert.match(html, /name="return_to" value="https:\/\/shop.test\/login"/);
  assert.match(html, /name="agent_hint" value="abc.def"/);
  assert.match(html, /Instructions for AI agents/);
});

test("a return_to that isn't http(s) is dropped", async () => {
  const html = await (await call(new Request("https://front-door.test/?return_to=javascript:alert(1)"))).text();
  assert.doesNotMatch(html, /javascript:/);
});

test("an unverified agent gets the shared client, a code, and an agent ID", async () => {
  const response = await connectJson({ email: "pat@example.com" });
  const data = (await response.json()) as Record<string, string>;
  assert.equal(data.tier, "unverified");
  assert.match(data.code, /^[A-Z2-9]{6}$/);
  assert.match(data.agent_id, /^agt_/);
  assert.match(data.status_url, /\/status\?handle=/);

  const ciba = calls.find((c) => c.url === BC)!;
  assert.equal(ciba.params.get("client_id"), "client-unverified");
  assert.equal(ciba.params.get("client_secret"), "s1");
  assert.equal(ciba.params.get("login_hint"), "pat@example.com");
  assert.equal(ciba.params.get("scope"), "openid orders:read");
  assert.equal(ciba.params.get("binding_message"), `An unverified agent wants to connect to Northbound. Code ${data.code}`);
});

test("a verified edge hint from a trusted platform gets that platform's client", async () => {
  const hint = await edgeHint({ status: "verified", signature_agent: "https://agent.example", iat: now(), exp: now() + 300 });
  const data = (await (await connectJson({ email: "pat@example.com", agent_hint: hint })).json()) as Record<string, string>;
  assert.equal(data.tier, "trusted");
  const ciba = calls.find((c) => c.url === BC)!;
  assert.equal(ciba.params.get("client_id"), "client-trusted");
  assert.equal(ciba.params.get("scope"), "openid orders:read cart:write");
  assert.match(ciba.params.get("binding_message")!, /^An agent from agent\.example wants/);
});

test("a verified edge hint from another platform gets the verified client", async () => {
  const hint = await edgeHint({ status: "verified", signature_agent: "https://other.example", iat: now(), exp: now() + 300 });
  const data = (await (await connectJson({ email: "pat@example.com", agent_hint: hint })).json()) as Record<string, string>;
  assert.equal(data.tier, "verified");
  assert.equal(calls.find((c) => c.url === BC)!.params.get("client_id"), "client-verified");
});

test("forged or expired hints are treated as unverified", async () => {
  const forged = await edgeHint({ status: "verified", signature_agent: "https://agent.example", iat: now(), exp: now() + 300 }, "wrong");
  const expired = await edgeHint({ status: "verified", signature_agent: "https://agent.example", iat: 0, exp: 1 });
  for (const hint of [forged, expired]) {
    const data = (await (await connectJson({ email: "pat@example.com", agent_hint: hint })).json()) as Record<string, string>;
    assert.equal(data.tier, "unverified");
  }
});

test("status stays pending, then returns the token without the refresh token", async () => {
  const { handle, agent_id } = (await (await connectJson({ email: "pat@example.com" })).json()) as Record<string, string>;
  const statusUrl = `https://front-door.test/status?handle=${encodeURIComponent(handle)}`;

  assert.equal(((await (await call(new Request(statusUrl))).json()) as { status: string }).status, "pending");

  tokenAnswers.push({ status: 200, body: { access_token: "at", token_type: "Bearer", expires_in: 600, refresh_token: "rt" } });
  const approved = (await (await call(new Request(statusUrl))).json()) as Record<string, unknown>;
  assert.equal(approved.status, "approved");
  assert.equal(approved.access_token, "at");
  assert.equal(approved.agent_id, agent_id);
  assert.equal(approved.refresh_token, undefined);

  const poll = calls.filter((c) => c.url === TOKEN).at(-1)!;
  assert.equal(poll.params.get("grant_type"), "urn:openid:params:grant-type:ciba");
  assert.equal(poll.params.get("auth_req_id"), "req-1");
});

test("a declined request reports denied, and a tampered handle is rejected", async () => {
  const { handle } = (await (await connectJson({ email: "pat@example.com" })).json()) as Record<string, string>;
  tokenAnswers.push({ status: 400, body: { error: "access_denied" } });
  const denied = await call(new Request(`https://front-door.test/status?handle=${encodeURIComponent(handle)}`));
  assert.equal(((await denied.json()) as { status: string }).status, "denied");

  const tampered = await call(new Request(`https://front-door.test/status?handle=${handle.slice(0, -2)}xx`));
  assert.equal(tampered.status, 400);
});

test("private_key_jwt assertions verify against /jwks.json", async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const privateJwk = { ...(await crypto.subtle.exportKey("jwk", pair.privateKey)), kid: "k1" };
  const overrides = { PRIVATE_KEY_JWK: JSON.stringify(privateJwk), CLIENT_SECRETS: "" };

  await worker.fetch(new Request("https://front-door.test/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "pat@example.com" }),
  }) as never, { ...env, ...overrides }, {} as never);
  const ciba = calls.find((c) => c.url === BC)!;
  assert.equal(ciba.params.get("client_secret"), null);
  assert.equal(ciba.params.get("client_assertion_type"), "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");

  const [header, claims, signature] = ciba.params.get("client_assertion")!.split(".");
  const payload = JSON.parse(Buffer.from(claims, "base64url").toString());
  assert.equal(payload.iss, "client-unverified");
  assert.equal(payload.sub, "client-unverified");
  assert.deepEqual(payload.aud, [ISSUER, BC]);

  const { keys } = (await (await call(new Request("https://front-door.test/jwks.json"), overrides)).json()) as { keys: JsonWebKey[] };
  assert.equal(keys.length, 1);
  assert.equal((keys[0] as { d?: string }).d, undefined);
  const publicKey = await crypto.subtle.importKey("jwk", { kty: keys[0].kty, crv: keys[0].crv, x: keys[0].x, y: keys[0].y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    Buffer.from(signature, "base64url"),
    new TextEncoder().encode(`${header}.${claims}`),
  );
  assert.equal(valid, true);
});

test("an invalid email re-renders the form with an error", async () => {
  const response = await call(new Request("https://front-door.test/connect", {
    method: "POST",
    body: new URLSearchParams({ email: "not-an-email" }),
  }));
  assert.match(await response.text(), /Enter a valid email address/);
  assert.equal(calls.length, 0);
});

test("placeholder configuration returns a clear error", async () => {
  const response = await call(new Request("https://front-door.test/"), { UNVERIFIED_CLIENT_ID: "YOUR_UNVERIFIED_CLIENT_ID" });
  assert.equal(response.status, 500);
  assert.match(((await response.json()) as { message: string }).message, /UNVERIFIED_CLIENT_ID/);
});

test("slow_down adds 5 seconds to the interval, and the new handle keeps it", async () => {
  const { handle } = (await (await connectJson({ email: "pat@example.com" })).json()) as Record<string, string>;
  tokenAnswers.push({ status: 400, body: { error: "slow_down" } });
  const first = (await (await call(new Request(`https://front-door.test/status?handle=${encodeURIComponent(handle)}`))).json()) as Record<string, unknown>;
  assert.equal(first.status, "pending");
  assert.equal(first.interval, 7);
  assert.equal(typeof first.handle, "string");

  // Later polls with the new handle keep the slower interval, and slow down again on another slow_down.
  tokenAnswers.push({ status: 400, body: { error: "authorization_pending" } });
  const second = (await (await call(new Request(`https://front-door.test/status?handle=${encodeURIComponent(String(first.handle))}`))).json()) as Record<string, unknown>;
  assert.equal(second.interval, 7);
  tokenAnswers.push({ status: 400, body: { error: "slow_down" } });
  const third = (await (await call(new Request(`https://front-door.test/status?handle=${encodeURIComponent(String(first.handle))}`))).json()) as Record<string, unknown>;
  assert.equal(third.interval, 12);
});

/** Starts a request, approves it, and returns the /status response. */
async function approve(overrides: Partial<Env> = {}, token: Record<string, unknown> = { access_token: "at", token_type: "Bearer", expires_in: 600, refresh_token: "rt" }) {
  const started = await call(new Request("https://front-door.test/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "pat@example.com" }),
  }), overrides);
  const { handle } = (await started.json()) as Record<string, string>;
  tokenAnswers.push({ status: 200, body: token });
  return call(new Request(`https://front-door.test/status?handle=${encodeURIComponent(handle)}`), overrides);
}
const cookie = (response: Response, name: string) => response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

/** A browser request redirects to the reload-safe /wait page: returns its handle and binding cookie. */
function toWait(response: Response) {
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get("location")!, "https://front-door.test");
  assert.equal(location.pathname, "/wait");
  return { handle: location.searchParams.get("handle")!, bind: cookie(response, "fd_bind")!.split(";")[0], location: location.toString() };
}

test("approval sets the access token cookie for the site and a refresh cookie for the front door", async () => {
  const response = await approve({ COOKIE_DOMAIN: "shop.test" });
  const access = cookie(response, "DS")!;
  assert.match(access, /^DS=at;/);
  assert.match(access, /Domain=shop\.test/);
  assert.match(access, /Path=\//);
  assert.match(access, /Max-Age=600/);
  assert.match(access, /HttpOnly/);
  assert.match(access, /Secure/);
  assert.match(access, /SameSite=Lax/);

  const refresh = cookie(response, "DSR")!;
  assert.match(refresh, /Path=\/refresh/);
  assert.match(refresh, /HttpOnly/);
  assert.doesNotMatch(refresh, /Domain=/);
  assert.doesNotMatch(refresh, /DSR=rt;/, "the refresh token is sealed, not stored in the clear");

  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.access_token, "at");
  assert.equal(body.refresh_token, undefined);
});

test("cookie names are configurable and cookies can be turned off", async () => {
  const renamed = await approve({ ACCESS_TOKEN_COOKIE: "agent_at", REFRESH_TOKEN_COOKIE: "agent_rt" });
  assert.ok(cookie(renamed, "agent_at"));
  assert.ok(cookie(renamed, "agent_rt"));
  const off = await approve({ SESSION_COOKIES: "false" });
  assert.deepEqual(off.headers.getSetCookie(), []);
});

test("/refresh exchanges the refresh cookie for new tokens", async () => {
  const approved = await approve();
  const refreshCookie = cookie(approved, "DSR")!.split(";")[0];
  tokenAnswers.push({ status: 200, body: { access_token: "at2", token_type: "Bearer", expires_in: 600, refresh_token: "rt2" } });

  const response = await call(new Request("https://front-door.test/refresh", { method: "POST", headers: { cookie: refreshCookie } }));
  assert.equal(response.status, 200);
  assert.match(cookie(response, "DS")!, /^DS=at2;/);
  assert.ok(cookie(response, "DSR"), "a rotated refresh token gets a new cookie");

  const exchange = calls.filter((c) => c.url === TOKEN).at(-1)!;
  assert.equal(exchange.params.get("grant_type"), "refresh_token");
  assert.equal(exchange.params.get("refresh_token"), "rt");
  assert.equal(exchange.params.get("client_id"), "client-unverified");
  assert.equal(exchange.params.get("client_secret"), "s1");
});

test("GET /refresh redirects back to return_to, and fails without a refresh cookie", async () => {
  const approved = await approve();
  const refreshCookie = cookie(approved, "DSR")!.split(";")[0];
  tokenAnswers.push({ status: 200, body: { access_token: "at2", token_type: "Bearer", expires_in: 600 } });
  const redirect = await call(new Request("https://front-door.test/refresh?return_to=https://shop.test/orders", { headers: { cookie: refreshCookie } }));
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "https://shop.test/orders");
  assert.match(cookie(redirect, "DS")!, /^DS=at2;/);

  const missing = await call(new Request("https://front-door.test/refresh", { method: "POST" }));
  assert.equal(missing.status, 401);
});

test("a rejected refresh clears the cookies", async () => {
  const approved = await approve();
  const refreshCookie = cookie(approved, "DSR")!.split(";")[0];
  tokenAnswers.push({ status: 400, body: { error: "invalid_grant" } });
  const response = await call(new Request("https://front-door.test/refresh", { method: "POST", headers: { cookie: refreshCookie } }));
  assert.equal(response.status, 401);
  assert.match(cookie(response, "DS")!, /Max-Age=0/);
  assert.match(cookie(response, "DSR")!, /Max-Age=0/);
});

test("Descope's own error format is logged, not shown to the agent", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === BC) {
      return Response.json({ errorCode: "E074130", errorDescription: "Request is invalid", errorMessage: "Invalid client id" }, { status: 400 });
    }
    return real(input, init);
  }) as typeof fetch;
  const logged: string[] = [];
  const realError = console.error;
  console.error = (line: string) => { logged.push(String(line)); };
  try {
    const response = await connectJson({ email: "pat@example.com" });
    const body = (await response.json()) as { message: string };
    assert.doesNotMatch(body.message, /E074130/);
  } finally {
    console.error = realError;
  }
  const entry = logged.find((l) => l.includes("connect_failed"))!;
  assert.match(entry, /E074130/);
  assert.match(entry, /Invalid client id/);
});

test("each tier's access description goes in the approval message, with {site} filled in", async () => {
  const overrides = {
    TRUSTED_ACCESS: "place orders up to $200 at {site} over the next 7 days",
    UNVERIFIED_ACCESS: "view your orders at {site}",
  };
  const hint = await edgeHint({ status: "verified", signature_agent: "https://agent.example", iat: now(), exp: now() + 300 });
  const trusted = await call(new Request("https://front-door.test/connect", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "pat@example.com", agent_hint: hint }),
  }), overrides);
  const { code } = (await trusted.json()) as { code: string };
  assert.equal(calls.filter((c) => c.url === BC).at(-1)!.params.get("binding_message"),
    `An agent from agent.example wants to place orders up to $200 at Northbound over the next 7 days. Code ${code}`);

  await call(new Request("https://front-door.test/connect", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "pat@example.com" }),
  }), overrides);
  assert.match(calls.filter((c) => c.url === BC).at(-1)!.params.get("binding_message")!,
    /^An unverified agent wants to view your orders at Northbound\. Code [A-Z2-9]{6}$/);
});

/** A stand-in for a Workers rate limiting binding that records keys and refuses the ones in `blocked`. */
function limiter(blocked: string[] = []) {
  const keys: string[] = [];
  return { keys, limit: async ({ key }: { key: string }) => { keys.push(key); return { success: !blocked.includes(key) }; } };
}

test("/connect is rate limited per IP and per email, before any CIBA request", async () => {
  const byIp = limiter();
  const byEmail = limiter(["pat@example.com"]);
  const response = await worker.fetch(new Request("https://front-door.test/connect", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify({ email: "Pat@Example.com" }),
  }) as never, { ...env, CONNECT_IP_LIMITER: byIp, CONNECT_EMAIL_LIMITER: byEmail } as never, {} as never);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.deepEqual(byIp.keys, ["203.0.113.7"]);
  assert.deepEqual(byEmail.keys, ["pat@example.com"]);
  assert.equal(calls.filter((c) => c.url === BC).length, 0);
});

test("a JSON request's handle only works from the IP that started it", async () => {
  const started = await call(new Request("https://front-door.test/connect", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify({ email: "pat@example.com" }),
  }));
  const { handle } = (await started.json()) as { handle: string };
  const statusFrom = (ip: string) => call(new Request(`https://front-door.test/status?handle=${encodeURIComponent(handle)}`, {
    headers: { "cf-connecting-ip": ip },
  }));
  assert.equal((await statusFrom("198.51.100.9")).status, 403);
  assert.equal(((await (await statusFrom("203.0.113.7")).json()) as { status: string }).status, "pending");
});

test("a browser request's handle only works with the cookie set on its waiting page", async () => {
  const started = await call(new Request("https://front-door.test/connect", {
    method: "POST",
    body: new URLSearchParams({ email: "pat@example.com" }),
  }));
  const setBind = started.headers.getSetCookie().find((c) => c.startsWith("fd_bind="))!;
  assert.match(setBind, /Path=\//);
  assert.match(setBind, /HttpOnly/);
  const { handle, bind } = toWait(started);
  const statusUrl = `https://front-door.test/status?handle=${encodeURIComponent(handle)}`;
  assert.equal((await call(new Request(statusUrl))).status, 403);
  const withCookie = await call(new Request(statusUrl, { headers: { cookie: bind } }));
  assert.equal(((await withCookie.json()) as { status: string }).status, "pending");
});

const STEP_UP_SECRET = "step-up-secret";

/** Signs a step-up request the way the store does: base64url(JSON) + "." + base64url(HMAC-SHA256). */
async function stepUpRequest(payload: Record<string, unknown>, secret = STEP_UP_SECRET) {
  return edgeHint(payload, secret);
}

test("step-up asks for orders:write with a message naming the order the store signed", async () => {
  const approved = await approve({ STEP_UP_SECRET, TRUSTED_ACCESS: "view your orders at {site}" });
  const refreshCookie = cookie(approved, "DSR")!.split(";")[0];
  const request = await stepUpRequest({ email: "pat@example.com", amount: "$18.95", exp: now() + 300 });

  const response = await call(new Request(
    `https://front-door.test/step-up?request=${encodeURIComponent(request)}&return_to=${encodeURIComponent("https://shop.test/checkout")}`,
    { headers: { cookie: refreshCookie } },
  ), { STEP_UP_SECRET });
  const waiting = toWait(response);
  const html = await (await call(new Request(waiting.location, { headers: { cookie: waiting.bind } }), { STEP_UP_SECRET })).text();
  assert.match(html, /Check your email/);

  const ciba = calls.filter((c) => c.url === BC).at(-1)!;
  assert.equal(ciba.params.get("client_id"), "client-unverified");
  assert.equal(ciba.params.get("login_hint"), "pat@example.com");
  assert.equal(ciba.params.get("scope"), "openid orders:write");
  assert.match(ciba.params.get("binding_message")!, /^An unverified agent wants to place a \$18\.95 order at Northbound\. Code [A-Z2-9]{6}$/);
  assert.match(html, /https:\/\/shop.test\/checkout/);
});

test("step-up rejects a request the store didn't sign, or one that expired", async () => {
  const forged = await stepUpRequest({ email: "pat@example.com", amount: "$1.00", exp: now() + 300 }, "wrong");
  const expired = await stepUpRequest({ email: "pat@example.com", amount: "$18.95", exp: now() - 10 });
  for (const request of [forged, expired, "garbage"]) {
    const response = await call(new Request(`https://front-door.test/step-up?request=${encodeURIComponent(request)}`), { STEP_UP_SECRET });
    assert.equal(response.status, 400);
  }
  assert.equal(calls.filter((c) => c.url === BC).length, 0);
});

test("approving a step-up replaces the access cookie but keeps the read-only refresh cookie", async () => {
  const request = await stepUpRequest({ email: "pat@example.com", amount: "$18.95", exp: now() + 300 });
  const started = await call(new Request(`https://front-door.test/step-up?request=${encodeURIComponent(request)}`), { STEP_UP_SECRET });
  const { handle, bind } = toWait(started);
  tokenAnswers.push({ status: 200, body: { access_token: "write-token", token_type: "Bearer", expires_in: 300, refresh_token: "rt-write" } });
  const status = await call(new Request(`https://front-door.test/status?handle=${encodeURIComponent(handle)}`, { headers: { cookie: bind } }), { STEP_UP_SECRET });
  assert.match(cookie(status, "DS")!, /^DS=write-token;/);
  assert.equal(cookie(status, "DSR"), undefined);
});


const postJson = (body: Record<string, string>, overrides: Partial<Env> = {}) =>
  call(new Request("https://front-door.test/connect", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), overrides);

test("with no email, /connect starts a device flow and returns the link and code for the user", async () => {
  deviceFlow = true;
  const response = await postJson({});
  const data = (await response.json()) as Record<string, string>;
  assert.equal(data.flow, "device");
  assert.equal(data.user_code, "WDJB-MJHT");
  assert.equal(data.verification_uri, "https://auth.test/device");
  assert.equal(data.verification_uri_complete, "https://auth.test/device?user_code=WDJB-MJHT");
  assert.equal(data.message, "Ask the user to open https://auth.test/device?user_code=WDJB-MJHT and approve. It should show the code WDJB-MJHT.");
  assert.ok(data.handle);

  const device = calls.find((c) => c.url === DEVICE)!;
  assert.equal(device.params.get("client_id"), "client-unverified");
  assert.equal(device.params.get("client_secret"), "s1");
  assert.equal(device.params.get("scope"), "openid orders:read");
  assert.equal(device.params.get("login_hint"), null);
  assert.equal(calls.filter((c) => c.url === BC).length, 0);
});

test("flow=device with an email passes it as login_hint, without sending any email", async () => {
  deviceFlow = true;
  await postJson({ flow: "device", email: "pat@example.com" });
  assert.equal(calls.find((c) => c.url === DEVICE)!.params.get("login_hint"), "pat@example.com");
  assert.equal(calls.filter((c) => c.url === BC).length, 0);
});

test("polling a device flow uses the device_code grant and signs the browser in on approval", async () => {
  deviceFlow = true;
  const { handle } = (await (await postJson({})).json()) as { handle: string };
  tokenAnswers.push({ status: 200, body: { access_token: "at", token_type: "Bearer", expires_in: 600, refresh_token: "rt" } });
  const status = await call(new Request(`https://front-door.test/status?handle=${encodeURIComponent(handle)}`));
  assert.equal(((await status.json()) as { status: string }).status, "approved");
  assert.match(status.headers.getSetCookie().find((c) => c.startsWith("DS="))!, /^DS=at;/);
  const poll = calls.filter((c) => c.url === TOKEN).at(-1)!;
  assert.equal(poll.params.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
  assert.equal(poll.params.get("device_code"), "dc-1");
});

test("a browser asking for a code gets a page with the link and code to give the user", async () => {
  deviceFlow = true;
  const response = await call(new Request("https://front-door.test/connect", { method: "POST", body: new URLSearchParams({ flow: "device" }) }));
  const waiting = toWait(response);
  const html = await (await call(new Request(waiting.location, { headers: { cookie: waiting.bind } }))).text();
  assert.match(html, /href="https:\/\/auth\.test\/device\?user_code=WDJB-MJHT"/);
  assert.doesNotMatch(html, /enter this code/i, "the code rides in the link, so the user doesn't type it");
  assert.match(html, /WDJB-MJHT/, "the code is still shown, so the user can check it matches");
});

test("without a device endpoint, connecting needs an email (the CIBA fallback)", async () => {
  const json = await postJson({});
  assert.equal(json.status, 400);
  assert.match(((await json.json()) as { message: string }).message, /email/);
  assert.equal(calls.filter((c) => c.url === DEVICE).length, 0);
});

test("CIBA_FALLBACK=false turns off approval emails for connecting", async () => {
  deviceFlow = true;
  const response = await postJson({ email: "pat@example.com" }, { CIBA_FALLBACK: "false" });
  assert.equal(response.status, 400);
  assert.equal(calls.filter((c) => c.url === BC).length, 0);
});

test("the connect page leads with a sign-in link, with the email form as the fallback", async () => {
  deviceFlow = true;
  const both = await (await call(new Request("https://front-door.test/"))).text();
  assert.match(both, /Get a sign-in link/);
  assert.match(both, /name="email"/);
  assert.ok(both.indexOf("Get a sign-in link") < both.indexOf('name="email"'));

  deviceFlow = false;
  resetDiscoveryCache();
  const cibaOnly = await (await call(new Request("https://front-door.test/"))).text();
  assert.doesNotMatch(cibaOnly, /Get a sign-in link/);
  assert.match(cibaOnly, /name="email"/);

  deviceFlow = true;
  resetDiscoveryCache();
  const deviceOnly = await (await call(new Request("https://front-door.test/"), { CIBA_FALLBACK: "false" })).text();
  assert.match(deviceOnly, /Get a sign-in link/);
  assert.doesNotMatch(deviceOnly, /name="email"/);
});

test("RESOURCE is sent on the connect, step-up, and token requests", async () => {
  deviceFlow = true;
  const resource = { RESOURCE: "https://northbound.camp/agent_resource" };
  const { handle } = (await (await postJson({}, resource)).json()) as { handle: string };
  await postJson({ email: "pat@example.com" }, resource);
  tokenAnswers.push({ status: 400, body: { error: "authorization_pending" } });
  await call(new Request(`https://front-door.test/status?handle=${encodeURIComponent(handle)}`), resource);

  for (const url of [DEVICE, BC, TOKEN]) {
    assert.equal(calls.find((c) => c.url === url)!.params.get("resource"), "https://northbound.camp/agent_resource", url);
  }
});

test("without RESOURCE, no resource parameter is sent", async () => {
  await postJson({ email: "pat@example.com" });
  assert.equal(calls.find((c) => c.url === BC)!.params.get("resource"), null);
});

test("when Descope rejects a connection, agents get a clear message instead of a server error", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === BC) return Response.json({ errorCode: "E011003", errorMessage: "invalid scope" }, { status: 400 });
    return real(input, init);
  }) as typeof fetch;

  const json = await postJson({ email: "pat@example.com" });
  assert.equal(json.status, 502);
  const body = (await json.json()) as { error: string; message: string };
  assert.equal(body.error, "connect_failed");
  assert.doesNotMatch(body.message, /E011003|invalid scope/);

  const page = await call(new Request("https://front-door.test/connect", { method: "POST", body: new URLSearchParams({ email: "pat@example.com" }) }));
  const html = await page.text();
  assert.match(html, /can(?:'|&#39;)t connect agents right now/);
  assert.doesNotMatch(html, /E011003|invalid scope/);
});

test("the waiting page can be reloaded without starting a new request", async () => {
  const started = await call(new Request("https://front-door.test/connect", {
    method: "POST", body: new URLSearchParams({ email: "pat@example.com", return_to: "https://shop.test/cart" }),
  }));
  const { location, bind } = toWait(started);
  const first = await (await call(new Request(location, { headers: { cookie: bind } }))).text();
  const second = await (await call(new Request(location, { headers: { cookie: bind } }))).text();
  assert.equal(calls.filter((c) => c.url === BC).length, 1, "one approval request, however often the page loads");
  const code = first.match(/<p class="code">([A-Z2-9]{6})<\/p>/)![1];
  assert.ok(second.includes(code), "the same code on every load");
  assert.equal((await call(new Request(location))).status, 403, "only the browser that started it");
});

test("once approved, the waiting page sends the browser back to the store", async () => {
  const started = await call(new Request("https://front-door.test/connect", {
    method: "POST", body: new URLSearchParams({ email: "pat@example.com", return_to: "https://shop.test/cart" }),
  }));
  const { location, bind } = toWait(started);
  const html = await (await call(new Request(location, { headers: { cookie: bind } }))).text();
  assert.match(html, /returns you to Northbound, signed in/);
  assert.match(html, /location\.assign\(cfg\.returnTo\)/);
  assert.match(html, /"returnTo":"https:\/\/shop\.test\/cart"/);
});
