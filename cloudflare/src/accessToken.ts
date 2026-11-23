import {
  asNumber,
  asString,
  isAlg,
  isRecord,
  jwkThumbprint,
  parseJwt,
  presentedToken,
  sha256Base64url,
  verifyJwtSignature,
  type JsonFetcher,
  type Jwk,
} from "./jwt";

/** What validation needs to know about the site: who issues tokens, and what they are for. */
export interface TokenAudience {
  issuer: string;
  resource: string;
}

/**
 * Access token validation at the edge.
 *
 * Until now the worker decorated a 401 the origin produced. It could not produce one,
 * which means it could not tell a forged token from a valid one, and could not answer a
 * request itself — so section 7's challenges, and anything that needs to know who is
 * calling before the origin does, were out of reach.
 *
 * The origin still validates. This does not replace that, and must not: an edge that says
 * "trust me, I checked" is only as good as the path between it and the origin.
 */

export type TokenStatus = "valid" | "invalid" | "none";

export interface TokenResult {
  status: TokenStatus;
  /** The token's subject. Only set when the token verified. */
  subject?: string;
  /** The scopes the token carries. Only set when the token verified. */
  scopes?: string[];
  /** The client the token was issued to, when it names one. */
  clientId?: string;
  /** The subject's email, when the token carries one. What CIBA needs as a login_hint. */
  email?: string;
  reason: string;
}

const NO_TOKEN: TokenResult = { status: "none", reason: "no access token" };

/** RFC 9449 section 11.1 suggests a short window for a proof's `iat`. */
const PROOF_WINDOW_SECONDS = 60;

/**
 * Verifies the access token a request presents against the configured issuer and resource.
 *
 * A DPoP-bound token is only ever reported valid with a proof that verifies. Binding that
 * the worker does not check is binding the worker cannot claim — and an unverified
 * identity passed to the origin is worse than no identity at all, because it looks
 * trustworthy.
 *
 * Never throws: a bad token is a refusal with a reason.
 */
export async function validateAccessToken(
  request: Request,
  audience: TokenAudience,
  fetchJson: JsonFetcher,
  now: number = Math.floor(Date.now() / 1000),
): Promise<TokenResult> {
  const presented = presentedToken(request);
  if (!presented) return NO_TOKEN;

  try {
    return await validate(request, audience, fetchJson, presented.token, now);
  } catch (error) {
    return invalid(`validation error: ${String(error)}`);
  }
}

async function validate(
  request: Request,
  audience: TokenAudience,
  fetchJson: JsonFetcher,
  token: string,
  now: number,
): Promise<TokenResult> {
  const jwt = parseJwt(token);
  if (!jwt) return invalid("access token is not a JWT");

  const alg = jwt.header.alg;
  if (!isAlg(alg)) return invalid(`unsupported alg ${String(alg)}`);

  const key = await issuerKey(audience, fetchJson, asString(jwt.header.kid));
  if ("reason" in key) return invalid(key.reason);

  if (!(await verifyJwtSignature(jwt, key.jwk, alg))) {
    return invalid("signature does not verify against the issuer's keys");
  }

  if (asString(jwt.claims.iss) !== audience.issuer) {
    return invalid("iss is not this site's issuer");
  }

  // RFC 9068: aud is the resource the token is for, and may be a string or an array.
  const audiences = Array.isArray(jwt.claims.aud)
    ? jwt.claims.aud.filter((value): value is string => typeof value === "string")
    : [asString(jwt.claims.aud)].filter((value): value is string => value !== undefined);
  if (!audiences.includes(audience.resource)) {
    return invalid(`aud does not include ${audience.resource}`);
  }

  const exp = asNumber(jwt.claims.exp);
  if (exp === undefined) return invalid("exp is missing");
  if (exp <= now) return invalid("token has expired");
  const nbf = asNumber(jwt.claims.nbf);
  if (nbf !== undefined && nbf > now) return invalid("token is not valid yet");

  // RFC 9449 section 6.1: a bound token names its key's thumbprint in cnf.jkt. The binding
  // is only worth anything if the proof is checked, so a bound token without one is refused
  // rather than quietly treated as a bearer token.
  const cnf = isRecord(jwt.claims.cnf) ? jwt.claims.cnf : undefined;
  const jkt = cnf ? asString(cnf.jkt) : undefined;
  if (jkt) {
    const proof = await verifyDpopProof(request, token, jkt, now);
    if (proof) return invalid(proof.reason);
  }

  const scope = asString(jwt.claims.scope);
  return {
    status: "valid",
    subject: asString(jwt.claims.sub),
    scopes: scope ? scope.split(" ").filter(Boolean) : [],
    ...(asString(jwt.claims.client_id) === undefined ? {} : { clientId: asString(jwt.claims.client_id)! }),
    ...(asString(jwt.claims.email) === undefined ? {} : { email: asString(jwt.claims.email)! }),
    reason: "access token verified",
  };
}

/** Returns a refusal, or undefined when the proof is good. */
async function verifyDpopProof(
  request: Request,
  token: string,
  jkt: string,
  now: number,
): Promise<{ reason: string } | undefined> {
  const header = request.headers.get("dpop");
  if (!header) return { reason: "token is DPoP-bound but the request carries no proof" };

  const proof = parseJwt(header);
  if (!proof) return { reason: "DPoP proof is not a JWT" };
  if (proof.header.typ !== "dpop+jwt") return { reason: "DPoP proof typ is not dpop+jwt" };

  const alg = proof.header.alg;
  if (!isAlg(alg)) return { reason: `DPoP proof uses unsupported alg ${String(alg)}` };

  const jwk = isRecord(proof.header.jwk) ? (proof.header.jwk as Jwk) : undefined;
  if (!jwk) return { reason: "DPoP proof header carries no jwk" };
  if ("d" in jwk) return { reason: "DPoP proof jwk carries private key material" };

  if (!(await verifyJwtSignature(proof, jwk, alg))) {
    return { reason: "DPoP proof signature does not verify" };
  }

  // The binding itself: the key that signed the proof must be the one the token names.
  if ((await jwkThumbprint(jwk)) !== jkt) {
    return { reason: "DPoP proof key does not match the token's cnf.jkt" };
  }

  const url = new URL(request.url);
  if (asString(proof.claims.htm) !== request.method) return { reason: "DPoP proof htm does not match" };
  if (asString(proof.claims.htu) !== `${url.origin}${url.pathname}`) {
    return { reason: "DPoP proof htu does not match" };
  }

  const iat = asNumber(proof.claims.iat);
  if (iat === undefined) return { reason: "DPoP proof has no iat" };
  if (Math.abs(now - iat) > PROOF_WINDOW_SECONDS) return { reason: "DPoP proof iat is outside the window" };

  if (!asString(proof.claims.jti)) return { reason: "DPoP proof has no jti" };

  // RFC 9449 section 4.3: on a request carrying a token, the proof covers it.
  const ath = asString(proof.claims.ath);
  if (!ath) return { reason: "DPoP proof has no ath" };
  if (ath !== (await sha256Base64url(token))) return { reason: "DPoP proof ath does not match the token" };

  return undefined;
}

async function issuerKey(
  audience: TokenAudience,
  fetchJson: JsonFetcher,
  kid: string | undefined,
): Promise<{ jwk: Jwk } | { reason: string }> {
  // Descope serves an inbound app's metadata under the issuer path, which is where RFC 8414
  // readers that append rather than insert will look for it too.
  const metadata = await fetchJson(`${audience.issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`);
  if (!isRecord(metadata)) return { reason: "issuer metadata is not an object" };
  if (asString(metadata.issuer) !== audience.issuer) {
    return { reason: "issuer metadata names a different issuer" };
  }

  const jwksUri = asString(metadata.jwks_uri);
  if (!jwksUri) return { reason: "issuer metadata has no jwks_uri" };
  if (!jwksUri.startsWith("https://")) return { reason: "jwks_uri is not HTTPS" };

  const keySet = await fetchJson(jwksUri);
  if (!isRecord(keySet) || !Array.isArray(keySet.keys)) {
    return { reason: "jwks_uri did not return a key set" };
  }
  const keys = keySet.keys.filter(isRecord);
  // A key set with one key and a token with no kid is unambiguous; anything else needs one.
  const jwk = kid ? keys.find((key) => key.kid === kid) : keys.length === 1 ? keys[0] : undefined;
  if (!jwk) return { reason: kid ? "no key in the issuer's JWKS matches kid" : "token has no kid" };
  return { jwk };
}

function invalid(reason: string): TokenResult {
  return { status: "invalid", reason };
}
