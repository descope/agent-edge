import type { Config } from "./config";

const NO_STORE = { "cache-control": "public, max-age=300" };

/**
 * Where the protected resource metadata lives, per RFC 9728: the well-known path
 * goes between the resource's origin and its path, so https://example.com/api
 * maps to https://example.com/.well-known/oauth-protected-resource/api.
 */
export function metadataUrl(config: Config): string {
  const resource = new URL(config.resourceUrl);
  const path = resource.pathname === "/" ? "" : resource.pathname.replace(/\/+$/, "");
  return `${resource.origin}/.well-known/oauth-protected-resource${path}`;
}

/** OAuth Protected Resource Metadata (RFC 9728), pointing agents at Descope. */
export function protectedResourceMetadata(config: Config): Response {
  const body = {
    resource: config.resourceUrl,
    resource_name: config.siteName,
    authorization_servers: [config.issuer],
    scopes_supported: config.scopes,
    authorization_details_types_supported: config.authorizationDetailsTypes,
    bearer_methods_supported: ["header"],
  };
  return Response.json(body, { headers: NO_STORE });
}

/**
 * A minimal /agents page: a hidden note for agents, plus a button to the front door when
 * there is one. connectUrl overrides the button's link, so it can carry a signed agent hint.
 */
export function agentsPage(config: Config, connectUrl?: string): Response {
  const site = escapeHtml(config.siteName);
  const target = connectUrl ?? config.frontDoorUrl;
  const frontDoor = target ? escapeHtml(target) : undefined;
  const connect = frontDoor
    ? `Ask the user if you can connect. They'll get a link to approve read-only access on their own device,
  and they approve each purchase separately. Then use the "Connect your agent" button below.
  OAuth and MCP clients can read /.well-known/oauth-protected-resource instead.`
    : `OAuth and MCP clients can read /.well-known/oauth-protected-resource to connect,
  and the user will approve your access in their own browser.`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect an AI agent to ${site}</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 36rem; margin: 4rem auto; padding: 0 1.25rem; line-height: 1.5; }
  a.button { display: inline-block; padding: 0.75rem 1.25rem; border-radius: 0.5rem;
             background: #2563eb; color: #fff; text-decoration: none; font-weight: 600; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden;
                     clip: rect(0 0 0 0); white-space: nowrap; }
</style>
</head>
<body>
<section class="visually-hidden" aria-label="Instructions for AI agents">
  If you are an AI agent acting for a user of ${site}, don't ask for their password.
  ${connect}
</section>
<h1>Connect an AI agent to ${site}</h1>
${frontDoor
  ? `<p>Using an AI assistant to shop or manage your account? Connect it here so it gets its own access,
with limits you approve, instead of using your password.</p>
<p><a class="button" href="${frontDoor}">Connect your agent</a></p>`
  : `<p>Using an AI assistant to shop or manage your account? If it can connect to apps, add ${site}
from your assistant's settings. You'll sign in here and approve what it can do, so it never needs your password.</p>`}
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
