/**
 * The JWT handling the worker needs, over WebCrypto only.
 *
 * Shared by the Poppy Session header (5.2, 5.3), DPoP proofs (RFC 9449) and access tokens.
 * They are three different JWTs with three different trust models, but the parsing, the
 * signature check and the thumbprint are the same work, and doing it once means a fix
 * reaches all three.
 */

/**
 * A JWK as it arrives on the wire. Deliberately not lib.dom's `JsonWebKey`, which has no
 * index signature, so reading `kid` or `crv` off one needs a cast at every use.
 */
export type Jwk = Record<string, unknown>;

/** Signature algorithms the worker verifies. */
export type Alg = "ES256" | "ES384" | "ES512" | "PS256" | "PS384" | "PS512" | "RS256" | "RS384" | "RS512";

/**
 * How each algorithm is imported and verified. Left to inference: the workers runtime types
 * do not export the DOM's `EcKeyImportParams` and friends by those names.
 */
const ALGS = {
  ES256: { import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
  ES384: { import: { name: "ECDSA", namedCurve: "P-384" }, verify: { name: "ECDSA", hash: "SHA-384" } },
  ES512: { import: { name: "ECDSA", namedCurve: "P-521" }, verify: { name: "ECDSA", hash: "SHA-512" } },
  PS256: { import: { name: "RSA-PSS", hash: "SHA-256" }, verify: { name: "RSA-PSS", saltLength: 32 } },
  PS384: { import: { name: "RSA-PSS", hash: "SHA-384" }, verify: { name: "RSA-PSS", saltLength: 48 } },
  PS512: { import: { name: "RSA-PSS", hash: "SHA-512" }, verify: { name: "RSA-PSS", saltLength: 64 } },
  RS256: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  RS384: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  RS512: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
} as const;

export function isAlg(value: unknown): value is Alg {
  return typeof value === "string" && value in ALGS;
}

export interface ParsedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
}

export function parseJwt(token: string): ParsedJwt | undefined {
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

export async function verifyJwtSignature(jwt: ParsedJwt, jwk: Jwk, alg: Alg): Promise<boolean> {
  const spec = ALGS[alg];
  try {
    // `key_ops`, `use` and `alg` on a published JWK can disagree with what we need here;
    // importing a copy without them avoids a spurious failure on an otherwise valid key.
    const { key_ops, use, alg: _alg, ...material } = jwk;
    const key = await crypto.subtle.importKey(
      "jwk",
      material as unknown as JsonWebKey,
      spec.import as unknown as Parameters<typeof crypto.subtle.importKey>[2],
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      spec.verify as unknown as Parameters<typeof crypto.subtle.verify>[0],
      key,
      jwt.signature as BufferSource,
      new TextEncoder().encode(jwt.signingInput) as BufferSource,
    );
  } catch {
    return false;
  }
}

/** RFC 7638 JWK thumbprint. Only the members the key types in play actually use. */
export async function jwkThumbprint(jwk: Jwk): Promise<string> {
  const canonical = jwk.kty === "EC"
    ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
    : jwk.kty === "OKP"
      ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x }
      : { e: jwk.e, kty: jwk.kty, n: jwk.n };
  return sha256Base64url(JSON.stringify(canonical));
}

export async function sha256Base64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value) as BufferSource);
  return bytesToBase64url(new Uint8Array(digest));
}

/** The access token a request presents, under either the Bearer or the DPoP scheme. */
export function presentedToken(request: Request): { scheme: "Bearer" | "DPoP"; token: string } | undefined {
  const header = request.headers.get("authorization");
  if (!header) return undefined;
  const match = /^(Bearer|DPoP)\s+(.+)$/i.exec(header.trim());
  if (!match) return undefined;
  return {
    scheme: /^bearer$/i.test(match[1]) ? "Bearer" : "DPoP",
    token: match[2],
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function base64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeText(value: string): string {
  return new TextDecoder().decode(base64urlToBytes(value) as BufferSource);
}
