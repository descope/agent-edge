import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Env } from "../src/config";
import { resetDiscoveryCache } from "../src/descope";
import worker from "../src/index";

const DISCOVERY = "https://api.descope.test/v1/apps/P123/.well-known/openid-configuration";
const ISSUER = "https://api.descope.test/P123";
const BC = "https://api.descope.test/oauth2/v1/apps/bc-authorize";
const TOKEN = "https://api.descope.test/oauth2/v1/apps/token";
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
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  tokenAnswers = [];
  resetDiscoveryCache();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === DISCOVERY) {
      return Response.json({ issuer: ISSUER, token_endpoint: TOKEN, backchannel_authentication_endpoint: BC });
    }
    const params = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ url, params });
    if (url === BC) return Response.json({ auth_req_id: "req-1", expires_in: 300, interval: 2 });
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

test("Descope's own error format is reported, not just the status code", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === BC) return Response.json({ errorCode: "E074130", errorDescription: "Invalid client id" }, { status: 400 });
    return real(input, init);
  }) as typeof fetch;
  const response = await connectJson({ email: "pat@example.com" });
  const body = (await response.json()) as { message: string };
  assert.match(body.message, /E074130/);
  assert.match(body.message, /Invalid client id/);
});
