import type { Config } from "./config";

/**
 * A box added to login pages that tells people, and the agents working for them, that an AI
 * assistant can connect with the customer's approval instead of using their password.
 *
 * It's visible and says the same thing to everyone. Careful agents treat hidden text that gives
 * AI assistants instructions as a prompt injection and ignore it, so this only describes what's
 * available and links to it. The agent and its user decide whether to use it.
 *
 * Without a front door there's nothing to connect to, so nothing is added.
 */
export function loginHintMarkup(config: Config, pageUrl?: string): string {
  if (!config.frontDoorUrl) return "";
  const site = escapeHtml(config.siteName);
  const target = new URL(config.frontDoorUrl);
  if (pageUrl) target.searchParams.set("return_to", pageUrl);
  const connect = escapeHtml(target.toString());
  return `<aside data-descope-agent-hint aria-label="Signing in with an AI assistant" ` +
    `style="font:14px/1.5 system-ui,sans-serif;max-width:28rem;margin:16px auto;padding:12px 16px;` +
    `border:1px solid rgba(127,127,127,0.35);border-radius:8px">` +
    `<strong>Using an AI assistant?</strong> It can connect to your ${site} account with your approval, ` +
    `without your password. You approve read-only access with a link on your own device, ` +
    `and approve each purchase separately. <a href="${connect}">Connect an assistant</a>` +
    `</aside>`;
}

/** Streams the login page through HTMLRewriter and appends the hint to the body. */
export function injectLoginHint(response: Response, config: Config, pageUrl?: string): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return response;
  const markup = loginHintMarkup(config, pageUrl);
  if (!markup) return response;
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
