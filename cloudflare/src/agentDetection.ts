import {
  HTTP_MESSAGE_SIGNATURES_DIRECTORY,
  parseSignatureAgentCard,
  verify,
  type UntrustedWebBotSignatureCandidate,
  type WebBotVerifier,
} from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";
import type { Config } from "./config";

export type AgentStatus = "verified" | "unverified" | "none";

export interface AgentResult {
  status: AgentStatus;
  /** The verified Signature-Agent origin, or the claimed one for unverified agents. */
  signatureAgent?: string;
  keyid?: string;
  reason: string;
}

/** Fetches and parses JSON. Injected so the worker can cache and tests can mock. */
export type JsonFetcher = (url: string) => Promise<unknown>;

const NO_AGENT: AgentResult = { status: "none", reason: "no agent signals" };

export async function detectAgent(
  request: Request,
  config: Config,
  fetchJson: JsonFetcher,
): Promise<AgentResult> {
  const signed = request.headers.has("signature") && request.headers.has("signature-input");

  // 1. Web Bot Auth: a valid signature proves which agent platform sent the request.
  if (signed) {
    try {
      const result = await verify(request, {
        resolver: (candidate) => resolveVerifier(candidate, fetchJson),
      });
      return {
        status: "verified",
        signatureAgent: result.signatureAgent?.uri,
        keyid: result.keyid,
        reason: "web bot auth signature verified",
      };
    } catch (error) {
      return {
        status: "unverified",
        signatureAgent: request.headers.get("signature-agent") ?? undefined,
        reason: `web bot auth signature rejected: ${message(error)}`,
      };
    }
  }

  // 2. Cloudflare's own verified bot signal, when the zone has Bot Management fields.
  if (config.trustCloudflareVerifiedBots) {
    const category = cloudflareBotCategory(request);
    if (category && config.cloudflareAgentBotCategories.includes(category)) {
      return { status: "verified", reason: `cloudflare verified bot (${category})` };
    }
  }

  // 3. Heuristics: a user agent that looks like an agent but carries no proof.
  const userAgent = request.headers.get("user-agent") ?? "";
  const match = config.agentUserAgentPatterns.find((pattern) => userAgent.includes(pattern));
  if (match) {
    return { status: "unverified", reason: `user agent matches "${match}"` };
  }

  return NO_AGENT;
}

async function resolveVerifier(
  candidate: UntrustedWebBotSignatureCandidate,
  fetchJson: JsonFetcher,
): Promise<WebBotVerifier> {
  const agent = candidate.signatureAgent;
  if (!agent) throw new Error("missing Signature-Agent header");
  if (!agent.uri.startsWith("https://")) throw new Error("Signature-Agent must use https");

  const keys = await loadKeys(agent.type, agent.uri, fetchJson);
  for (const jwk of keys) {
    try {
      const verifier = await verifierFromJWK(jwk);
      if (verifier.keyid === candidate.keyid && verifier.algorithm === candidate.algorithm) {
        return verifier;
      }
    } catch {
      // Skip keys this verifier can't use.
    }
  }
  throw new Error(`no key ${candidate.keyid} in the agent's key directory`);
}

async function loadKeys(
  type: "directory" | "jwks_uri" | "cimd",
  uri: string,
  fetchJson: JsonFetcher,
): Promise<JsonWebKey[]> {
  if (type === "directory") {
    return keysFrom(await fetchJson(new URL(HTTP_MESSAGE_SIGNATURES_DIRECTORY, uri).toString()));
  }
  if (type === "jwks_uri") {
    return keysFrom(await fetchJson(uri));
  }
  // Client ID Metadata Document: keys are inline or behind jwks_uri.
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

function cloudflareBotCategory(request: Request): string | undefined {
  const cf = (request as unknown as { cf?: Record<string, unknown> }).cf;
  const category = cf?.verifiedBotCategory;
  return typeof category === "string" && category.length > 0 ? category : undefined;
}

/** Includes the underlying cause, since the library wraps resolver errors. */
function message(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause ? `${error.message} (${message(error.cause)})` : error.message;
}
