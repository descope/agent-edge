import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, type Env } from "../src/config";
import type { JsonFetcher } from "../src/agentDetection";
import { handleJoin, isJoinPath, JOINED_COOKIE } from "../src/joinRoutes";
import { authorize, complete, JOIN_COOKIE, newJoin, type JoinRecord } from "../src/browserJoin";

const ISSUER = "https://api.descope.com/v1/apps/P123";
const RESOURCE = "https://example.com/api";
const JWKS_URI = "https://api.descope.com/P123/.well-known/jwks.json";
const CLIENT_ID = "https://agent.example/agent.json";
const AGENT_JWKS = "https://agent.example/jwks.json";
const JOIN_PATH = "/poppy/browser-session";
const BASE = "https://example.com";
/** The routes use the real clock, so the JWTs they verify have to as well. */
const NOW = Math.floor(Date.now() / 1000);

const encoder = new TextEncoder();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const segment = (value: unknown) => b64(encoder.encode(JSON.stringify(value)));

function stripPrivate(jwk: JsonWebKey): Record<string, unknown> {
  const { d, p, q, dp, dq, qi, key_ops, ext, use, alg, ...rest } = jwk as Record<string, unknown>;
  return rest;
}

const ec = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { privateKey: pair.privateKey, publicJwk: stripPrivate(await crypto.subtle.exportKey("jwk", pair.publicKey)) };
};

const issuerKey = await (async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  return { privateKey: pair.privateKey, publicJwk: { ...stripPrivate(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "issuer-1" } };
})();

const delegationKey = await ec();
const delegatedKey = await ec();

async function thumbprint(jwk: Record<string, unknown>): Promise<string> {
  const canonical = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(canonical)))));
}

async function signEs256(header: Record<string, unknown>, claims: Record<string, unknown>, key: CryptoKey) {
  const input = `${segment(header)}.${segment(claims)}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(input));
  return `${input}.${b64(new Uint8Array(sig))}`;
}

async function sessionHeader(method: string, urlPath: string, ath?: string): Promise<string> {
  const dlg = await signEs256(
    { alg: "ES256", typ: "poppy-delegation+jwt", kid: "agent-1" },
    { iss: CLIENT_ID, cnf: { jwk: delegatedKey.publicJwk }, iat: NOW - 60, exp: NOW + 3600, jti: "d1" },
    delegationKey.privateKey,
  );
  return signEs256(
    { alg: "ES256", typ: "poppy-session+jwt", kid: await thumbprint(delegatedKey.publicJwk), poppy_dlg: dlg },
    {
      iss: CLIENT_ID,
      aud: ISSUER,
      sid: "S1",
      sub: "usr_1",
      htm: method,
      htu: `${BASE}${urlPath}`,
      iat: NOW,
      jti: "s1",
      ...(ath === undefined ? {} : { ath }),
    },
    delegatedKey.privateKey,
  );
}

async function accessToken(scope: string): Promise<string> {
  const input = `${segment({ alg: "RS256", typ: "at+jwt", kid: "issuer-1" })}.${segment({
    iss: ISSUER, aud: RESOURCE, sub: "U1", scope, exp: NOW + 300, iat: NOW,
  })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", issuerKey.privateKey, encoder.encode(input));
  return `${input}.${b64(new Uint8Array(sig))}`;
}

const fetchJson: JsonFetcher = async (url: string) => {
  if (url === CLIENT_ID) return { client_id: CLIENT_ID, jwks_uri: AGENT_JWKS };
  if (url === AGENT_JWKS) return { keys: [{ ...delegationKey.publicJwk, kid: "agent-1" }] };
  if (url === `${ISSUER}/.well-known/oauth-authorization-server`) return { issuer: ISSUER, jwks_uri: JWKS_URI };
  if (url === JWKS_URI) return { keys: [issuerKey.publicJwk] };
  throw new Error(`unexpected fetch: ${url}`);
};

/** An in-memory stand-in for the Durable Object namespace, with the same semantics. */
function fakeNamespace(): DurableObjectNamespace {
  const records = new Map<string, JoinRecord>();
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: unknown) => ({
      fetch: async (input: string, init?: RequestInit) => {
        const code = id as string;
        const path = new URL(input).pathname;
        const body = JSON.parse(String(init?.body ?? "{}"));
        const now = Math.floor(Date.now() / 1000);
        if (path === "/start") {
          records.set(code, body as JoinRecord);
          return Response.json({ ok: true });
        }
        if (path === "/authorize") {
          const result = authorize(records.get(code), body, now);
          if (!result.ok) return Response.json(result, { status: 400 });
          records.set(code, result.record);
          return Response.json({ ok: true });
        }
        const outcome = await complete(records.get(code), body.secret, now);
        records.delete(code); // spent whatever the outcome
        return Response.json(outcome, { status: outcome.ok ? 200 : 400 });
      },
    }),
  } as unknown as DurableObjectNamespace;
}

const env: Env = {
  DESCOPE_ISSUER: ISSUER,
  RESOURCE_URL: RESOURCE,
  SITE_DOMAIN: "example.com",
  HINT_SIGNING_SECRET: "shared-with-the-origin",
  BROWSER_JOIN_PATH: JOIN_PATH,
  POPPY_JOIN: {} as DurableObjectNamespace,
};
const config = loadConfig(env);

function cookieFrom(response: Response, name: string): string | undefined {
  for (const value of response.headers.getSetCookie()) {
    if (value.startsWith(`${name}=`)) return value.slice(name.length + 1).split(";")[0] || undefined;
  }
  return undefined;
}

async function startJoin(ns: DurableObjectNamespace) {
  const response = await handleJoin(new Request(`${BASE}${JOIN_PATH}`), config, ns, fetchJson);
  const html = await response.clone().text();
  const code = /name="code" value="([^"]+)"/.exec(html)?.[1];
  return { response, html, code: code!, secret: cookieFrom(response, JOIN_COOKIE)! };
}

async function authorizeCode(ns: DurableObjectNamespace, code: string, scope?: string) {
  const path = `${JOIN_PATH}/authorize`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "poppy-session": await sessionHeader("POST", path, scope === undefined ? undefined : await (async () => {
      const token = await accessToken(scope);
      return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))));
    })()),
  };
  if (scope !== undefined) headers.authorization = `Bearer ${await accessToken(scope)}`;
  return handleJoin(
    new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify({ code }) }),
    config,
    ns,
    fetchJson,
  );
}

function completeJoin(ns: DurableObjectNamespace, code: string, secret?: string) {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (secret) headers.cookie = `${JOIN_COOKIE}=${secret}`;
  return handleJoin(
    new Request(`${BASE}${JOIN_PATH}`, { method: "POST", headers, body: `code=${encodeURIComponent(code)}` }),
    config,
    ns,
    fetchJson,
  );
}

// --- the happy path ---------------------------------------------------------------------

test("the three steps join a browser to a signed-in Session", async () => {
  const ns = fakeNamespace();
  const { response, code, secret } = await startJoin(ns);
  assert.equal(response.status, 200);
  assert.ok(code && secret);

  const authorized = await authorizeCode(ns, code, "poppy:browser-sign-in orders:read");
  assert.equal(authorized.status, 200, await authorized.clone().text());

  const completed = await completeJoin(ns, code, secret);
  assert.equal(completed.status, 200, await completed.clone().text());

  const joined = cookieFrom(completed, JOINED_COOKIE);
  assert.ok(joined, "a joined cookie is set");
  const payload = JSON.parse(Buffer.from(joined!.split(".")[0], "base64url").toString());
  assert.equal(payload.clientId, CLIENT_ID);
  assert.equal(payload.userId, "usr_1");
  assert.equal(payload.sid, "S1");
  assert.equal(payload.signedIn, true);
  assert.deepEqual(payload.scopes, ["poppy:browser-sign-in", "orders:read"]);
});

test("a signed-out join carries no scopes and says so", async () => {
  const ns = fakeNamespace();
  const { code, secret } = await startJoin(ns);
  assert.equal((await authorizeCode(ns, code)).status, 200);
  const completed = await completeJoin(ns, code, secret);
  assert.equal(completed.status, 200);
  const payload = JSON.parse(Buffer.from(cookieFrom(completed, JOINED_COOKIE)!.split(".")[0], "base64url").toString());
  assert.equal(payload.signedIn, false);
  assert.deepEqual(payload.scopes, []);
});

// The failure that is invisible in review and fatal in production.
test("the join page does not submit itself", async () => {
  const { html } = await startJoin(fakeNamespace());
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /onload|requestSubmit|\.submit\(\)/i);
  assert.match(html, /<form method="post"/);
});

test("the join cookie is host-locked and short-lived", async () => {
  const { response } = await startJoin(fakeNamespace());
  const header = response.headers.getSetCookie().find((value) => value.startsWith(JOIN_COOKIE));
  assert.ok(header);
  assert.match(header!, /Path=\/;/);
  assert.match(header!, /Secure/);
  assert.match(header!, /HttpOnly/);
  assert.match(header!, /SameSite=Strict/);
  // __Host- forbids Domain, which is what keeps this on the host that issued it.
  assert.doesNotMatch(header!, /Domain=/i);
});

// --- section 6's scope ------------------------------------------------------------------

test("a signed-in join without poppy:browser-sign-in is refused with insufficient_scope", async () => {
  const ns = fakeNamespace();
  const { code } = await startJoin(ns);
  const response = await authorizeCode(ns, code, "orders:read");
  assert.equal(response.status, 403);
  assert.match(response.headers.get("www-authenticate") ?? "", /insufficient_scope/);
  assert.match(response.headers.get("www-authenticate") ?? "", /poppy:browser-sign-in/);
});

test("step 2 needs a verified Session JWT", async () => {
  const ns = fakeNamespace();
  const { code } = await startJoin(ns);
  const response = await handleJoin(
    new Request(`${BASE}${JOIN_PATH}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    }),
    config,
    ns,
    fetchJson,
  );
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as Record<string, unknown>).error, "invalid_session");
});

// --- forgery and replay -----------------------------------------------------------------

// Section 10.6: the code alone must not be enough, or a code read from a log joins someone
// else's browser to the agent's Session.
test("a code without its cookie is refused", async () => {
  const ns = fakeNamespace();
  const { code } = await startJoin(ns);
  await authorizeCode(ns, code, "poppy:browser-sign-in");
  const response = await completeJoin(ns, code);
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /no join cookie/);
});

test("a code with another browser's cookie is refused", async () => {
  const ns = fakeNamespace();
  const mine = await startJoin(ns);
  const theirs = await startJoin(ns);
  await authorizeCode(ns, mine.code, "poppy:browser-sign-in");
  const response = await completeJoin(ns, mine.code, theirs.secret);
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /does not match/);
});

/**
 * The rule that makes the self-submitting form fatal, and the reason it is tested here
 * rather than left to review: a completion that failed must not leave the code live.
 */
test("a code is spent by the first completion, even a failed one", async () => {
  const ns = fakeNamespace();
  const { code, secret } = await startJoin(ns);

  // The browser posts too early, before the agent has authorized anything.
  const early = await completeJoin(ns, code, secret);
  assert.equal(early.status, 400);
  assert.match(JSON.stringify(await early.json()), /never authorized/);

  // The agent now authorizes it, and the browser tries again. The code is gone.
  const authorized = await authorizeCode(ns, code, "poppy:browser-sign-in");
  assert.equal(authorized.status, 400, "authorizing a spent code fails");
  const retry = await completeJoin(ns, code, secret);
  assert.equal(retry.status, 400);
  assert.match(JSON.stringify(await retry.json()), /unknown or already used/);
});

test("a code cannot be authorized twice", async () => {
  const ns = fakeNamespace();
  const { code } = await startJoin(ns);
  assert.equal((await authorizeCode(ns, code, "poppy:browser-sign-in")).status, 200);
  const second = await authorizeCode(ns, code, "poppy:browser-sign-in");
  assert.equal(second.status, 400);
  assert.match(JSON.stringify(await second.json()), /already authorized/);
});

// --- the state machine on its own --------------------------------------------------------

test("an expired code is refused at both steps", async () => {
  const join = newJoin(NOW);
  const record = await join.record;
  const later = NOW + 120;
  assert.equal(authorize(record, { clientId: "c", userId: "u", sid: "s", scopes: [], signedIn: false }, later).ok, false);
  assert.equal((await complete(record, join.secret, later)).ok, false);
});

test("the record never holds the secret itself", async () => {
  const join = newJoin(NOW);
  const record = await join.record;
  assert.notEqual(record.secretHash, join.secret);
  assert.doesNotMatch(JSON.stringify(record), new RegExp(join.secret.slice(0, 16)));
});

// --- wiring -----------------------------------------------------------------------------

test("the join is off until it can actually work", () => {
  assert.equal(isJoinPath(JOIN_PATH, config), true);
  assert.equal(isJoinPath(`${JOIN_PATH}/authorize`, config), true);
  assert.equal(isJoinPath("/something-else", config), false);

  const noBinding = loadConfig({ ...env, POPPY_JOIN: undefined });
  assert.equal(noBinding.browserJoinPath, undefined);
  const noSecret = loadConfig({ ...env, HINT_SIGNING_SECRET: undefined });
  assert.equal(noSecret.browserJoinPath, undefined);
  const noPath = loadConfig({ ...env, BROWSER_JOIN_PATH: undefined });
  assert.equal(noPath.browserJoinPath, undefined);
});
