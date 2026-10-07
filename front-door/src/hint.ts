import { fromBase64Url, utf8 } from "./encoding";

export interface AgentHint {
  status: "verified" | "unverified" | "none";
  signature_agent: string | null;
  iat: number;
  exp: number;
}

/** Checks the agent_hint the edge integration signs (see cloudflare/src/hint.ts). */
export function verifyHint(hint: string, secret: string, now = Date.now()): Promise<AgentHint | undefined> {
  return verifySigned<AgentHint>(hint, secret, now);
}

/** Checks base64url(JSON) + "." + base64url(HMAC-SHA256) and its exp, in seconds. */
export async function verifySigned<T extends { exp: number }>(value: string, secret: string, now = Date.now()): Promise<T | undefined> {
  const [body, signature] = value.split(".");
  if (!body || !signature) return undefined;
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  try {
    if (!(await crypto.subtle.verify("HMAC", key, fromBase64Url(signature), utf8(body)))) return undefined;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as T;
    return payload.exp * 1000 < now ? undefined : payload;
  } catch {
    return undefined;
  }
}
