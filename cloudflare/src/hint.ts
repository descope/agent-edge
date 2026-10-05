import type { AgentResult } from "./agentDetection";

/**
 * Signs a short-lived hint telling the front door what the worker verified,
 * so the front door can show the right agent name and apply the right policy.
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
 */
export async function signAgentHint(
  agent: AgentResult,
  secret: string,
  now: number = Date.now(),
): Promise<string> {
  const iat = Math.floor(now / 1000);
  const payload = {
    status: agent.status,
    signature_agent: agent.signatureAgent ?? null,
    iat,
    exp: iat + 300,
  };
  const body = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${base64Url(new Uint8Array(signature))}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
