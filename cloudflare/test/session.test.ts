import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, type Env } from "../src/config";
import type { JsonFetcher } from "../src/agentDetection";
import { invalidSessionResponse, verifySession } from "../src/session";

const env: Env = {
  DESCOPE_ISSUER: "https://api.descope.com/P123",
  RESOURCE_URL: "https://example.com/api",
  SITE_DOMAIN: "example.com",
};
const config = loadConfig(env);

const CLIENT_ID = "https://agent.example/agent.json";
const JWKS_URI = "https://agent.example/jwks.json";
const NOW = 1_790_900_000;
const URL_UNDER_TEST = "https://example.com/api/orders";

// --- key material, generated once for the whole file ------------------------------------

const encoder = new TextEncoder();

async function generateEc() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    privateKey: pair.privateKey,
    publicJwk: stripPrivate(await crypto.subtle.exportKey("jwk", pair.publicKey)),
  };
}

async function generateRsaPss() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-384" },
    true,
    ["sign", "verify"],
  );
  return {
    privateKey: pair.privateKey,
    publicJwk: stripPrivate(await crypto.subtle.exportKey("jwk", pair.publicKey)),
  };
}

function stripPrivate(jwk: JsonWebKey): Record<string, unknown> {
  const { d, p, q, dp, dq, qi, key_ops, ext, use, alg, ...rest } = jwk as Record<string, unknown>;
  return rest;
}

/** The key published in jwks_uri, which signs delegations. */
const signingKey = await generateEc();
/** The delegated key, which signs Session JWTs. It is never published. */
const delegatedKey = await generateEc();
/** A second jwks_uri key, to prove PS384 delegations are accepted (5.2). */
const ps384Key = await generateRsaPss();

const publishedKeys = [
  { ...signingKey.publicJwk, kid: "signing-1" },
  { ...ps384Key.publicJwk, kid: "ps384-1" },
];

// --- building JWTs ----------------------------------------------------------------------

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function jsonSegment(value: unknown): string {
  return b64url(encoder.encode(JSON.stringify(value)));
}

async function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: CryptoKey,
  alg: "ES256" | "PS384",
): Promise<string> {
  const signingInput = `${jsonSegment(header)}.${jsonSegment(claims)}`;
  const params = alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSA-PSS", saltLength: 48 };
  const signature = await crypto.subtle.sign(params, key, encoder.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

async function thumbprint(jwk: Record<string, unknown>): Promise<string> {
  const canonical = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(canonical)));
  return b64url(new Uint8Array(digest));
}

async function sha256(value: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

interface DelegationOverrides {
  typ?: string;
  alg?: "ES256" | "PS384";
  kid?: string;
  iss?: string;
  iat?: number;
  exp?: number;
  jwk?: Record<string, unknown>;
}

async function delegation(overrides: DelegationOverrides = {}): Promise<string> {
  const alg = overrides.alg ?? "ES256";
  const key = alg === "PS384" ? ps384Key.privateKey : signingKey.privateKey;
  return signJwt(
    {
      alg,
      typ: overrides.typ ?? "poppy-delegation+jwt",
      kid: overrides.kid ?? (alg === "PS384" ? "ps384-1" : "signing-1"),
    },
    {
      iss: overrides.iss ?? CLIENT_ID,
      cnf: { jwk: overrides.jwk ?? delegatedKey.publicJwk },
      iat: overrides.iat ?? NOW - 60,
      exp: overrides.exp ?? NOW + 3600,
      jti: "delegation-1",
    },
    key,
    alg,
  );
}

interface SessionOverrides {
  typ?: string;
  alg?: string;
  kid?: string;
  dlg?: string;
  claims?: Record<string, unknown>;
  omit?: string[];
  signWith?: CryptoKey;
}

async function sessionJwt(overrides: SessionOverrides = {}): Promise<string> {
  const claims: Record<string, unknown> = {
    iss: CLIENT_ID,
    aud: config.issuer,
    sid: "Yx2b7Qd_Kp8mR3vT1nWc4A",
    sub: "usr_Q7c1vK",
    htm: "GET",
    htu: "https://example.com/api/orders",
    iat: NOW,
    jti: "session-jwt-1",
    ...overrides.claims,
  };
  for (const name of overrides.omit ?? []) delete claims[name];
  return signJwt(
    {
      alg: overrides.alg ?? "ES256",
      typ: overrides.typ ?? "poppy-session+jwt",
      kid: overrides.kid ?? (await thumbprint(delegatedKey.publicJwk)),
      poppy_dlg: overrides.dlg ?? (await delegation()),
    },
    claims,
    overrides.signWith ?? delegatedKey.privateKey,
    "ES256",
  );
}

// --- the agent's documents --------------------------------------------------------------

function fetcher(options: { clientId?: string; jwksUri?: string; keys?: unknown[] } = {}): JsonFetcher {
  return async (url: string) => {
    if (url === CLIENT_ID) {
      return {
        client_id: options.clientId ?? CLIENT_ID,
        client_name: "Test Agent",
        jwks_uri: options.jwksUri ?? JWKS_URI,
      };
    }
    if (url === (options.jwksUri ?? JWKS_URI)) return { keys: options.keys ?? publishedKeys };
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function request(headers: Record<string, string>, method = "GET", url = URL_UNDER_TEST): Request {
  return new Request(url, { method, headers });
}

// --- tests ------------------------------------------------------------------------------

test("a well-formed Session JWT verifies and names the agent, user and session", async () => {
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt() }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "verified", result.reason);
  assert.equal(result.clientId, CLIENT_ID);
  assert.equal(result.sid, "Yx2b7Qd_Kp8mR3vT1nWc4A");
  assert.equal(result.userId, "usr_Q7c1vK");
  assert.equal(result.agentId, undefined);
});

test("no header is not a failure", async () => {
  const result = await verifySession(request({}), config, fetcher(), NOW);
  assert.equal(result.status, "none");
});

test("an optional agent_id is carried through", async () => {
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt({ claims: { agent_id: "shopping" } }) }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "verified", result.reason);
  assert.equal(result.agentId, "shopping");
});

// 5.2: typ exists so a JWT signed for one purpose cannot be spent as another.
test("a delegation cannot be presented as a Session JWT", async () => {
  const result = await verifySession(
    request({ "poppy-session": await delegation() }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /not poppy-session\+jwt/);
});

test("alg must be ES256", async () => {
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt({ alg: "none" }) }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /not ES256/);
});

test("the Session JWT must be signed by the delegated key", async () => {
  // Signed with the jwks key rather than the key the delegation vouches for.
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt({ signWith: signingKey.privateKey }) }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /signature does not verify/);
});

test("kid must be the delegated key's thumbprint", async () => {
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt({ kid: "not-a-thumbprint" }) }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /thumbprint/);
});

test("aud must be this Company's identifier", async () => {
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt({ claims: { aud: "https://someone-else.example" } }) }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /aud is not this Company's identifier/);
});

test("htm and htu must match the request", async () => {
  const jwt = await sessionJwt();
  const wrongMethod = await verifySession(request({ "poppy-session": jwt }, "POST"), config, fetcher(), NOW);
  assert.equal(wrongMethod.status, "invalid");
  assert.match(wrongMethod.reason, /htm/);

  const wrongPath = await verifySession(
    request({ "poppy-session": jwt }, "GET", "https://example.com/api/cart"),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(wrongPath.status, "invalid");
  assert.match(wrongPath.reason, /htu/);
});

// RFC 9449 section 4.3 compares htu without the query, so a query string must not break a
// JWT that is otherwise correct for the request.
test("a query string does not affect the htu comparison", async () => {
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt() }, "GET", `${URL_UNDER_TEST}?page=2`),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "verified", result.reason);
});

test("a stale iat is refused", async () => {
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt({ claims: { iat: NOW - 600 } }) }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /acceptance window/);
});

for (const claim of ["sid", "sub", "jti", "iat"]) {
  test(`${claim} is required`, async () => {
    const result = await verifySession(
      request({ "poppy-session": await sessionJwt({ omit: [claim] }) }),
      config,
      fetcher(),
      NOW,
    );
    assert.equal(result.status, "invalid");
    assert.match(result.reason, new RegExp(claim));
  });
}

// 5.3 step 3. Both directions matter: ath binds the header to the token, and its absence
// binds a signed-out request to having no token at all.
test("ath must match the access token when one is presented", async () => {
  const token = "an-access-token";
  const good = await verifySession(
    request({ "poppy-session": await sessionJwt({ claims: { ath: await sha256(token) } }), authorization: `Bearer ${token}` }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(good.status, "verified", good.reason);

  const mismatched = await verifySession(
    request({ "poppy-session": await sessionJwt({ claims: { ath: await sha256("a-different-token") } }), authorization: `Bearer ${token}` }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(mismatched.status, "invalid");
  assert.match(mismatched.reason, /ath does not match/);
});

test("a DPoP-bound token is hashed the same way", async () => {
  const token = "a-dpop-bound-token";
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt({ claims: { ath: await sha256(token) } }), authorization: `DPoP ${token}` }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "verified", result.reason);
});

test("a request with a token but no ath is refused", async () => {
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt(), authorization: "Bearer a-token" }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /no ath/);
});

test("a signed-out request carrying ath is refused", async () => {
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt({ claims: { ath: await sha256("a-token") } }) }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /no access token/);
});

// --- the delegation ---------------------------------------------------------------------

test("a PS384 delegation is accepted", async () => {
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt({ dlg: await delegation({ alg: "PS384" }) }) }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "verified", result.reason);
});

test("an expired delegation is refused", async () => {
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt({ dlg: await delegation({ iat: NOW - 7200, exp: NOW - 60 }) }) }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /expired/);
});

test("a delegation lasting more than 24 hours is refused", async () => {
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt({ dlg: await delegation({ iat: NOW, exp: NOW + 25 * 3600 }) }) }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /24 hours/);
});

test("a delegation signed by a key the agent does not publish is refused", async () => {
  const stranger = await generateEc();
  const forged = await signJwt(
    { alg: "ES256", typ: "poppy-delegation+jwt", kid: "signing-1" },
    { iss: CLIENT_ID, cnf: { jwk: delegatedKey.publicJwk }, iat: NOW - 60, exp: NOW + 3600, jti: "forged" },
    stranger.privateKey,
    "ES256",
  );
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt({ dlg: forged }) }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /delegation signature does not verify/);
});

test("a delegation naming an unpublished kid is refused", async () => {
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt({ dlg: await delegation({ kid: "not-published" }) }) }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /names no key/);
});

test("a delegation for another agent is refused", async () => {
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt({ dlg: await delegation({ iss: "https://other.example/agent.json" }) }) }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /does not match the Session JWT's iss/);
});

test("a delegation carrying private key material is refused", async () => {
  const leaked = { ...delegatedKey.publicJwk, d: "not-a-real-private-scalar" };
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt({ dlg: await delegation({ jwk: leaked }) }) }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /private key material/);
});

// --- the agent's documents --------------------------------------------------------------

// 4.1: a metadata document copied to another address must not speak for the agent.
test("client metadata whose client_id is not iss is refused", async () => {
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt() }),
    config,
    fetcher({ clientId: "https://somewhere-else.example/agent.json" }),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /client_id does not match iss/);
});

test("a jwks_uri on another host is refused", async () => {
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt() }),
    config,
    fetcher({ jwksUri: "https://keys.elsewhere.example/jwks.json" }),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /different host/);
});

test("a fetch failure is a refusal, not a crash", async () => {
  const result = await verifySession(
    request({ "poppy-session": await sessionJwt() }),
    config,
    async () => {
      throw new Error("network down");
    },
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /network down/);
});

test("a header that is not a JWT is a refusal, not a crash", async () => {
  const result = await verifySession(
    request({ "poppy-session": "not-a-jwt" }),
    config,
    fetcher(),
    NOW,
  );
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /not a JWT/);
});

// 5.3: "Session errors use 400 rather than 401 so that OAuth libraries, which treat a 401
// as a problem with the access token, don't discard a valid token."
test("a failed check answers 400 invalid_session, never 401", async () => {
  const response = invalidSessionResponse({ status: "invalid", reason: "iat is outside the acceptance window" });
  assert.equal(response.status, 400);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.error, "invalid_session");
  assert.equal(body.error_description, "iat is outside the acceptance window");
});
