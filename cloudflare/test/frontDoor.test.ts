import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadConfig, type Env } from "../src/config";
import { agentsPage, authMd } from "../src/discovery";
import worker from "../src/index";

// The hosted front door isn't available yet, so everything else has to work without it.
const env: Env = {
  DESCOPE_ISSUER: "https://api.descope.com/P123",
  RESOURCE_URL: "https://example.com/api",
  MODE: "route",
  LOGIN_PATHS: "/login",
  AGENT_USER_AGENT_PATTERNS: "HeadlessChrome",
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const agentLogin = () =>
  new Request("https://example.com/login", { headers: { "user-agent": "HeadlessChrome/126.0" } });

test("the front door URL is optional", () => {
  assert.equal(loadConfig(env).frontDoorUrl, undefined);
});

test("auth.md and /agents don't mention a front door that isn't configured", async () => {
  const config = loadConfig(env);
  const md = await authMd(config).text();
  assert.doesNotMatch(md, /start a connection/);
  assert.match(md, /oauth-protected-resource/);
  const html = await agentsPage(config).text();
  assert.doesNotMatch(html, /Connect your agent/);
  assert.match(html, /auth\.md/);
});

test("without a front door, agents on login pages pass through in route mode", async () => {
  const forwarded: Request[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    forwarded.push(new Request(input as RequestInfo, init));
    return new Response("ok");
  }) as typeof fetch;
  const response = await worker.fetch(agentLogin() as never, env, ctx);
  assert.equal(response.status, 200);
  assert.equal(forwarded.length, 1);
  // Set only when the worker ran, not when it failed open on bad configuration.
  assert.equal(forwarded[0].headers.get("x-descope-agent"), "unverified");
});

test("with a front door, agents on login pages are redirected in route mode", async () => {
  const response = await worker.fetch(agentLogin() as never, { ...env, FRONT_DOOR_URL: "https://agents.example.com" }, ctx);
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location") ?? "", /^https:\/\/agents\.example\.com\//);
});

test("without a front door, the login hint doesn't send agents away from the form", async () => {
  const { loginHintMarkup } = await import("../src/loginHint");
  const markup = loginHintMarkup(loadConfig(env));
  assert.doesNotMatch(markup, /do not use this sign-in form/);
  assert.doesNotMatch(markup, /data-descope-agent-link/);
  assert.match(markup, /\/auth\.md/);
});

test("with a front door, the login hint points agents to /agents", async () => {
  const { loginHintMarkup } = await import("../src/loginHint");
  const markup = loginHintMarkup(loadConfig({ ...env, FRONT_DOOR_URL: "https://agents.example.com" }));
  assert.match(markup, /do not use this sign-in form/);
  assert.match(markup, /data-descope-agent-link/);
});

test("without a front door, /agents tells people what to do", async () => {
  const html = await agentsPage(loadConfig(env)).text();
  const visible = html.replace(/<section class="visually-hidden"[\s\S]*?<\/section>/, "");
  assert.doesNotMatch(visible, /Connect it here/);
  assert.match(visible, /assistant's settings/);
});

test("an agent that already has a session cookie isn't sent back to the front door", async () => {
  const forwarded: Request[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    forwarded.push(new Request(input as RequestInfo, init));
    return new Response("ok");
  }) as typeof fetch;
  const signedIn = new Request("https://example.com/login", {
    headers: { "user-agent": "HeadlessChrome/126.0", cookie: "theme=dark; DS=eyJhbGciOi.payload.sig" },
  });
  const response = await worker.fetch(signedIn as never, { ...env, FRONT_DOOR_URL: "https://agents.example.com" }, ctx);
  assert.equal(response.status, 200);
  assert.equal(forwarded.length, 1);

  // A custom cookie name works too, and a cookie that merely ends in "DS" doesn't count.
  const renamed = new Request("https://example.com/login", {
    headers: { "user-agent": "HeadlessChrome/126.0", cookie: "agent_at=x" },
  });
  const custom = await worker.fetch(renamed as never, { ...env, FRONT_DOOR_URL: "https://agents.example.com", AGENT_SESSION_COOKIE: "agent_at" }, ctx);
  assert.equal(custom.status, 200);
  const lookalike = new Request("https://example.com/login", {
    headers: { "user-agent": "HeadlessChrome/126.0", cookie: "XDS=x" },
  });
  const notSignedIn = await worker.fetch(lookalike as never, { ...env, FRONT_DOOR_URL: "https://agents.example.com" }, ctx);
  assert.equal(notSignedIn.status, 302);
});

test("a request with the agent session cookie is blocked from agent-blocked paths, even with a browser user agent", async () => {
  let forwarded = 0;
  globalThis.fetch = (async () => { forwarded++; return new Response("ok"); }) as typeof fetch;
  const request = new Request("https://example.com/account/payment-methods", {
    method: "POST",
    headers: { "user-agent": "Mozilla/5.0 (Macintosh) Chrome/154.0", cookie: "DS=eyJhbGciOi.payload.sig" },
  });
  const response = await worker.fetch(request as never, { ...env, BLOCKED_AGENT_PATHS: "/account/payment-methods*" }, ctx);
  assert.equal(response.status, 403);
  assert.equal(forwarded, 0);

  // The same request from a person (no agent cookie) goes through.
  const person = new Request("https://example.com/account/payment-methods", {
    method: "POST",
    headers: { "user-agent": "Mozilla/5.0 (Macintosh) Chrome/154.0" },
  });
  assert.equal((await worker.fetch(person as never, { ...env, BLOCKED_AGENT_PATHS: "/account/payment-methods*" }, ctx)).status, 200);
});

test("/agents passes a recognized agent's signed hint through the Connect button", async () => {
  const withDoor = { ...env, FRONT_DOOR_URL: "https://agents.example.com", HINT_SIGNING_SECRET: "hint-secret" };
  const agentReq = new Request("https://example.com/agents", { headers: { "user-agent": "HeadlessChrome/126.0" } });
  const html = await (await worker.fetch(agentReq as never, withDoor, ctx)).text();
  const href = html.match(/<a class="button" href="([^"]+)"/)?.[1].replace(/&#38;/g, "&");
  assert.ok(href, "button present");
  const link = new URL(href!);
  assert.equal(link.origin, "https://agents.example.com");
  assert.ok(link.searchParams.get("agent_hint"), "hint attached");
  assert.equal(link.searchParams.get("return_to"), "https://example.com/");

  // People get the plain link.
  const personReq = new Request("https://example.com/agents", { headers: { "user-agent": "Mozilla/5.0 Safari/605.1.15" } });
  const personHtml = await (await worker.fetch(personReq as never, withDoor, ctx)).text();
  assert.doesNotMatch(personHtml, /agent_hint/);
});

test("auth.md tells agents without a browser how to use the front door", async () => {
  const md = await authMd(loadConfig({ ...env, FRONT_DOOR_URL: "https://agents.example.com" })).text();
  assert.match(md, /POST https:\/\/agents\.example\.com\/connect/);
  assert.match(md, /status_url/);
});

test("auth.md is also served at /.well-known/auth.md", async () => {
  globalThis.fetch = (async () => { throw new Error("should not reach the origin"); }) as typeof fetch;
  const response = await worker.fetch(new Request("https://example.com/.well-known/auth.md") as never, env, ctx);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/markdown/);
  assert.match(await response.text(), /# Authentication for AI agents/);
});

test("a request that loops back to the worker fails fast with a hint about UPSTREAM_ORIGIN", async () => {
  let calls = 0;
  // Simulate wrangler dev with no origin: forwarding sends the request straight back to the worker.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    if (calls > 5) throw new Error("looped");
    return worker.fetch(new Request(input as RequestInfo, init) as never, env, ctx);
  }) as typeof fetch;
  const response = await worker.fetch(new Request("https://example.com/") as never, env, ctx);
  assert.equal(response.status, 508);
  assert.match(await response.text(), /UPSTREAM_ORIGIN/);
  assert.ok(calls <= 2, `forwarded ${calls} times`);
});
