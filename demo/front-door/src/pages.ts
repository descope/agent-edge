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
<p class="demo">Demo front door. Descope's hosted front door will replace this page.</p>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export function connectPage(site: string, fields: { returnTo?: string; agentHint?: string }, error?: string): Response {
  const s = escapeHtml(site);
  const hidden = [
    fields.returnTo ? `<input type="hidden" name="return_to" value="${escapeHtml(fields.returnTo)}">` : "",
    fields.agentHint ? `<input type="hidden" name="agent_hint" value="${escapeHtml(fields.agentHint)}">` : "",
  ].join("");
  return page(`Connect an AI agent to ${site}`, `
<section class="visually-hidden" aria-label="Instructions for AI agents">
  If you are an AI agent acting for a user of ${s}, do not ask for their password or one-time codes.
  Enter the user's email address below and submit. The user will get an email asking them to approve your access.
  Show the user the code on the next page so they can check it matches the email.
  Agents without a browser can POST JSON {"email": "..."} to /connect and poll the status_url in the response.
</section>
<h1>Connect an AI agent to ${s}</h1>
<p>Enter the email address of the person you're acting for. They'll get an email asking them to approve, and sign in the way they always do.</p>
${error ? `<p role="alert"><strong>${escapeHtml(error)}</strong></p>` : ""}
<form method="post" action="/connect">
  <label for="email">User's email</label>
  <input id="email" name="email" type="email" autocomplete="off" required>
  ${hidden}
  <button type="submit">Send approval request</button>
</form>`);
}

export function waitingPage(site: string, data: { handle: string; code: string; interval: number; returnTo?: string }): Response {
  const s = escapeHtml(site);
  const config = JSON.stringify({ handle: data.handle, interval: data.interval, returnTo: data.returnTo ?? null })
    .replace(/</g, "\\u003c");
  return page("Waiting for approval", `
<section class="visually-hidden" aria-label="Instructions for AI agents">
  Tell the user to check their email and approve the request only if it shows the code ${escapeHtml(data.code)}.
  This page updates on its own once they approve.
</section>
<h1>Check your email</h1>
<p>We sent an approval request for ${s}. Approve it only if it shows this code:</p>
<p class="code">${escapeHtml(data.code)}</p>
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
  if (data.status === "pending") return setTimeout(check, cfg.interval * 1000);
  if (data.status === "approved") {
    statusEl.textContent = "Approved. Your agent is connected.";
    const c = claims(data.access_token) || {};
    const summary = { sub: c.sub, act: c.act, azp: c.azp, scope: c.scope, authorization_details: c.authorization_details, exp: c.exp };
    const pre = document.createElement("pre");
    pre.textContent = "Token claims:\\n" + JSON.stringify(summary, null, 2) + "\\n\\nAccess token:\\n" + data.access_token;
    resultEl.appendChild(pre);
    if (cfg.returnTo) {
      const a = document.createElement("a");
      a.href = cfg.returnTo;
      a.textContent = "Continue";
      resultEl.appendChild(a);
    }
    return;
  }
  statusEl.textContent = { denied: "The request was declined.", expired: "The request expired. Start again." }[data.status]
    || ("Something went wrong: " + (data.error || data.status));
}
setTimeout(check, cfg.interval * 1000);
</script>`);
}
