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

/** Where the Poppy discovery document lives. */
export const POPPY_PATH = "/.well-known/poppy.json";

/**
 * Poppy discovery (draft 0.4): one document that tells an agent who this site is, what it
 * can ask for, and where to sign in, so it can start without being told.
 * https://personalagentprotocol.org/docs/0.4/spec
 *
 * THE VERSION IS LOAD-BEARING. Before 1.0, two versions are compatible only when major AND
 * minor match (3.4), so an agent that speaks 0.4 does not downgrade to a 0.3 document — it
 * declines to use it. Bumping this string is not cosmetic, and neither is leaving it stale.
 *
 * `auth.device` is gone since 0.1. Device Sign-In is advertised by the authorization
 * server's `grant_types_supported`, not here, so the document no longer restates it.
 *
 * `auth.issuer` is optional in 0.4 whenever the protected resource metadata names a single
 * authorization server (3.1), which is exactly what this worker publishes. It is included
 * anyway, from the same DESCOPE_ISSUER that metadata uses, so the two documents cannot
 * point agents at different servers — which is the thing the rule exists to prevent.
 *
 * `apis` is resolved against the origin the document was asked for, so a site reachable at
 * both example.com and www.example.com advertises each visitor's own origin. Agents check
 * that the APIs they fetch are on the site they opened, and a document served on one host
 * naming another would fail that check.
 */
export function poppyDocument(config: Config, url: URL): Response {
  const body = {
    protocol_version: "0.4",
    organization: {
      name: config.siteName,
      domain: config.siteDomain,
    },
    auth: {
      issuer: config.issuer,
      // Omitted rather than sent empty: a scope map with nothing in it would claim the site
      // describes its scopes and then describe none of them.
      ...(config.scopeDescriptions ? { scopes: config.scopeDescriptions } : {}),
      ...(config.scopeHints ? { scope_hints: config.scopeHints } : {}),
    },
    // The site is a website. 0.4 requires at least one of `agent`, `apis` or `web`, and
    // leaving `browser_session_endpoint` out says agents browse it signed out (section 6),
    // which is true of any site this worker fronts: the front door's cookie is Agent Edge's
    // own mechanism, not the protocol's browser join.
    web: {},
    // Left out entirely when there is nothing to advertise, rather than sent as an empty list.
    ...(config.apis.length
      ? { apis: config.apis.map((api) => ({ ...api, url: new URL(api.url, url.origin).toString() })) }
      : {}),
  };
  return Response.json(body, { headers: NO_STORE });
}

/**
 * The /agents page: a visible explanation, plus a button to the front door when there is one.
 * Everything on it is shown to people too, so agents read it as information, not as hidden
 * instructions. connectUrl overrides the button's link, so it can carry a signed agent hint.
 */
export function agentsPage(config: Config, connectUrl?: string): Response {
  const site = escapeHtml(config.siteName);
  const target = connectUrl ?? config.frontDoorUrl;
  const frontDoor = target ? escapeHtml(target) : undefined;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect an AI assistant to ${site}</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 36rem; margin: 4rem auto; padding: 0 1.25rem; line-height: 1.5; }
  a.button { display: inline-block; padding: 0.75rem 1.25rem; border-radius: 0.5rem;
             background: #2563eb; color: #fff; text-decoration: none; font-weight: 600; }
  .small { font-size: 0.85rem; opacity: 0.75; }
</style>
</head>
<body>
<h1>Connect an AI assistant to ${site}</h1>
${frontDoor
  ? `<p>Using an AI assistant to shop or manage your account? Connect it so it gets its own access,
without your password. You approve read-only access with a link on your own device, and approve
each purchase separately.</p>
<p><a class="button" href="${frontDoor}">Connect your agent</a></p>`
  : `<p>Using an AI assistant to shop or manage your account? If it can connect to apps, add ${site}
from your assistant's settings. You'll sign in and approve what it can do, so it never needs your password.</p>`}
<p class="small">OAuth and MCP clients can find the authorization server at /.well-known/oauth-protected-resource.</p>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
