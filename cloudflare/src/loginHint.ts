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
  // Pinned to the corner of the screen, so it's seen without scrolling. Canvas and CanvasText
  // follow the page's light or dark color scheme.
  return `<aside data-descope-agent-hint aria-label="Signing in with an AI assistant" ` +
    `style="position:fixed;right:16px;bottom:16px;left:auto;z-index:2147483000;max-width:22rem;` +
    `font:14px/1.5 system-ui,sans-serif;padding:12px 16px;border:1px solid rgba(127,127,127,0.35);` +
    `border-radius:8px;background:Canvas;color:CanvasText;box-shadow:0 2px 12px rgba(0,0,0,0.12)">` +
    `<strong>Using an AI assistant?</strong> It can connect to your ${site} account with your approval, ` +
    `without your password. You approve read-only access with a link on your own device, ` +
    `and approve each purchase separately. <a href="${connect}" style="color:inherit;font-weight:600;text-decoration:underline">Connect an assistant</a>` +
    `</aside>`;
}

/**
 * Streams the login page through HTMLRewriter and adds the box at the end of <body>. It sits
 * outside the page's own content, so frameworks that re-render on load (React, for example)
 * leave it alone, and it's pinned to the corner of the screen so it's still seen.
 */
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
