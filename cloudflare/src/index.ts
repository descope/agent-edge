import { detectAgent, type AgentResult } from "./agentDetection";
import { loadConfig, pathMatches, type Config, type Env } from "./config";
import { addDiscoveryChallenge } from "./challenge";
import { agentsPage, metadataUrl, POPPY_PATH, poppyDocument, protectedResourceMetadata } from "./discovery";
import { signAgentHint } from "./hint";
import { cachedJsonFetcher } from "./keyCache";
import { injectLoginHint } from "./loginHint";
import { invalidSessionResponse, verifySession, type SessionResult } from "./session";
import { validateAccessToken, type TokenResult } from "./accessToken";
import { handleJoin, isJoinPath } from "./joinRoutes";

export { PoppyJoin } from "./joinObject";

/** Headers this worker sets for the origin. Incoming copies are always stripped. */
const AGENT_HEADERS = [
  "x-descope-agent",
  "x-descope-agent-origin",
  "x-descope-agent-client-id",
  "x-descope-agent-session",
  "x-descope-agent-user",
  "x-descope-agent-subject",
  "x-descope-agent-scope",
];

/**
 * Set on every request the worker forwards. If one comes back, the worker is forwarding
 * to itself, which is what happens under `wrangler dev` without UPSTREAM_ORIGIN.
 */
const HOP_HEADER = "x-agent-edge-forwarded";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.headers.has(HOP_HEADER)) {
      return new Response(
        "agent-edge: this request looped back to the worker. Under `wrangler dev` there is no site behind it, " +
        "so set UPSTREAM_ORIGIN to the site to forward to, for example --var UPSTREAM_ORIGIN:http://localhost:3000\n",
        { status: 508, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

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
      if (url.pathname === POPPY_PATH) return poppyDocument(config, url);
    }

    // The browser join (section 6), served at the edge. It never reaches the origin: the
    // whole point is that the site needs no code of its own for this.
    if (isJoinPath(url.pathname, config)) {
      return handleJoin(request, config, env.POPPY_JOIN!, cachedJsonFetcher(ctx));
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

    // Which Session this request belongs to (spec 5.3). Web Bot Auth says which operator
    // sent a request; this says which agent, acting for which User, in which Session —
    // identifiers that exist nowhere else, since the Personal Agent assigns the User ID.
    let session: SessionResult = { status: "none", reason: "verification off" };
    if (config.verifyPoppySession) {
      session = await verifySession(request, config, cachedJsonFetcher(ctx));
      if (session.status === "invalid") {
        console.log(JSON.stringify({
          event: "poppy_session_invalid",
          reason: session.reason,
          method: request.method,
          path: url.pathname,
        }));
        // 5.3 wants the agent told, "so the Personal Agent learns of a mistake in its
        // header" — and told with a 400, since a 401 would make an OAuth library throw
        // away an access token that is perfectly good.
        return invalidSessionResponse(session);
      }
      // 5.3: "An edge that verifies delegated Session JWTs can authenticate the client
      // without this extra signature." So a verified JWT identifies the agent even when
      // it sent no Web Bot Auth signature, and blocked paths should apply to it.
      if (session.status === "verified" && agent.status === "none") {
        agent = { status: "verified", reason: "Poppy Session JWT" };
      }
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
        poppy_client_id: session.clientId ?? null,
        poppy_sid: session.sid ?? null,
        method: request.method,
        path: url.pathname,
      }));
    }

    if (action === "redirect") return redirectToFrontDoor(agent, config, url);
    if (action === "block") return blocked(request, config);

    // The access token, on the paths that take one. A request with no token passes through
    // untouched: an API may well have public operations, and refusing them here would be
    // the worker inventing an authorization rule the origin never asked for.
    let token: TokenResult = { status: "none", reason: "validation off" };
    if (config.validateAccessTokens && pathMatches(url.pathname, config.apiPaths)) {
      token = await validateAccessToken(request, config, cachedJsonFetcher(ctx));
      if (token.status === "invalid") {
        console.log(JSON.stringify({
          event: "access_token_invalid",
          reason: token.reason,
          method: request.method,
          path: url.pathname,
        }));
        return invalidTokenResponse(config, token);
      }
    }

    // Forward to the origin with trustworthy agent headers.
    const forwarded = withoutAgentHeaders(request);
    if (agent.status !== "none") {
      forwarded.headers.set("x-descope-agent", agent.status);
      if (agent.signatureAgent) forwarded.headers.set("x-descope-agent-origin", agent.signatureAgent);
    }
    // Only ever set from a JWT this worker verified. The incoming copies were stripped
    // above, so the origin can trust these the way it trusts x-descope-agent.
    if (session.status === "verified") {
      forwarded.headers.set("x-descope-agent-client-id", session.clientId!);
      forwarded.headers.set("x-descope-agent-session", session.sid!);
      forwarded.headers.set("x-descope-agent-user", session.userId!);
    }
    if (token.status === "valid") {
      if (token.subject) forwarded.headers.set("x-descope-agent-subject", token.subject);
      forwarded.headers.set("x-descope-agent-scope", (token.scopes ?? []).join(" "));
    }
    let response = await fetch(new Request(upstreamUrl(url, config), forwarded));

    // Point MCP and OAuth clients at the metadata when the API turns them away, and name
    // the scopes if the origin didn't. Poppy section 7 wants them on both refusals: a 401
    // carrying no scopes leaves an agent nothing to act on, which is how sign-in loops
    // start.
    if ((response.status === 401 || response.status === 403) &&
        pathMatches(url.pathname, config.apiPaths)) {
      response = addDiscoveryChallenge(response, metadataUrl(config), config.scopes);
    }

    // Show browser agents the way to /agents on the human login page.
    if (config.injectLoginHint && request.method === "GET" &&
        pathMatches(url.pathname, config.loginPaths)) {
      response = injectLoginHint(response, config, url.toString());
    }

    return response;
  },
} satisfies ExportedHandler<Env>;

type Action = "pass" | "redirect" | "block";

/** A copy of the request with any client-supplied agent headers removed. */
function withoutAgentHeaders(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of AGENT_HEADERS) headers.delete(name);
  headers.set(HOP_HEADER, "1");
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

/**
 * Pages agents may never use, such as payment methods. The customer has to make these changes
 * themselves, so the message says that plainly, and doesn't send the agent anywhere else.
 */
function blocked(request: Request, config: Config): Response {
  const message = `AI agents can't use this page. It's only for the customer: ask them to make this change themselves, signed in to ${config.siteName} on their own device.`;
  const headers = { "cache-control": "no-store" };
  if ((request.headers.get("accept") ?? "").includes("text/html")) {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Only the customer can do this</title></head>` +
      `<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1.25rem;line-height:1.5">` +
      `<h1>Only the customer can do this</h1><p>${escapeHtml(message)}</p></body></html>`;
    return new Response(html, { status: 403, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
  }
  return Response.json({ error: "agent_not_allowed", message }, { status: 403, headers });
}

/**
 * A token the worker could not verify. RFC 6750 section 3.1 calls this `invalid_token` with
 * a 401, and section 7 of the Poppy spec adds the resource metadata and the scopes, so an
 * agent can tell "your token is wrong" from "you need more than it carries".
 *
 * The description is the reason, which names the check that failed. That is a deliberate
 * trade: it tells anyone holding a forged token which claim disagreed, and it is the only
 * thing that makes an agent's failure diagnosable at all. The same trade, with the same
 * reasoning, is already made by AGENT_DEBUG_REFUSALS in the Northbound sample.
 */
function invalidTokenResponse(config: Config, token: TokenResult): Response {
  const parts = [
    'Bearer error="invalid_token"',
    `error_description="${token.reason.replace(/[^ -~]+/g, " ").replace(/"/g, "'")}"`,
    `resource_metadata="${metadataUrl(config)}"`,
  ];
  if (config.scopes.length > 0) parts.push(`scope="${config.scopes.join(" ")}"`);
  return Response.json(
    { error: "invalid_token", error_description: token.reason },
    { status: 401, headers: { "www-authenticate": parts.join(", "), "cache-control": "no-store" } },
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
