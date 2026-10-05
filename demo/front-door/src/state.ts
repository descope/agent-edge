import { base64Url, fromBase64Url, utf8 } from "./encoding";
import type { Tier } from "./config";

/** Everything the front door needs to finish a request, sealed into the handle the agent holds. */
export interface PendingRequest {
  authReqId: string;
  clientId: string;
  tier: Tier;
  agentId: string;
  code: string;
  returnTo?: string;
  expiresAt: number;
  interval: number;
}

async function key(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", utf8(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypts the request so the front door needs no storage. Whoever holds the handle can collect the token. */
export async function seal(request: PendingRequest, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), utf8(JSON.stringify(request)));
  const out = new Uint8Array(12 + data.byteLength);
  out.set(iv);
  out.set(new Uint8Array(data), 12);
  return base64Url(out);
}

export async function unseal(handle: string, secret: string): Promise<PendingRequest | undefined> {
  try {
    const bytes = fromBase64Url(handle);
    const data = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12) },
      await key(secret),
      bytes.slice(12),
    );
    return JSON.parse(new TextDecoder().decode(data)) as PendingRequest;
  } catch {
    return undefined;
  }
}
