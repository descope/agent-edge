# agent-ready

Edge integrations that make a website ready for AI agents with [Descope](https://www.descope.com), without changing the app behind it.

Each integration runs in front of a site and does the same jobs:

- Verifies AI agents with Web Bot Auth, falling back to platform bot signals and user-agent hints.
- Serves discovery files (`/.well-known/oauth-protected-resource`, `/auth.md`, `/agents`) that point agents at a Descope authorization server.
- Adds a `resource_metadata` `WWW-Authenticate` challenge to API 401s so MCP and OAuth clients find Descope on their own.
- Adds an agent hint to login pages and routes agents to a Descope-hosted front door.

Integrations start in monitor mode and fail open, so they can be deployed safely before they change any traffic.

## Platforms

| Platform | Folder | Status |
| --- | --- | --- |
| Cloudflare Workers | [`cloudflare/`](cloudflare/) | Available |
| Vercel | — | Planned |
| Amazon CloudFront | — | Planned |

Each platform folder is a self-contained project with its own dependencies, tests, and README. Code is not shared between platforms yet; a common core may be extracted once a second platform exists.
