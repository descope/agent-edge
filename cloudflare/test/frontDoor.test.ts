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
