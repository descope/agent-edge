# agent-ready for Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/descope/agent-ready/tree/main/cloudflare)

A Cloudflare Worker you deploy in front of your site to get it ready for AI agents, with no changes to your app.

It does six things:

- **Verifies agents.** Checks Web Bot Auth signatures (RFC 9421) against each agent platform's published keys, and falls back to Cloudflare's verified bot signal and user-agent hints.
- **Publishes discovery files.** Serves `/.well-known/oauth-protected-resource`, `/auth.md`, and an `/agents` page that point agents at your Descope authorization server.
- **Routes agents.** Blocks agents from sensitive pages such as password and payment changes. Once the Descope-hosted front door is available, it also sends agents that land on your human login page there.
- **Tells your origin.** Adds `x-descope-agent` and `x-descope-agent-origin` headers so your app can see which requests came from agents.
- **Points MCP and OAuth clients at Descope.** Adds `WWW-Authenticate: Bearer resource_metadata="..."` to 401s from your API paths. MCP clients discover the authorization server from that header, so they find Descope on their own even though your API has never heard of it.
- **Shows browser agents the way in.** Injects a hidden note for agents and a small "Signing in with an AI assistant?" link into your login pages as they stream through, so browser agents find `/agents` without any template changes.

For how this fits together with Descope, see [How it works](../README.md#how-it-works).

It starts in **monitor mode**, which only logs what it sees, so you can deploy it safely and review real agent traffic before changing anything.

The Deploy to Cloudflare button above copies this folder into a new repo in your account and deploys it to `workers.dev`. You still need to fill in the values in `wrangler.toml` and add a route for your zone, as described below.

## Before you start

- A site proxied through Cloudflare.
- A Descope project.
- Node.js 20 or later.

## Setup

1. **Clone and install.**

   ```sh
   git clone https://github.com/descope/agent-ready.git
   cd agent-ready/cloudflare
   npm install
   ```

2. **Fill in `wrangler.toml`.** At minimum, set `DESCOPE_ISSUER`, `RESOURCE_URL`, and `SITE_NAME`. Leave `FRONT_DOOR_URL` unset until the front door is available. Adjust `LOGIN_PATHS` and `BLOCKED_AGENT_PATHS` to match your site.

3. **Add your route.** Uncomment the `routes` block and replace `example.com` with your zone.

4. **Optionally add the hint secret,** which lets the front door trust what the worker verified. You only need it once `FRONT_DOOR_URL` is set:

   ```sh
   npx wrangler secret put HINT_SIGNING_SECRET
   ```

5. **Deploy in monitor mode.**

   ```sh
   npm run deploy
   ```

6. **Review agent traffic.** Watch live with `npx wrangler tail`, or open the worker's logs in the Cloudflare dashboard and filter for `agent_detected`.

7. **Switch to route mode** once the logs look right. Set `MODE = "route"` in `wrangler.toml` and deploy again.

## Testing

```sh
npm test           # unit tests, including real Web Bot Auth signatures
npm run test:e2e   # runs the worker in workerd in front of a fake origin
npm run dev        # runs the worker locally
```

To try the worker locally against your own site or a staging server, point it at that origin:

```sh
npx wrangler dev --var UPSTREAM_ORIGIN:https://staging.example.com
```

A quick manual check against a deployed worker:

```sh
curl https://example.com/.well-known/oauth-protected-resource
curl https://example.com/auth.md
curl -I -A "HeadlessChrome" https://example.com/login   # 302 to the front door in route mode, if FRONT_DOOR_URL is set
curl -I https://example.com/api/orders                  # 401 with WWW-Authenticate: Bearer resource_metadata=...
```

To send a properly signed request, use Cloudflare's [web-bot-auth](https://github.com/cloudflare/web-bot-auth) tools or its research endpoint.

## Configuration

| Variable | What it does |
| --- | --- |
| `MODE` | `monitor` logs only. `route` also redirects and blocks. |
| `SITE_NAME` | Display name on the `/agents` page and in `auth.md`. |
| `DESCOPE_ISSUER` | Your Descope authorization server URL. |
| `FRONT_DOOR_URL` | The Descope-hosted agent front door. Optional, and not available yet. Without it, agents on login pages aren't redirected. |
| `RESOURCE_URL` | The resource identifier agents request tokens for. |
| `SCOPES_SUPPORTED` | Comma-separated scopes listed in the metadata. |
| `AUTHORIZATION_DETAILS_TYPES` | Comma-separated RAR types, such as `purchase`. |
| `LOGIN_PATHS` | Human login paths. A trailing `*` matches a prefix. |
| `BLOCKED_AGENT_PATHS` | Paths agents may never use directly. |
| `AGENT_USER_AGENT_PATTERNS` | User-agent substrings that suggest an unverified agent. |
| `TRUST_CLOUDFLARE_VERIFIED_BOTS` | Treats Cloudflare-verified bots in the listed categories as verified. |
| `CLOUDFLARE_AGENT_BOT_CATEGORIES` | Which verified bot categories count as agents. |
| `HINT_SIGNING_SECRET` | Secret for signing the agent hint sent to the front door. |
| `API_PATHS` | API paths whose 401s get the discovery challenge. Defaults to `/api/*`. |
| `INJECT_LOGIN_HINT` | Adds the agent note and link to login pages. Defaults to `true`. |
| `LOGIN_HINT_VISIBLE` | Shows the "Signing in with an AI assistant?" link. Set to `false` to keep only the hidden note. Until `FRONT_DOOR_URL` is set, there's no link and the note only points OAuth and MCP clients to `/auth.md`. |
| `AGENT_SESSION_COOKIE` | The cookie the front door sets once an agent is signed in. Defaults to `DS`. A request that carries it is treated as an agent even with an ordinary browser user agent, so `BLOCKED_AGENT_PATHS` still applies, and it isn't redirected from login pages again. |
| `UPSTREAM_ORIGIN` | Local testing only. Forwards to this origin instead of the request's host. |

## Headers sent to your origin

| Header | Values |
| --- | --- |
| `x-descope-agent` | `verified` or `unverified` |
| `x-descope-agent-origin` | The verified agent platform, such as `https://agent.example` |

The worker strips any incoming copies of these headers, so only the worker can set them. They're only trustworthy if your origin accepts traffic exclusively through Cloudflare.

## The front door

> **Coming soon.** Descope is building the front door, and it isn't available yet. For demos, [`demo/front-door/`](../demo/front-door/) stands in for it. Until it is, leave `FRONT_DOOR_URL` unset. Discovery, the API challenge, origin headers, the login hint, and blocked paths all work without it, so MCP and OAuth clients can already connect through the authorization code flow. This section describes how the worker will hand off to the front door once it ships.

The front door is a separate Descope-hosted service, so this worker stays small. With `FRONT_DOOR_URL` set, in route mode, agents on a login page get a `302` to `FRONT_DOOR_URL`. The redirect always includes `return_to`, and includes `agent_hint` only when `HINT_SIGNING_SECRET` is set:

| Parameter | Value |
| --- | --- |
| `return_to` | Always sent. The page the agent was trying to reach. |
| `agent_hint` | Optional. `base64url(JSON) + "." + base64url(HMAC-SHA256)`, where the JSON is `{ status, signature_agent, iat, exp }` and expires after 5 minutes. `signature_agent` is only set for agents whose Web Bot Auth signature verified. |

The front door then gets the agent a token in one of four ways:

- **Verified with Web Bot Auth, from a platform you trust.** Each trusted platform has its own inbound app, created when you add the platform to your trusted list. The front door picks the app that matches the agent's `Signature-Agent` origin.
- **Verified, from a platform you don't know.** This covers Web Bot Auth signatures from platforms not on your list, and Cloudflare-verified bots, which carry no `Signature-Agent`. These agents share one client with tighter limits.
- **Verified with a Client ID Metadata Document.** The agent's metadata URL serves as its client ID.
- **Unverified.** Agents with a rejected signature or only a user-agent match share one client with limited access. The front door gives each request its own ID, so you can trace and revoke the access granted by one request without affecting others. The ID doesn't follow an agent across requests, so it can't be used to block a specific agent.

Clients authenticate with `private_key_jwt`, not client secrets. For its own clients, the front door signs the assertions with a key only it holds, publishes the public half as a JWKS that each inbound app is registered with, and makes the token requests itself, so agents never receive client credentials. A CIMD agent signs with its own key from its metadata document instead.

Only agents from a trusted platform have their own inbound app. For them, `azp` in the token names the platform, and disabling the app cuts off that platform alone. For the two shared clients, `azp` names the shared client, not the agent's platform, and disabling one cuts off every agent that uses it.

The user approves the request from their own device through CIBA, and the token names the user as the subject and the agent as the actor. Agents that can open a browser, such as MCP clients, skip the front door and use the authorization code flow instead. See [How an agent gets a token](../README.md#how-an-agent-gets-a-token) for both flows.

## What this does and doesn't do

- **It identifies agents. It doesn't authorize them.** Limits and permissions come from the tokens Descope issues through the front door, and your app or gateway enforces them.
- **User-agent hints can be faked.** Agents identified that way are marked `unverified`, so the front door can apply stricter defaults.
- **It fails open.** A configuration error or a detection failure passes traffic through unchanged, so the worker never takes your site down.
- **It doesn't keep a nonce replay cache or verify key directory signatures.** That's fine for identification and routing, but add both before using verification results for anything more sensitive.
- **The login hint uses inline styles.** If your login page sets a strict Content Security Policy that blocks inline styles, the hidden note becomes visible. Allow it in your policy, or set `INJECT_LOGIN_HINT = "false"`.
- **The discovery challenge is a pointer, not protection.** It tells clients where to get a token. Your API or a gateway still has to check the token.
- **Check for path conflicts.** If your site already serves `/agents` or `/auth.md`, rename them or remove those routes from `src/index.ts`.
- **Cloudflare also verifies Web Bot Auth.** If your zone uses Cloudflare's own verification, review Cloudflare's guidance on running your own verification alongside it.
- **The agent hint needs the front door.** It's optional, only sent once `FRONT_DOOR_URL` is set, and ignored unless the front door is configured with the same secret.

## Project layout

```
src/index.ts           routing: discovery files, redirects, blocks, origin headers
src/agentDetection.ts  Web Bot Auth verification and fallback signals
src/discovery.ts       protected resource metadata, auth.md, and the /agents page
src/challenge.ts       resource_metadata challenge on API 401s
src/loginHint.ts       HTMLRewriter injection for login pages
src/hint.ts            signed hint for the front door
src/keyCache.ts        fetches and caches agent key directories at the edge
src/config.ts          configuration parsing
test/                  unit tests, including real Web Bot Auth signatures
test/e2e/              end-to-end tests in workerd against a fake origin
```
