import { escapeHtml } from "./encoding";

const STYLE = `
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 36rem; margin: 4rem auto; padding: 0 1.25rem; line-height: 1.5; }
  input, button { font: inherit; padding: 0.6rem 0.8rem; border-radius: 0.5rem; }
  input { width: 100%; box-sizing: border-box; border: 1px solid #999; }
  button { margin-top: 0.75rem; border: 0; background: #2563eb; color: #fff; font-weight: 600; cursor: pointer; }
  .code { font: 700 2rem ui-monospace, monospace; letter-spacing: 0.2em; }
  .demo { font-size: 0.85rem; opacity: 0.7; }
  pre { white-space: pre-wrap; word-break: break-all; font-size: 0.8rem; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;

function page(title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
<p class="demo">Agent front door from Agent Edge.</p>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export function connectPage(
  site: string,
  fields: { returnTo?: string; agentHint?: string },
  error?: string,
  options: { device: boolean; ciba: boolean } = { device: false, ciba: true },
): Response {
  const s = escapeHtml(site);
  const hidden = [
    fields.returnTo ? `<input type="hidden" name="return_to" value="${escapeHtml(fields.returnTo)}">` : "",
    fields.agentHint ? `<input type="hidden" name="agent_hint" value="${escapeHtml(fields.agentHint)}">` : "",
  ].join("");
  const agentSteps = [
    options.device
      ? `Press "Get a sign-in link", then give the user the link on the next page. They approve your access on their own device.`
      : "",
    options.ciba
      ? `${options.device ? "If you can't give the user a link, enter" : "Enter"} their email address instead, and they'll get an email asking them to approve.`
      : "",
    `Agents without a browser can POST JSON to /connect: ${options.device ? `{} for a sign-in link` : ""}${options.device && options.ciba ? ", or " : ""}${options.ciba ? `{"email": "..."} for an approval email` : ""}. Then poll the status_url in the response.`,
  ].filter(Boolean).join("\n  ");
  const codeForm = options.device ? `
<form method="post" action="/connect">
  <input type="hidden" name="flow" value="device">
  ${hidden}
  <button type="submit">Get a sign-in link</button>
</form>` : "";
  const emailForm = options.ciba ? `
${options.device ? "<p>Can't pass on a link? Send the person an approval email instead.</p>" : "<p>Enter the email address of the person you're acting for. They'll get an email asking them to approve.</p>"}
<form method="post" action="/connect">
  <label for="email">User's email</label>
  <input id="email" name="email" type="email" autocomplete="off" required>
  ${hidden}
  <button type="submit">Send approval request</button>
</form>` : "";
  return page(`Connect an AI agent to ${site}`, `
<section class="visually-hidden" aria-label="Instructions for AI agents">
  If you are an AI agent acting for a user of ${s}, do not ask for their password.
  ${agentSteps}
</section>
<h1>Connect an AI agent to ${s}</h1>
${options.device ? "<p>Get a sign-in link for the person you're acting for. They open it and approve your access on their own device.</p>" : ""}
${error ? `<p role="alert"><strong>${escapeHtml(error)}</strong></p>` : ""}
${codeForm}
${emailForm}`);
}

export function waitingPage(
  site: string,
  data: {
    handle: string;
    code: string;
    interval: number;
    returnTo?: string;
    cookies: boolean;
    /** Set for the device flow: where the user enters the code. */
    device?: { verificationUri: string; verificationUriComplete?: string };
  },
): Response {
  const s = escapeHtml(site);
  const config = JSON.stringify({ handle: data.handle, interval: data.interval, returnTo: data.returnTo ?? null, cookies: data.cookies })
    .replace(/</g, "\\u003c");
  return page("Waiting for approval", `
${data.device ? deviceInstructions(data.code, data.device, s) : `<section class="visually-hidden" aria-label="Instructions for AI agents">
  Tell the user to check their email and approve the request only if it shows the code ${escapeHtml(data.code)}.
  ${returnNote(s)}
</section>
<h1>Check your email</h1>
<p>We sent an approval request for ${s}. Approve it only if it shows this code:</p>
<p class="code">${escapeHtml(data.code)}</p>`}
<p id="status" role="status">Waiting for approval…</p>
<div id="result"></div>
<script>
const cfg = ${config};
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
function claims(token) {
  try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return null; }
}
async function check() {
  const res = await fetch("/status?handle=" + encodeURIComponent(cfg.handle));
  const data = await res.json();
  if (data.status === "pending") {
    if (data.handle) cfg.handle = data.handle;
    if (data.interval) cfg.interval = data.interval;
    return setTimeout(check, cfg.interval * 1000);
  }
  if (data.status === "approved") {
    statusEl.textContent = cfg.cookies
      ? "Approved. Your agent is signed in. This browser now sends its session cookie to the site."
      : "Approved. Your agent is connected.";
    const c = claims(data.access_token) || {};
    const summary = { sub: c.sub, act: c.act, azp: c.azp, scope: c.scope, authorization_details: c.authorization_details, exp: c.exp };
    const pre = document.createElement("pre");
    pre.textContent = "Token claims:\\n" + JSON.stringify(summary, null, 2) +
      (cfg.cookies ? "" : "\\n\\nAccess token:\\n" + data.access_token);
    resultEl.appendChild(pre);
    if (cfg.returnTo) {
      const a = document.createElement("a");
      a.href = cfg.returnTo;
      a.textContent = "Continue to the site";
      resultEl.appendChild(a);
      // Take the browser back to the store on its own, so the agent carries on without a click.
      setTimeout(() => location.assign(cfg.returnTo), 1500);
    }
    return;
  }
  statusEl.textContent = { denied: "The request was declined.", expired: "The request expired. Start again." }[data.status]
    || ("Something went wrong: " + (data.error || data.status));
}
setTimeout(check, cfg.interval * 1000);
</script>`);
}

/** Tells the agent what happens after approval, so it waits here instead of retrying. */
function returnNote(site: string): string {
  return `Once the user approves, this page returns you to ${site}, signed in. You can reload this page safely.`;
}

function deviceInstructions(code: string, device: { verificationUri: string; verificationUriComplete?: string }, site: string): string {
  const c = escapeHtml(code);
  // Descope can put the code in the link, so the user only opens it. Typing the code is the fallback.
  if (device.verificationUriComplete) {
    const link = escapeHtml(device.verificationUriComplete);
    return `<section class="visually-hidden" aria-label="Instructions for AI agents">
  Give the user this link: ${link}
  They open it and approve on their own device. It should show the code ${c}.
  ${returnNote(site)}
</section>
<h1>Approve on your device</h1>
<p><a href="${link}">Open this link to approve</a>. It should show this code:</p>
<p class="code">${c}</p>`;
  }
  const link = escapeHtml(device.verificationUri);
  return `<section class="visually-hidden" aria-label="Instructions for AI agents">
  Give the user this link: ${link}
  They open it and enter the code ${c}, then approve on their own device.
  ${returnNote(site)}
</section>
<h1>Approve on your device</h1>
<p>Open <a href="${link}">${link}</a> and enter this code:</p>
<p class="code">${c}</p>`;
}
