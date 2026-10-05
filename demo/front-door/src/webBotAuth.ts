import {
  HTTP_MESSAGE_SIGNATURES_DIRECTORY,
  parseSignatureAgentCard,
  verify,
  type UntrustedWebBotSignatureCandidate,
  type WebBotVerifier,
} from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";

const MAX_DIRECTORY_BYTES = 64_000;

/**
 * Verifies a Web Bot Auth signature on a request to the front door itself, so agents
 * that come here directly, not through the edge integration's redirect, can still be verified.
 * Returns the verified Signature-Agent origin, or undefined if the request isn't validly signed.
 */
export async function verifiedSignatureAgent(request: Request): Promise<string | undefined> {
  if (!request.headers.has("signature") || !request.headers.has("signature-input")) return undefined;
  try {
    const result = await verify(request, { resolver: resolveVerifier });
    return result.signatureAgent?.uri;
  } catch {
    return undefined;
  }
}

async function resolveVerifier(candidate: UntrustedWebBotSignatureCandidate): Promise<WebBotVerifier> {
  const agent = candidate.signatureAgent;
  if (!agent || !agent.uri.startsWith("https://")) throw new Error("missing or non-https Signature-Agent");
  for (const jwk of await loadKeys(agent.type, agent.uri)) {
    try {
      const verifier = await verifierFromJWK(jwk);
      if (verifier.keyid === candidate.keyid && verifier.algorithm === candidate.algorithm) return verifier;
    } catch {
      // Skip keys this verifier can't use.
    }
  }
  throw new Error(`no key ${candidate.keyid} in the agent's key directory`);
}

async function loadKeys(type: "directory" | "jwks_uri" | "cimd", uri: string): Promise<JsonWebKey[]> {
  if (type === "directory") return keysFrom(await fetchJson(new URL(HTTP_MESSAGE_SIGNATURES_DIRECTORY, uri).toString()));
  if (type === "jwks_uri") return keysFrom(await fetchJson(uri));
  const card = parseSignatureAgentCard(await fetchJson(uri), uri);
  if (card.jwks) return card.jwks.keys;
  if (card.jwks_uri) return keysFrom(await fetchJson(card.jwks_uri));
  throw new Error("client metadata has no keys");
}

function keysFrom(value: unknown): JsonWebKey[] {
  const keys = (value as { keys?: unknown })?.keys;
  if (!Array.isArray(keys)) throw new Error("key directory has no keys array");
  return keys as JsonWebKey[];
}

/** The URL comes from the request, so cap the size while streaming and don't follow redirects. */
async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/http-message-signatures-directory+json, application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`key fetch failed (${response.status})`);
  if (Number(response.headers.get("content-length")) > MAX_DIRECTORY_BYTES || !response.body) {
    await response.body?.cancel();
    throw new Error("key directory too large or empty");
  }
  const reader = response.body.getReader();
  let text = "";
  let total = 0;
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DIRECTORY_BYTES) {
      await reader.cancel();
      throw new Error("key directory too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}
