import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, type Env } from "../src/config";
import type { JsonFetcher } from "../src/agentDetection";
import { validateAccessToken } from "../src/accessToken";
import { withResourceMetadata, withScope } from "../src/challenge";

const ISSUER = "https://api.descope.com/v1/apps/P123";
const RESOURCE = "https://example.com/api";
const JWKS_URI = "https://api.descope.com/P123/.well-known/jwks.json";
const NOW = 1_790_900_000;
const REQUEST_URL = "https://example.com/api/orders";

const env: Env = {
  DESCOPE_ISSUER: ISSUER,
  RESOURCE_URL: RESOURCE,
  SCOPES_SUPPORTED: "orders:read,orders:write",
};
const config = loadConfig(env);

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function segment(value: unknown): string {
  return b64url(encoder.encode(JSON.stringify(value)));
}

function stripPrivate(jwk: JsonWebKey): Record<string, unknown> {
  const { d, p, q, dp, dq, qi, key_ops, ext, use, alg, ...rest } = jwk as Record<string, unknown>;
  return rest;
}

/** The issuer's signing key. Descope signs access tokens RS256. */
const issuerKey = await (async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  return { privateKey: pair.privateKey, publicJwk: { ...stripPrivate(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "issuer-1" } };
})();

/** The agent's DPoP key. */
const dpopKey = await (async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { privateKey: pair.privateKey, publicJwk: stripPrivate(await crypto.subtle.exportKey("jwk", pair.publicKey)) };
})();

async function thumbprint(jwk: Record<string, unknown>): Promise<string> {
  const canonical = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(canonical)))));
}

async function accessToken(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): Promise<string> {
  const payload = {
    iss: ISSUER,
    aud: RESOURCE,
    sub: "U2abc",
    scope: "orders:read",
    client_id: "https://muse.ai/poppy/agent.json",
    exp: NOW + 300,
    iat: NOW,
    ...claims,
  };
  const signingInput = `${segment({ alg: "RS256", typ: "at+jwt", kid: "issuer-1", ...header })}.${segment(payload)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", issuerKey.privateKey, encoder.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

async function dpopProof(token: string, claims: Record<string, unknown> = {}, jwk = dpopKey.publicJwk): Promise<string> {
  const payload = {
    htm: "GET",
    htu: REQUEST_URL,
    iat: NOW,
    jti: "proof-1",
    ath: b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token)))),
    ...claims,
  };
  const signingInput = `${segment({ alg: "ES256", typ: "dpop+jwt", jwk })}.${segment(payload)}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, dpopKey.privateKey, encoder.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

function fetcher(options: { issuer?: string; keys?: unknown[] } = {}): JsonFetcher {
  return async (url: string) => {
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return { issuer: options.issuer ?? ISSUER, jwks_uri: JWKS_URI };
    }
    if (url === JWKS_URI) return { keys: options.keys ?? [issuerKey.publicJwk] };
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function request(headers: Record<string, string> = {}, url = REQUEST_URL, method = "GET"): Request {
  return new Request(url, { method, headers });
}

// --- the token --------------------------------------------------------------------------

test("a valid token yields its subject and scopes", async () => {
  const result = await validateAccessToken(
    request({ authorization: `Bearer ${await accessToken()}` }),
    { issuer: ISSUER, resource: RESOURCE },
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "valid", result.reason);
  assert.equal(result.subject, "U2abc");
  assert.deepEqual(result.scopes, ["orders:read"]);
  assert.equal(result.clientId, "https://muse.ai/poppy/agent.json");
});

test("no Authorization header is not a failure", async () => {
  const result = await validateAccessToken(request(), config, fetcher(), NOW);
  assert.equal(result.status, "none");
});

test("a token signed by another key is refused", async () => {
  const stranger = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = { ...stripPrivate(await crypto.subtle.exportKey("jwk", stranger.publicKey)), kid: "issuer-1" };
  const result = await validateAccessToken(
    request({ authorization: `Bearer ${await accessToken()}` }),
    { issuer: ISSUER, resource: RESOURCE },
    fetcher({ keys: [publicJwk] }),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /signature does not verify/);
});

test("a token from another issuer is refused", async () => {
  const result = await validateAccessToken(
    request({ authorization: `Bearer ${await accessToken({ iss: "https://evil.example" })}` }),
    { issuer: ISSUER, resource: RESOURCE },
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /iss is not this site's issuer/);
});

test("a token for another resource is refused", async () => {
  const result = await validateAccessToken(
    request({ authorization: `Bearer ${await accessToken({ aud: "https://other.example/api" })}` }),
    { issuer: ISSUER, resource: RESOURCE },
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /aud does not include/);
});

// RFC 9068 allows either shape, and an agent signed in for several resources gets an array.
test("aud may be an array containing the resource", async () => {
  const result = await validateAccessToken(
    request({ authorization: `Bearer ${await accessToken({ aud: ["https://other.example", RESOURCE] })}` }),
    { issuer: ISSUER, resource: RESOURCE },
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "valid", result.reason);
});

test("an expired token is refused", async () => {
  const result = await validateAccessToken(
    request({ authorization: `Bearer ${await accessToken({ exp: NOW - 1 })}` }),
    { issuer: ISSUER, resource: RESOURCE },
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /expired/);
});

test("issuer metadata naming a different issuer is refused", async () => {
  const result = await validateAccessToken(
    request({ authorization: `Bearer ${await accessToken()}` }),
    { issuer: ISSUER, resource: RESOURCE },
    fetcher({ issuer: "https://somewhere-else.example" }),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /different issuer/);
});

test("a token whose kid names no published key is refused", async () => {
  const result = await validateAccessToken(
    request({ authorization: `Bearer ${await accessToken({}, { kid: "rotated-away" })}` }),
    { issuer: ISSUER, resource: RESOURCE },
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /no key in the issuer's JWKS/);
});

test("an unsupported alg is refused rather than guessed at", async () => {
  const result = await validateAccessToken(
    request({ authorization: `Bearer ${await accessToken({}, { alg: "none" })}` }),
    { issuer: ISSUER, resource: RESOURCE },
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /unsupported alg/);
});

// --- DPoP binding -----------------------------------------------------------------------

test("a DPoP-bound token with a good proof is valid", async () => {
  const token = await accessToken({ cnf: { jkt: await thumbprint(dpopKey.publicJwk) } });
  const result = await validateAccessToken(
    request({ authorization: `DPoP ${token}`, dpop: await dpopProof(token) }),
    { issuer: ISSUER, resource: RESOURCE },
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "valid", result.reason);
  assert.equal(result.subject, "U2abc");
});

// The binding is the whole point: a bound token accepted without its proof is a bearer
// token with extra steps, and a stolen one would work.
test("a DPoP-bound token with no proof is refused", async () => {
  const token = await accessToken({ cnf: { jkt: await thumbprint(dpopKey.publicJwk) } });
  const result = await validateAccessToken(
    request({ authorization: `DPoP ${token}` }),
    { issuer: ISSUER, resource: RESOURCE },
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /carries no proof/);
});

test("a proof signed by a key the token does not name is refused", async () => {
  const otherKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const otherJwk = stripPrivate(await crypto.subtle.exportKey("jwk", otherKey.publicKey));
  const token = await accessToken({ cnf: { jkt: await thumbprint(otherJwk) } });
  const result = await validateAccessToken(
    request({ authorization: `DPoP ${token}`, dpop: await dpopProof(token) }),
    { issuer: ISSUER, resource: RESOURCE },
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /does not match the token's cnf.jkt/);
});

test("a proof for a different method or URL is refused", async () => {
  const token = await accessToken({ cnf: { jkt: await thumbprint(dpopKey.publicJwk) } });
  const wrongMethod = await validateAccessToken(
    request({ authorization: `DPoP ${token}`, dpop: await dpopProof(token, { htm: "POST" }) }),
    { issuer: ISSUER, resource: RESOURCE },
    fetcher(),
    NOW,
  );
  assert.equal(wrongMethod.status, "invalid");
  assert.match(wrongMethod.reason, /htm does not match/);

  const wrongUrl = await validateAccessToken(
    request({ authorization: `DPoP ${token}`, dpop: await dpopProof(token, { htu: "https://example.com/api/cart" }) }),
    { issuer: ISSUER, resource: RESOURCE },
    fetcher(),
    NOW,
  );
  assert.equal(wrongUrl.status, "invalid");
  assert.match(wrongUrl.reason, /htu does not match/);
});

test("a proof whose ath is for another token is refused", async () => {
  const token = await accessToken({ cnf: { jkt: await thumbprint(dpopKey.publicJwk) } });
  const result = await validateAccessToken(
    request({ authorization: `DPoP ${token}`, dpop: await dpopProof(token, { ath: "not-the-right-hash" }) }),
    { issuer: ISSUER, resource: RESOURCE },
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /ath does not match/);
});

test("a stale proof is refused", async () => {
  const token = await accessToken({ cnf: { jkt: await thumbprint(dpopKey.publicJwk) } });
  const result = await validateAccessToken(
    request({ authorization: `DPoP ${token}`, dpop: await dpopProof(token, { iat: NOW - 600 }) }),
    { issuer: ISSUER, resource: RESOURCE },
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /outside the window/);
});

test("a proof carrying private key material is refused", async () => {
  const token = await accessToken({ cnf: { jkt: await thumbprint(dpopKey.publicJwk) } });
  const leaky = { ...dpopKey.publicJwk, d: "not-a-real-scalar" };
  const result = await validateAccessToken(
    request({ authorization: `DPoP ${token}`, dpop: await dpopProof(token, {}, leaky) }),
    { issuer: ISSUER, resource: RESOURCE },
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /private key material/);
});

test("a fetch failure is a refusal, not a crash", async () => {
  const result = await validateAccessToken(
    request({ authorization: `Bearer ${await accessToken()}` }),
    { issuer: ISSUER, resource: RESOURCE },
    async () => {
      throw new Error("jwks unreachable");
    },
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /jwks unreachable/);
});

// --- the challenge ----------------------------------------------------------------------

// Poppy section 7: a refusal names the scopes, so the agent knows what to go and ask for.
test("a challenge with no scope gains the resource's scopes", () => {
  const challenge = withScope('Bearer resource_metadata="https://example.com/.well-known/x"', [
    "orders:read",
    "orders:write",
  ]);
  assert.match(challenge, /scope="orders:read orders:write"/);
});

// The origin knows which scope *this* operation needs; the configured list is only the
// resource's whole vocabulary, so a narrower answer must win.
test("a challenge that already names a scope is left alone", () => {
  const existing = 'Bearer error="insufficient_scope", scope="orders:write"';
  assert.equal(withScope(existing, ["orders:read", "orders:write"]), existing);
});

test("with no configured scopes the challenge is unchanged", () => {
  const existing = "Bearer";
  assert.equal(withScope(existing, []), existing);
});

test("resource metadata and scope compose", () => {
  const challenge = withScope(withResourceMetadata(null, "https://example.com/.well-known/x"), ["orders:read"]);
  assert.match(challenge, /^Bearer resource_metadata="https:\/\/example\.com\/\.well-known\/x", scope="orders:read"$/);
});
