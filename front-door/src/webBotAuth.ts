import {
  HTTP_MESSAGE_SIGNATURES_DIRECTORY,
  parseSignatureAgentCard,
  verify,
  type UntrustedWebBotSignatureCandidate,
  type WebBotVerifier,
} from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";

const MAX_DIRECTORY_BYTES = 64_000;

export interface VerifiedAgent {
  /** The Signature-Agent origin, proven by the signature this function checked. */
  uri: string;
  /**
   * `client_name` from a Client ID Metadata Document, when the agent pointed at one.
   * Self-asserted text from a document at a host whose control was proven, so it is a
   * better label than the bare host and still not a fact about the agent — never shown
   * without that host beside it. See `agentName` in index.ts.
   */
  clientName?: string;
}

/**
 * Verifies a Web Bot Auth signature on a request to the front door itself, so agents
 * that come here directly, not through the edge integration's redirect, can still be verified.
 * Returns the verified Signature-Agent origin, or undefined if the request isn't validly signed.
 */
export async function verifiedSignatureAgent(request: Request): Promise<VerifiedAgent | undefined> {
  if (!request.headers.has("signature") || !request.headers.has("signature-input")) return undefined;
  // `verify` takes a resolver that answers with a key, so a name read while fetching that key
  // has no way back out. The resolver writes it here instead, and it is only read after the
  // signature verifies — a document fetched for a signature that then fails names nothing.
  let clientName: string | undefined;
  try {
    const result = await verify(request, {
      resolver: (candidate) =>
        resolveVerifier(candidate, (name) => {
          clientName = name;
        }),
    });
    const uri = result.signatureAgent?.uri;
    return uri === undefined ? undefined : { uri, ...(clientName === undefined ? {} : { clientName }) };
  } catch {
    return undefined;
  }
}

async function resolveVerifier(
  candidate: UntrustedWebBotSignatureCandidate,
  foundName: (name: string) => void,
): Promise<WebBotVerifier> {
  const agent = candidate.signatureAgent;
  if (!agent || !agent.uri.startsWith("https://")) throw new Error("missing or non-https Signature-Agent");
  for (const jwk of await loadKeys(agent.type, agent.uri, foundName)) {
    try {
      const verifier = await verifierFromJWK(jwk);
      if (verifier.keyid === candidate.keyid && verifier.algorithm === candidate.algorithm) return verifier;
    } catch {
      // Skip keys this verifier can't use.
    }
  }
  throw new Error(`no key ${candidate.keyid} in the agent's key directory`);
}

async function loadKeys(
  type: "directory" | "jwks_uri" | "cimd",
  uri: string,
  foundName?: (name: string) => void,
): Promise<JsonWebKey[]> {
  if (type === "directory") return keysFrom(await fetchJson(new URL(HTTP_MESSAGE_SIGNATURES_DIRECTORY, uri).toString()));
  if (type === "jwks_uri") return keysFrom(await fetchJson(uri));
  const card = parseSignatureAgentCard(await fetchJson(uri), uri);
  // The document is already here for its keys; `client_name` costs nothing more. Only a CIMD
  // carries one — a key directory and a bare jwks_uri have no name to give.
  const name = cleanName(card.client_name);
  if (name !== undefined) foundName?.(name);
  if (card.jwks) return card.jwks.keys;
  if (card.jwks_uri) return keysFrom(await fetchJson(card.jwks_uri));
  throw new Error("client metadata has no keys");
}

/** How long a name may be before it stops being a name. Binding messages are short. */
const MAX_NAME_LENGTH = 40;

/**
 * This string is written by the agent and read by a customer deciding whether to let it spend
 * their money, so it is bounded before it goes anywhere near that message: control characters
 * out (a newline could forge a second line), whitespace collapsed, length capped, and nothing
 * returned for a name that is empty once cleaned.
 */
export function cleanName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  if (cleaned === "" || cleaned.length > MAX_NAME_LENGTH) return undefined;
  return cleaned;
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
