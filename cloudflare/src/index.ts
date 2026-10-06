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
      return fetch(withoutAgentHeaders(request));
    }

    const url = new URL(request.url);

    // Discovery files and the agent page, served without touching the origin.
    if (request.method === "GET" || request.method === "HEAD") {
      if (url.pathname === "/.well-known/oauth-protected-resource" ||
          url.pathname.startsWith("/.well-known/oauth-protected-resource/")) {
        return protectedResourceMetadata(config);
      }
      if (url.pathname === "/auth.md") return authMd(config);
    }

    let agent: AgentResult;
    try {
      agent = await detectAgent(request, config, cachedJsonFetcher(ctx));
    } catch (error) {
      agent = { status: "none", reason: `detection error: ${String(error)}` };
    }

    // A browser carrying the front door's session cookie is an agent acting for a user,
    // even when its user agent looks like an ordinary browser. Treating it as one keeps
    // blocked paths blocked and puts its requests in the agent logs.
    const signedIn = hasCookie(request, config.agentSessionCookie);
    if (agent.status === "none" && signedIn) {
      agent = { status: "unverified", reason: "agent session cookie" };
    }

    // The agent page, served at the edge. A recognized agent's Connect button carries the
    // same signed hint as the login redirect, so the front door knows what was verified here.
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/agents") {
      return agentsPage(config, await connectUrl(agent, config, url));
    }

    const action = decideAction(agent, config, url.pathname, signedIn);

    if (agent.status !== "none") {
      console.log(JSON.stringify({
        event: "agent_detected",
        mode: config.mode,
        action,
        status: agent.status,
        signature_agent: agent.signatureAgent ?? null,
        claimed_signature_agent: agent.claimedSignatureAgent ?? null,
        reason: agent.reason,
        method: request.method,
        path: url.pathname,
      }));
    }

    if (action === "redirect") return redirectToFrontDoor(agent, config, url);
    if (action === "block") return blocked(url);

    // Forward to the origin with trustworthy agent headers.
    const forwarded = withoutAgentHeaders(request);
    if (agent.status !== "none") {
      forwarded.headers.set("x-descope-agent", agent.status);
      if (agent.signatureAgent) forwarded.headers.set("x-descope-agent-origin", agent.signatureAgent);
    }
    let response = await fetch(new Request(upstreamUrl(url, config), forwarded));

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

/** A copy of the request with any client-supplied agent headers removed. */
function withoutAgentHeaders(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of AGENT_HEADERS) headers.delete(name);
  return new Request(request, { headers });
}

/** Normally the request's own URL. UPSTREAM_ORIGIN swaps the origin for local testing. */
function upstreamUrl(url: URL, config: Config): string {
  if (!config.upstreamOrigin) return url.toString();
  return new URL(url.pathname + url.search, config.upstreamOrigin).toString();
}

function decideAction(agent: AgentResult, config: Config, path: string, signedIn: boolean): Action {
  if (agent.status === "none" || config.mode !== "route") return "pass";
  if (pathMatches(path, config.blockedAgentPaths)) return "block";
  // An agent the front door already signed in goes back to the login page as the user,
  // so sending it to the front door again would loop. This only skips a convenience
  // redirect; the site still checks the cookie's token itself.
  if (config.frontDoorUrl && !signedIn && pathMatches(path, config.loginPaths)) return "redirect";
  return "pass";
}

function hasCookie(request: Request, name: string): boolean {
  const header = request.headers.get("cookie") ?? "";
  return header.split(/;\s*/).some((part) => part.startsWith(`${name}=`) && part.length > name.length + 1);
}

async function redirectToFrontDoor(agent: AgentResult, config: Config, url: URL): Promise<Response> {
  const target = new URL(config.frontDoorUrl!);
  target.searchParams.set("return_to", url.toString());
  if (config.hintSigningSecret) {
    target.searchParams.set("agent_hint", await signAgentHint(agent, config.hintSigningSecret));
  }
  return new Response(null, {
    status: 302,
    headers: { location: target.toString(), "cache-control": "no-store" },
  });
}

async function connectUrl(agent: AgentResult, config: Config, url: URL): Promise<string | undefined> {
  if (!config.frontDoorUrl || !config.hintSigningSecret || agent.status === "none") return undefined;
  const target = new URL(config.frontDoorUrl);
  target.searchParams.set("return_to", `${url.origin}/`);
  target.searchParams.set("agent_hint", await signAgentHint(agent, config.hintSigningSecret));
  return target.toString();
}

function blocked(url: URL): Response {
  return Response.json(
    {
      error: "agent_not_allowed",
      message: "AI agents can't use this page directly. See agents_url for how to connect to this account.",
      agents_url: `${url.origin}/agents`,
    },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}
