import type { Config } from "./config";
import type { JsonFetcher } from "./agentDetection";
import { validateAccessToken } from "./accessToken";
import { verifySession } from "./session";
import {
  BROWSER_SIGN_IN_SCOPE,
  JOIN_COOKIE,
  JOIN_TTL_SECONDS,
  newJoin,
  type JoinIdentity,
} from "./browserJoin";
import { joinObject } from "./joinObject";
import { bytesToBase64url } from "./jwt";

/**
 * The three endpoints of the Poppy browser join (section 6).
 *
 * The worker runs on the site's own zone, which is what makes this possible here: the
 * cookie it sets at the end is already on the host the agent is browsing, so there is no
 * cross-host problem to solve and the `__Host-` prefix can stay.
 *
 * What the worker cannot do is mint the site's own session. It does not know what one looks
 * like. So the join ends with a signed statement — this browser is that agent, acting for
 * that User, in that Session, with these scopes — which the origin validates with the same
 * shared secret it already uses for the agent hint, and turns into whatever a session means
 * to it.
 */

/** Set on the browser once a join completes. Read and validated by the origin. */
export const JOINED_COOKIE = "__Host-poppy_browser";

/** Matches the join's own lifetime expectations rather than the site's session length. */
const JOINED_TTL_SECONDS = 3600;

export function isJoinPath(pathname: string, config: Config): boolean {
  if (!config.browserJoinPath) return false;
  return pathname === config.browserJoinPath || pathname === `${config.browserJoinPath}/authorize`;
}

export async function handleJoin(
  request: Request,
  config: Config,
  namespace: DurableObjectNamespace,
  fetchJson: JsonFetcher,
): Promise<Response> {
  const url = new URL(request.url);
  const now = Math.floor(Date.now() / 1000);

  if (url.pathname === `${config.browserJoinPath}/authorize`) {
    if (request.method !== "POST") return methodNotAllowed("POST");
    return authorizeStep(request, config, namespace, fetchJson, now);
  }

  if (request.method === "GET") return startStep(config, namespace, now);
  if (request.method === "POST") return completeStep(request, config, namespace);
  return methodNotAllowed("GET, POST");
}

/** Step 1: hand this browser a code, and a cookie proving it was this browser. */
async function startStep(config: Config, namespace: DurableObjectNamespace, now: number): Promise<Response> {
  const join = newJoin(now);
  const stored = await joinObject(namespace, join.code, "start", await join.record);
  if (!stored.ok) return problem(500, "could not start a join");

  return new Response(joinPage(config, join.code), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // The code is useless without this, and this is useless on another host.
      "set-cookie": `${JOIN_COOKIE}=${join.secret}; Path=/; Max-Age=${JOIN_TTL_SECONDS}; Secure; HttpOnly; SameSite=Strict`,
      // Nothing here should ever be framed or share a browsing context group.
      "content-security-policy": "frame-ancestors 'none'",
      "cross-origin-opener-policy": "same-origin",
    },
  });
}

/** Step 2: the agent authorizes the code over its own back channel. */
async function authorizeStep(
  request: Request,
  config: Config,
  namespace: DurableObjectNamespace,
  fetchJson: JsonFetcher,
  now: number,
): Promise<Response> {
  const code = (await readCode(request)) ?? undefined;
  if (!code) return problem(400, "no code");

  // The Session JWT is what names the agent and the User. Without it there is nothing to
  // join the browser to, so unlike elsewhere in the worker it is required here.
  const session = await verifySession(request, config, fetchJson, now);
  if (session.status !== "verified") {
    return Response.json(
      { error: "invalid_session", error_description: session.reason },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  let scopes: string[] = [];
  let signedIn = false;
  if (request.headers.has("authorization")) {
    const token = await validateAccessToken(request, config, fetchJson, now);
    if (token.status !== "valid") {
      return Response.json(
        { error: "invalid_token", error_description: token.reason },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }
    // Section 6: "The Company MUST reject an access token in step 2 that doesn't have the
    // poppy:browser-sign-in scope, with insufficient_scope as at an API."
    if (!(token.scopes ?? []).includes(BROWSER_SIGN_IN_SCOPE)) {
      return Response.json(
        { error: "insufficient_scope", error_description: `needs ${BROWSER_SIGN_IN_SCOPE}` },
        {
          status: 403,
          headers: {
            "www-authenticate": `Bearer error="insufficient_scope", scope="${BROWSER_SIGN_IN_SCOPE}"`,
            "cache-control": "no-store",
          },
        },
      );
    }
    scopes = token.scopes ?? [];
    signedIn = true;
  }

  const identity: JoinIdentity = {
    clientId: session.clientId!,
    userId: session.userId!,
    sid: session.sid!,
    scopes,
    signedIn,
  };
  const result = await joinObject(namespace, code, "authorize", identity);
  if (!result.ok) {
    const body = (await result.json()) as { reason?: string };
    return problem(400, body.reason ?? "could not authorize this code");
  }
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}

/** Step 3: the browser posts the code back, carrying the cookie from step 1. */
async function completeStep(
  request: Request,
  config: Config,
  namespace: DurableObjectNamespace,
): Promise<Response> {
  const code = await readCode(request);
  if (!code) return problem(400, "no code");

  const secret = cookieValue(request, JOIN_COOKIE);
  const result = await joinObject(namespace, code, "complete", { secret });
  const outcome = (await result.json()) as { ok: boolean; reason?: string; identity?: JoinIdentity };
  if (!outcome.ok || !outcome.identity) return problem(400, outcome.reason ?? "join failed");

  const value = await signJoined(outcome.identity, config.hintSigningSecret!);
  const expired = `${JOIN_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
  const joined = `${JOINED_COOKIE}=${value}; Path=/; Max-Age=${JOINED_TTL_SECONDS}; Secure; HttpOnly; SameSite=Lax`;

  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  headers.append("set-cookie", expired);
  headers.append("set-cookie", joined);
  return new Response(joinedPage(config), { status: 200, headers });
}

/**
 * THE FORM MUST NOT SUBMIT ITSELF.
 *
 * The agent reads the code from this page, authorizes it over its own channel, and only
 * then drives the submit. A page that posted itself on load would spend the code before
 * step 2 had happened — and a code is spent by the first completion whatever the result, so
 * every join would fail with nothing left to retry.
 */
function joinPage(config: Config, code: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Connect your assistant</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.25rem;line-height:1.5">` +
    `<h1>Connect your assistant</h1>` +
    `<p>Your assistant is connecting to ${escapeHtml(config.siteName)}. It will finish this step itself.</p>` +
    `<form method="post" data-poppy-join>` +
    `<input type="hidden" name="code" value="${escapeHtml(code)}">` +
    `<button type="submit">Continue</button>` +
    `</form></body></html>`;
}

function joinedPage(config: Config): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connected</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.25rem;line-height:1.5">` +
    `<h1>Connected</h1><p>Your assistant is signed in to ${escapeHtml(config.siteName)} in this browser.</p>` +
    `</body></html>`;
}

/**
 * The statement the origin reads. Same shape and secret as the agent hint, so a site that
 * already validates one has the machinery for this.
 */
async function signJoined(identity: JoinIdentity, secret: string): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const payload = { ...identity, iat, exp: iat + JOINED_TTL_SECONDS };
  const body = bytesToBase64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body) as BufferSource);
  return `${body}.${bytesToBase64url(new Uint8Array(signature))}`;
}

async function readCode(request: Request): Promise<string | undefined> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = (await request.json()) as Record<string, unknown>;
      return typeof body.code === "string" ? body.code : undefined;
    }
    const form = await request.formData();
    const code = form.get("code");
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    if (part.startsWith(`${name}=`)) return part.slice(name.length + 1) || undefined;
  }
  return undefined;
}

function problem(status: number, reason: string): Response {
  return Response.json(
    { error: "join_failed", error_description: reason },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function methodNotAllowed(allow: string): Response {
  return new Response("method not allowed", { status: 405, headers: { allow } });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
