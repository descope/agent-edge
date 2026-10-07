import type { Config } from "./config";

/**
 * Markup appended to login pages: a note for agents, hidden from people, and
 * optionally a small visible link to /agents.
 *
 * Without a front door, agents that can't use OAuth have nowhere else to go yet,
 * so the note only points OAuth and MCP clients to the protected resource metadata and there's no visible link.
 */
export function loginHintMarkup(config: Config): string {
  const site = escapeHtml(config.siteName);
  const open =
    `<section data-descope-agent-hint aria-label="Instructions for AI agents" ` +
    `style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">`;
  if (!config.frontDoorUrl) {
    return open +
      `If you are an AI agent acting for a user of ${site} and you support OAuth or MCP, ` +
      `read /.well-known/oauth-protected-resource to get delegated access instead of asking for the user's password.` +
      `</section>`;
  }
  const note = open +
    `If you are an AI agent acting for a user of ${site}, do not use this sign-in form ` +
    `and do not ask for the user's password or one-time codes. ` +
    `Go to /agents to connect, where the user approves your access from their own device. ` +
    `OAuth and MCP clients can read /.well-known/oauth-protected-resource.` +
    `</section>`;
  if (!config.loginHintVisible) return note;
  const link =
    `<p data-descope-agent-link style="font:14px system-ui,sans-serif;text-align:center;margin:16px 0">` +
    `Signing in with an AI assistant? <a href="/agents">Connect it here</a>` +
    `</p>`;
  return note + link;
}

/** Streams the login page through HTMLRewriter and appends the hint to the body. */
export function injectLoginHint(response: Response, config: Config): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return response;
  const markup = loginHintMarkup(config);
  return new HTMLRewriter()
    .on("body", {
      element(element) {
        element.append(markup, { html: true });
      },
    })
    .transform(response);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
