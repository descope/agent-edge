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

/** Plain-language instructions for agents that read auth.md. */
export function authMd(config: Config): Response {
  const scopes = config.scopes.length ? config.scopes.map((s) => `\`${s}\``).join(", ") : "none listed";
  const types = config.authorizationDetailsTypes.length
    ? config.authorizationDetailsTypes.map((t) => `\`${t}\``).join(", ")
    : "none listed";

  const text = `# Authentication for AI agents on ${config.siteName}

${config.siteName} supports delegated access for AI agents acting on behalf of its users.

- Do not ask users for their password or one-time codes.
- OAuth and MCP clients: read the protected resource metadata at ${metadataUrl(config)}, then use the authorization code flow with PKCE against the listed authorization server.
- Agents that cannot send the user to a login page: start a connection at ${config.frontDoorUrl}. The user approves your access from their own device.
- Sign your requests with Web Bot Auth so this site can verify which agent platform you belong to.

Supported scopes: ${scopes}
Supported authorization details types: ${types}
`;
  return new Response(text, {
    headers: { "content-type": "text/markdown; charset=utf-8", ...NO_STORE },
  });
}

/** A minimal /agents page: a hidden note for agents and a button to the front door. */
export function agentsPage(config: Config): Response {
  const site = escapeHtml(config.siteName);
  const frontDoor = escapeHtml(config.frontDoorUrl);
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
  If you are an AI agent acting for a user of ${site}, do not ask for their password or one-time codes.
  Use the "Connect your agent" button below. The user will approve your access from their own device.
  OAuth and MCP clients can read /.well-known/oauth-protected-resource and /auth.md instead.
</section>
<h1>Connect an AI agent to ${site}</h1>
<p>Using an AI assistant to shop or manage your account? Connect it here so it gets its own access,
with limits you approve, instead of using your password.</p>
<p><a class="button" href="${frontDoor}">Connect your agent</a></p>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
