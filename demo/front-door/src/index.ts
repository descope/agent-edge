import { loadConfig, type Config, type Env, type Tier } from "./config";
import { pollToken, refreshTokens, startCiba, type TokenSet } from "./descope";
import { randomCode } from "./encoding";
import { verifyHint } from "./hint";
import { connectPage, waitingPage } from "./pages";
import { seal, unseal, type PendingRequest, type RefreshState } from "./state";
import { verifiedSignatureAgent } from "./webBotAuth";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default {
  async fetch(request, env): Promise<Response> {
    let config: Config;
    try {
      config = loadConfig(env);
    } catch (error) {
      console.error(JSON.stringify({ event: "config_error", error: String(error) }));
      return json({ error: "server_misconfigured", message: String(error) }, 500);
    }

    const url = new URL(request.url);
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/connect")) {
        return connectPage(config.siteName, {
          returnTo: safeReturnTo(url.searchParams.get("return_to")),
          agentHint: url.searchParams.get("agent_hint") ?? undefined,
        });
      }
      if (request.method === "POST" && url.pathname === "/connect") return await connect(request, config);
      if (request.method === "GET" && url.pathname === "/status") return await status(url, config);
      if (request.method === "GET" && url.pathname === "/jwks.json") return jwks(config);
      if ((request.method === "GET" || request.method === "POST") && url.pathname === "/refresh") {
        return await refresh(request, url, config);
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      console.error(JSON.stringify({ event: "error", path: url.pathname, error: String(error) }));
      return json({ error: "server_error", message: String(error) }, 502);
    }
  },
} satisfies ExportedHandler<Env>;

async function connect(request: Request, config: Config): Promise<Response> {
  const wantsJson = (request.headers.get("content-type") ?? "").includes("application/json");
  const input: Record<string, unknown> = wantsJson
    ? ((await request.clone().json().catch(() => ({}))) as Record<string, unknown>)
    : Object.fromEntries((await request.clone().formData()).entries());
  const email = String(input.email ?? "").trim();
  const returnTo = safeReturnTo(typeof input.return_to === "string" ? input.return_to : undefined);
  const agentHint = typeof input.agent_hint === "string" && input.agent_hint ? input.agent_hint : undefined;

  if (!EMAIL.test(email)) {
    return wantsJson
      ? json({ error: "invalid_request", message: "email is required" }, 400)
      : connectPage(config.siteName, { returnTo, agentHint }, "Enter a valid email address.");
  }

  const agent = await identify(request, agentHint, config);
  const clientId = agent.tier === "trusted" ? config.clients.trusted[agent.signatureAgent!] : config.clients[agent.tier];
  // Per-request agent ID, so requests on the shared clients can still be told apart and revoked.
  const agentId = `agt_${randomCode(16, "abcdefghijkmnpqrstuvwxyz23456789")}`;
  // Shown to the agent and in the approval message, so the user can check they match.
  const code = randomCode(6);

  const ciba = await startCiba(config, {
    clientId,
    email,
    scope: config.scopes[agent.tier],
    bindingMessage: `${agentLabel(agent)} wants to connect to ${config.siteName}. Code ${code}`,
  });

  const pending: PendingRequest = {
    authReqId: ciba.authReqId,
    clientId,
    tier: agent.tier,
    agentId,
    code,
    returnTo,
    expiresAt: Date.now() + ciba.expiresIn * 1000,
    interval: ciba.interval,
  };
  const handle = await seal(pending, config.stateSecret);
  console.log(JSON.stringify({
    event: "connect_started",
    agent_id: agentId,
    tier: agent.tier,
    client_id: clientId,
    signature_agent: agent.signatureAgent ?? null,
    verified_by: agent.source,
  }));

  if (!wantsJson) return waitingPage(config.siteName, { handle, code, interval: ciba.interval, returnTo, cookies: Boolean(config.cookies) });
  return json({
    handle,
    code,
    agent_id: agentId,
    tier: agent.tier,
    status_url: `${new URL(request.url).origin}/status?handle=${encodeURIComponent(handle)}`,
    interval: ciba.interval,
    expires_in: ciba.expiresIn,
    message: `Ask the user to approve the request in their email if it shows the code ${code}.`,
  });
}

async function status(url: URL, config: Config): Promise<Response> {
  const pending = await unseal(url.searchParams.get("handle") ?? "", config.stateSecret);
  if (!pending) return json({ status: "error", error: "unknown handle" }, 400);
  if (Date.now() > pending.expiresAt) return json({ status: "expired" });

  const result = await pollToken(config, pending.clientId, pending.authReqId);
  if (result.status === "pending") {
    if (!result.slowDown) return json({ status: "pending", interval: pending.interval });
    // The interval lives in the handle, so hand back a new handle that carries the slower one.
    const slower = { ...pending, interval: pending.interval + 5 };
    return json({ status: "pending", interval: slower.interval, handle: await seal(slower, config.stateSecret) });
  }

  console.log(JSON.stringify({ event: `connect_${result.status}`, agent_id: pending.agentId, tier: pending.tier }));
  if (result.status === "approved") {
    const { refresh_token: refreshToken, ...token } = result.token;
    const response = json({ status: "approved", agent_id: pending.agentId, ...token });
    await setSessionCookies(response, url, config, result.token, refreshToken && { refreshToken, clientId: pending.clientId, agentId: pending.agentId });
    return response;
  }
  return json(result);
}

/**
 * Browser agents use the site like a person does, so the access token goes in a cookie the
 * site can read, and the browser sends it without the agent adding a header. Set COOKIE_DOMAIN
 * to the site's domain, with the front door on a subdomain of it. The refresh token is sealed
 * and scoped to the front door's /refresh, so it never reaches the site.
 */
async function setSessionCookies(
  response: Response,
  url: URL,
  config: Config,
  token: TokenSet,
  refreshState: RefreshState | undefined | "",
): Promise<void> {
  const c = config.cookies;
  if (!c) return;
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const domain = c.domain ? `; Domain=${c.domain}` : "";
  const accessMaxAge = token.expires_in ?? 600;
  response.headers.append("set-cookie",
    `${c.access}=${token.access_token}; Path=/${domain}; Max-Age=${accessMaxAge}; HttpOnly${secure}; SameSite=Lax`);
  if (refreshState) {
    const sealed = await seal(refreshState, config.stateSecret);
    response.headers.append("set-cookie",
      `${c.refresh}=${sealed}; Path=/refresh; Max-Age=${c.refreshMaxAge}; HttpOnly${secure}; SameSite=Lax`);
  }
}

function clearSessionCookies(response: Response, url: URL, config: Config): void {
  const c = config.cookies;
  if (!c) return;
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const domain = c.domain ? `; Domain=${c.domain}` : "";
  response.headers.append("set-cookie", `${c.access}=; Path=/${domain}; Max-Age=0; HttpOnly${secure}; SameSite=Lax`);
  response.headers.append("set-cookie", `${c.refresh}=; Path=/refresh; Max-Age=0; HttpOnly${secure}; SameSite=Lax`);
}

/**
 * Refreshes the browser session from the refresh cookie. POST returns JSON. GET redirects to
 * return_to, so a site can send a browser with an expired access token here and get it back.
 */
async function refresh(request: Request, url: URL, config: Config): Promise<Response> {
  const returnTo = safeReturnTo(url.searchParams.get("return_to"));
  const name = config.cookies?.refresh ?? "DSR";
  const raw = (request.headers.get("cookie") ?? "")
    .split(/;\s*/)
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  const state = raw ? await unseal<RefreshState>(raw, config.stateSecret) : undefined;
  const token = state && (await refreshTokens(config, state.clientId, state.refreshToken));

  if (!state || !token) {
    const response = json({ error: "refresh_failed", message: "Connect the agent again." }, 401);
    clearSessionCookies(response, url, config);
    return response;
  }

  console.log(JSON.stringify({ event: "session_refreshed", agent_id: state.agentId }));
  const response = returnTo && request.method === "GET"
    ? new Response(null, { status: 302, headers: { location: returnTo, "cache-control": "no-store" } })
    : json({ status: "refreshed", expires_in: token.expires_in });
  // Keep the old refresh token unless Descope rotated it.
  await setSessionCookies(response, url, config, token, { ...state, refreshToken: token.refresh_token ?? state.refreshToken });
  return response;
}

interface Agent {
  tier: Tier;
  signatureAgent?: string;
  source: "web_bot_auth" | "edge_hint" | "none";
}

/** Verifies the agent directly, falls back to the edge integration's signed hint, then to unverified. */
async function identify(request: Request, agentHint: string | undefined, config: Config): Promise<Agent> {
  let signatureAgent = await verifiedSignatureAgent(request);
  let verified = Boolean(signatureAgent);
  let source: Agent["source"] = verified ? "web_bot_auth" : "none";

  if (!verified && agentHint && config.hintSigningSecret) {
    const hint = await verifyHint(agentHint, config.hintSigningSecret);
    if (hint?.status === "verified") {
      verified = true;
      signatureAgent = hint.signature_agent ?? undefined;
      source = "edge_hint";
    }
  }

  if (signatureAgent && config.clients.trusted[signatureAgent]) return { tier: "trusted", signatureAgent, source };
  if (verified) return { tier: "verified", signatureAgent, source };
  return { tier: "unverified", source };
}

function agentLabel(agent: Agent): string {
  if (agent.tier === "trusted") return `An agent from ${new URL(agent.signatureAgent!).host}`;
  if (agent.tier === "verified") return "A verified agent";
  return "An unverified agent";
}

function safeReturnTo(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function jwks(config: Config): Response {
  if (!config.privateKey) return json({ keys: [] });
  const { d: _private, ...publicKey } = config.privateKey;
  return json({ keys: [{ ...publicKey, use: "sig", alg: "ES256" }] });
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
