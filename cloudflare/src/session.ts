import type { Config } from "./config";
import type { JsonFetcher } from "./agentDetection";

/**
 * Poppy Session header verification (spec 5.2, 5.3).
 *
 * Web Bot Auth answers "which operator sent this". The Session header answers a different
 * question the worker could not answer before: which Personal Agent, acting for which User,
 * in which Session. Those are different identifiers with different trust — an operator
 * signature authenticates its key source, "not an arbitrary `client_id` named in the
 * request" (5.3), so neither substitutes for the other.
 *
 * The User ID here is NOT the subject of an access token. The Personal Agent assigns it,
 * pairwise per Company (5.1), and 5.3 looks a Session up by `client_id`, `sid` and that User
 * ID. So session continuity exists only inside this header and cannot be derived from a
 * token.
 */

/**
 * A JWK as it arrives on the wire. Deliberately not lib.dom's `JsonWebKey`, which has no
 * index signature, so reading `kid` or `crv` off one needs a cast at every use.
 */
type Jwk = Record<string, unknown>;

export type SessionStatus = "verified" | "invalid" | "none";

export interface SessionResult {
  status: SessionStatus;
  /** The Personal Agent's client_id (`iss`). Only set when the JWT verified. */
  clientId?: string;
  /** The Session ID. Only set when the JWT verified. */
  sid?: string;
  /** The User ID this Company sees for this person (`sub`). Only set when the JWT verified. */
  userId?: string;
  /** The optional Agent ID (5.1). */
  agentId?: string;
  reason: string;
}

const NO_SESSION: SessionResult = { status: "none", reason: "no Session header" };

/** 5.3 suggests "an acceptance window it chooses, such as one minute". */
const DEFAULT_SKEW_SECONDS = 60;

/** 5.2: a delegation's `exp` is at most 24 hours after its `iat`. */
const MAX_DELEGATION_LIFETIME_SECONDS = 24 * 60 * 60;

/**
 * Verifies the `poppy-session` header against the request.
 *
 * `fetchJson` MUST NOT follow redirects — the CIMD draft requires client metadata to be
 * fetched from `iss` directly (5.3 step 1), and `cachedJsonFetcher` passes
 * `redirect: "manual"` for exactly this reason.
 *
 * Never throws: a malformed header is a refusal with a reason, the same shape
 * `detectAgent` uses, so one bad header cannot take the site down.
 */
export async function verifySession(
  request: Request,
  config: Config,
  fetchJson: JsonFetcher,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SessionResult> {
  const header = request.headers.get("poppy-session");
  if (!header) return NO_SESSION;

  try {
    return await verify(request, config, fetchJson, header, now);
  } catch (error) {
    return invalid(`verification error: ${String(error)}`);
  }
}

async function verify(
  request: Request,
  config: Config,
  fetchJson: JsonFetcher,
  token: string,
  now: number,
): Promise<SessionResult> {
  const jwt = parseJwt(token);
  if (!jwt) return invalid("Session header is not a JWT");

  // 5.2: typ keeps this from being mistaken for a client assertion or a delegation, and
  // alg is fixed so every agent and Company interoperate.
  if (jwt.header.typ !== "poppy-session+jwt") {
    return invalid(`typ is ${String(jwt.header.typ)}, not poppy-session+jwt`);
  }
  if (jwt.header.alg !== "ES256") return invalid(`alg is ${String(jwt.header.alg)}, not ES256`);

  const clientId = asString(jwt.claims.iss);
  if (!clientId) return invalid("iss is missing");

  const delegationToken = asString(jwt.header.poppy_dlg);
  if (!delegationToken) return invalid("header carries no poppy_dlg delegation");

  // 5.3 step 1: the agent's own metadata, then the keys it names.
  const keys = await agentKeys(clientId, fetchJson);
  if ("reason" in keys) return invalid(keys.reason);

  // 5.3 step 2, first half: the delegation vouches for the key that signed the Session JWT.
  const delegated = await verifyDelegation(delegationToken, clientId, keys.keys, now);
  if ("reason" in delegated) return invalid(delegated.reason);

  // The Session JWT's kid names the delegated key by its thumbprint (5.2).
  const thumbprint = await jwkThumbprint(delegated.jwk);
  if (asString(jwt.header.kid) !== thumbprint) {
    return invalid("kid does not match the delegated key's thumbprint");
  }

  if (!(await verifySignature(jwt, delegated.jwk, "ES256"))) {
    return invalid("signature does not verify against the delegated key");
  }

  // 5.3 step 2, second half.
  const identifier = companyIdentifier(config);
  if (asString(jwt.claims.aud) !== identifier) {
    return invalid(`aud is not this Company's identifier (${identifier})`);
  }

  const url = new URL(request.url);
  if (asString(jwt.claims.htm) !== request.method) {
    return invalid(`htm is ${String(jwt.claims.htm)}, not ${request.method}`);
  }
  // RFC 9449 section 4.3: compare without query or fragment.
  if (asString(jwt.claims.htu) !== `${url.origin}${url.pathname}`) {
    return invalid("htu does not match the request URL");
  }

  const iat = asNumber(jwt.claims.iat);
  if (iat === undefined) return invalid("iat is missing");
  if (Math.abs(now - iat) > DEFAULT_SKEW_SECONDS) {
    return invalid("iat is outside the acceptance window");
  }

  if (!asString(jwt.claims.sid)) return invalid("sid is missing");
  if (!asString(jwt.claims.sub)) return invalid("sub is missing");
  if (!asString(jwt.claims.jti)) return invalid("jti is missing");

  // 5.3 step 3. `ath` ties the header to the access token, and its absence is just as
  // load-bearing: a signed-out request MUST NOT carry one, so a Session JWT signed for a
  // request that had a token cannot be replayed onto one that does not.
  const ath = asString(jwt.claims.ath);
  const presented = bearerToken(request);
  if (presented) {
    if (!ath) return invalid("request carries an access token but the JWT has no ath");
    if (ath !== (await sha256Base64url(presented))) return invalid("ath does not match the access token");
  } else if (ath) {
    return invalid("JWT carries ath but the request has no access token");
  }

  const agentId = asString(jwt.claims.agent_id);
  return {
    status: "verified",
    clientId,
    sid: asString(jwt.claims.sid)!,
    userId: asString(jwt.claims.sub)!,
    ...(agentId === undefined ? {} : { agentId }),
    reason: "Session JWT verified",
  };
}

/**
 * A failed check is HTTP 400, not 401 — 5.3 is explicit that "Session errors use 400 rather
 * than 401 so that OAuth libraries, which treat a 401 as a problem with the access token,
 * don't discard a valid token."
 */
export function invalidSessionResponse(result: SessionResult): Response {
  return Response.json(
    { error: "invalid_session", error_description: result.reason },
    { status: 400, headers: { "cache-control": "no-store" } },
  );
}

// --- the agent's keys -------------------------------------------------------------------

interface AgentKeys {
  keys: Jwk[];
}

async function agentKeys(clientId: string, fetchJson: JsonFetcher): Promise<AgentKeys | Refusal> {
  let metadataUrl: URL;
  try {
    metadataUrl = new URL(clientId);
  } catch {
    return { reason: "iss is not a URL" };
  }
  if (metadataUrl.protocol !== "https:") return { reason: "iss is not HTTPS" };

  const metadata = await fetchJson(metadataUrl.toString());
  if (!isRecord(metadata)) return { reason: "client metadata is not an object" };

  // 4.1: the document's own client_id must be the URL it was fetched from, so a document
  // copied elsewhere cannot speak for this agent.
  if (asString(metadata.client_id) !== clientId) {
    return { reason: "client metadata's client_id does not match iss" };
  }

  const jwksUri = asString(metadata.jwks_uri);
  if (!jwksUri) return { reason: "client metadata has no jwks_uri" };

  let jwks: URL;
  try {
    jwks = new URL(jwksUri);
  } catch {
    return { reason: "jwks_uri is not a URL" };
  }
  // 4.1: "jwks_uri MUST be an HTTPS URL on the same domain as client_id."
  if (jwks.protocol !== "https:") return { reason: "jwks_uri is not HTTPS" };
  if (jwks.hostname.toLowerCase() !== metadataUrl.hostname.toLowerCase()) {
    return { reason: "jwks_uri is on a different host from client_id" };
  }

  const keySet = await fetchJson(jwks.toString());
  if (!isRecord(keySet) || !Array.isArray(keySet.keys)) {
    return { reason: "jwks_uri did not return a key set" };
  }
  return { keys: keySet.keys.filter(isRecord) };
}

// --- the delegation ---------------------------------------------------------------------

interface Delegated {
  jwk: Jwk;
}

async function verifyDelegation(
  token: string,
  clientId: string,
  keys: Jwk[],
  now: number,
): Promise<Delegated | Refusal> {
  const jwt = parseJwt(token);
  if (!jwt) return { reason: "poppy_dlg is not a JWT" };

  if (jwt.header.typ !== "poppy-delegation+jwt") {
    return { reason: `delegation typ is ${String(jwt.header.typ)}, not poppy-delegation+jwt` };
  }
  // 5.2: "Companies MUST accept delegations signed with ES256 and with PS384." PS384 is
  // what lets an agent have its delegations signed blindly (10.7), so refusing it would
  // quietly shut out the more private implementations.
  const alg = asString(jwt.header.alg);
  if (alg !== "ES256" && alg !== "PS384") {
    return { reason: `delegation alg is ${String(alg)}, not ES256 or PS384` };
  }

  if (asString(jwt.claims.iss) !== clientId) {
    return { reason: "delegation iss does not match the Session JWT's iss" };
  }

  const kid = asString(jwt.header.kid);
  if (!kid) return { reason: "delegation has no kid" };
  const signing = keys.find((key) => key.kid === kid);
  if (!signing) return { reason: "delegation kid names no key in jwks_uri" };

  if (!(await verifySignature(jwt, signing, alg))) {
    return { reason: "delegation signature does not verify" };
  }

  const iat = asNumber(jwt.claims.iat);
  const exp = asNumber(jwt.claims.exp);
  if (iat === undefined || exp === undefined) return { reason: "delegation has no iat or exp" };
  if (exp <= now) return { reason: "delegation has expired" };
  if (exp - iat > MAX_DELEGATION_LIFETIME_SECONDS) {
    return { reason: "delegation lasts longer than 24 hours" };
  }

  const cnf = isRecord(jwt.claims.cnf) ? jwt.claims.cnf : undefined;
  const jwk = cnf && isRecord(cnf.jwk) ? cnf.jwk : undefined;
  if (!jwk) return { reason: "delegation has no cnf.jwk" };
  // 5.2: the delegated public key. A private member here would mean the agent leaked its
  // own key material, and nothing good follows from accepting it.
  for (const member of ["d", "p", "q", "dp", "dq", "qi", "k"]) {
    if (member in jwk) {
      return { reason: "delegation cnf.jwk carries private key material" };
    }
  }
  return { jwk };
}

// --- JWT and crypto ---------------------------------------------------------------------

interface ParsedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
}

interface Refusal {
  reason: string;
}

function parseJwt(token: string): ParsedJwt | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [headerPart, claimsPart, signaturePart] = parts;
  try {
    const header = JSON.parse(decodeText(headerPart));
    const claims = JSON.parse(decodeText(claimsPart));
    if (!isRecord(header) || !isRecord(claims)) return undefined;
    return {
      header,
      claims,
      signingInput: `${headerPart}.${claimsPart}`,
      signature: base64urlToBytes(signaturePart),
    };
  } catch {
    return undefined;
  }
}

async function verifySignature(jwt: ParsedJwt, jwk: Jwk, alg: "ES256" | "PS384"): Promise<boolean> {
  const algorithm = alg === "ES256"
    ? { name: "ECDSA", namedCurve: "P-256" }
    : { name: "RSA-PSS", hash: "SHA-384" };
  const verifyParams = alg === "ES256"
    ? { name: "ECDSA", hash: "SHA-256" }
    : { name: "RSA-PSS", saltLength: 48 };
  try {
    // `key_ops`/`use` on a published JWK can disagree with what we need; importing a copy
    // without them avoids a spurious failure on an otherwise valid key.
    const { key_ops, use, alg: _alg, ...material } = jwk;
    const key = await crypto.subtle.importKey("jwk", material as unknown as JsonWebKey, algorithm, false, ["verify"]);
    return await crypto.subtle.verify(
      verifyParams,
      key,
      jwt.signature as BufferSource,
      new TextEncoder().encode(jwt.signingInput) as BufferSource,
    );
  } catch {
    return false;
  }
}

/** RFC 7638 JWK thumbprint. Only the members the spec's key types use, in lexical order. */
async function jwkThumbprint(jwk: Jwk): Promise<string> {
  const canonical = jwk.kty === "EC"
    ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
    : { e: jwk.e, kty: jwk.kty, n: jwk.n };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical)) as BufferSource);
  return bytesToBase64url(new Uint8Array(digest));
}

async function sha256Base64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value) as BufferSource);
  return bytesToBase64url(new Uint8Array(digest));
}

/** The access token the request presents, under either the Bearer or the DPoP scheme. */
function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (!header) return undefined;
  const match = /^(?:Bearer|DPoP)\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * The Company's identifier (3.2): its issuer when it has one, otherwise
 * `https://{organization.domain}` lowercased with no trailing slash.
 */
function companyIdentifier(config: Config): string {
  if (config.issuer) return config.issuer;
  return `https://${config.siteDomain.toLowerCase()}`;
}

// --- small helpers ----------------------------------------------------------------------

function invalid(reason: string): SessionResult {
  return { status: "invalid", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function base64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeText(value: string): string {
  return new TextDecoder().decode(base64urlToBytes(value) as BufferSource);
}
