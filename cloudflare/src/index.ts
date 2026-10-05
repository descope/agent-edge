import { detectAgent, type AgentResult } from "./agentDetection";
import { loadConfig, pathMatches, type Config, type Env } from "./config";
import { addDiscoveryChallenge } from "./challenge";
import { agentsPage, authMd, metadataUrl, protectedResourceMetadata } from "./discovery";
import { signAgentHint } from "./hint";
import { cachedJsonFetcher } from "./keyCache";
import { injectLoginHint } from "./loginHint";

/** Headers this worker sets for the origin. Incoming copies are always stripped. */
const AGENT_HEADERS = ["x-descope-agent", "x-descope-agent-origin"];

export default {
  async fetch(request, env, ctx): Promise<Response> {
    let config: Config;
    try {
      config = loadConfig(env);
    } catch (error) {
      // Fail open: a configuration mistake should never take the site down.
      console.error(JSON.stringify({ event: "config_error", error: String(error) }));
      return fetch(request);
    }

    const url = new URL(request.url);

    // Discovery files and the agent page, served without touching the origin.
    if (request.method === "GET" || request.method === "HEAD") {
      if (url.pathname === "/.well-known/oauth-protected-resource" ||
          url.pathname.startsWith("/.well-known/oauth-protected-resource/")) {
        return protectedResourceMetadata(config);
      }
      if (url.pathname === "/auth.md") return authMd(config);
      if (url.pathname === "/agents") return agentsPage(config);
    }

    let agent: AgentResult;
    try {
      agent = await detectAgent(request, config, cachedJsonFetcher(ctx));
    } catch (error) {
      agent = { status: "none", reason: `detection error: ${String(error)}` };
    }

    const action = decideAction(agent, config, url.pathname);

    if (agent.status !== "none") {
      console.log(JSON.stringify({
        event: "agent_detected",
        mode: config.mode,
        action,
        status: agent.status,
        signature_agent: agent.signatureAgent ?? null,
        reason: agent.reason,
        method: request.method,
        path: url.pathname,
      }));
    }

    if (action === "redirect") return redirectToFrontDoor(agent, config, url);
    if (action === "block") return blocked(url);

    // Forward to the origin with trustworthy agent headers.
    const headers = new Headers(request.headers);
    for (const name of AGENT_HEADERS) headers.delete(name);
    if (agent.status !== "none") {
      headers.set("x-descope-agent", agent.status);
      if (agent.signatureAgent) headers.set("x-descope-agent-origin", agent.signatureAgent);
    }
    let response = await fetch(new Request(upstreamUrl(url, config), new Request(request, { headers })));

    // Point MCP and OAuth clients at the metadata when the API turns them away.
    if (response.status === 401 && pathMatches(url.pathname, config.apiPaths)) {
      response = addDiscoveryChallenge(response, metadataUrl(config));
    }

    // Show browser agents the way to /agents on the human login page.
    if (config.injectLoginHint && request.method === "GET" &&
        pathMatches(url.pathname, config.loginPaths)) {
      response = injectLoginHint(response, config);
    }

    return response;
  },
} satisfies ExportedHandler<Env>;

type Action = "pass" | "redirect" | "block";

/** Normally the request's own URL. UPSTREAM_ORIGIN swaps the origin for local testing. */
function upstreamUrl(url: URL, config: Config): string {
  if (!config.upstreamOrigin) return url.toString();
  return new URL(url.pathname + url.search, config.upstreamOrigin).toString();
}

function decideAction(agent: AgentResult, config: Config, path: string): Action {
  if (agent.status === "none" || config.mode !== "route") return "pass";
  if (pathMatches(path, config.blockedAgentPaths)) return "block";
  if (pathMatches(path, config.loginPaths)) return "redirect";
  return "pass";
}

async function redirectToFrontDoor(agent: AgentResult, config: Config, url: URL): Promise<Response> {
  const target = new URL(config.frontDoorUrl);
  target.searchParams.set("return_to", url.toString());
  if (config.hintSigningSecret) {
    target.searchParams.set("agent_hint", await signAgentHint(agent, config.hintSigningSecret));
  }
  return new Response(null, {
    status: 302,
    headers: { location: target.toString(), "cache-control": "no-store" },
  });
}

function blocked(url: URL): Response {
  return Response.json(
    {
      error: "agent_not_allowed",
      message: "AI agents can't use this page directly. Connect through the agent front door to act on this account.",
      agents_url: `${url.origin}/agents`,
    },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}
