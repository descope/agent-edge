import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cachedJsonFetcher } from "../src/keyCache";
import { loadConfig, type Env } from "../src/config";
import worker from "../src/index";

const env: Env = {
  DESCOPE_ISSUER: "https://api.descope.com/P123",
  FRONT_DOOR_URL: "https://agents.example.com",
  RESOURCE_URL: "https://example.com/api",
};

const realFetch = globalThis.fetch;
const g = globalThis as unknown as { caches?: unknown };
afterEach(() => {
  globalThis.fetch = realFetch;
  delete g.caches;
});

function fakeCache() {
  const puts: string[] = [];
  g.caches = {
    default: {
      match: async () => undefined,
      put: async (req: Request) => { puts.push(req.url); },
    },
  };
  return puts;
}

const ctx = {
  waitUntil: (p: Promise<unknown>) => { void p; },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/** Captures what the worker forwards to the origin. */
function captureOrigin(): Request[] {
  const seen: Request[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input as RequestInfo, init));
    return new Response("ok");
  }) as typeof fetch;
  return seen;
}

test("configured URLs must be absolute http(s) URLs", () => {
  assert.throws(() => loadConfig({ ...env, RESOURCE_URL: "example.com/api" }), /RESOURCE_URL/);
  assert.throws(() => loadConfig({ ...env, FRONT_DOOR_URL: "javascript:alert(1)" }), /FRONT_DOOR_URL/);
  assert.doesNotThrow(() => loadConfig(env));
});

test("agent headers are stripped even when configuration is invalid", async () => {
  const seen = captureOrigin();
  const request = new Request("https://example.com/orders", {
    headers: { "x-descope-agent": "verified", "x-descope-agent-origin": "https://chatgpt.com" },
  });
  await worker.fetch(request as never, { ...env, DESCOPE_ISSUER: "https://api.descope.com/YOUR_PROJECT_ID" }, ctx);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.get("x-descope-agent"), null);
  assert.equal(seen[0].headers.get("x-descope-agent-origin"), null);
});

test("a rejected signature doesn't forward the claimed agent origin", async () => {
  fakeCache();
  const seen = captureOrigin();
  const request = new Request("https://example.com/orders", {
    headers: {
      "Signature-Agent": 'sig1="https://chatgpt.com";type=directory',
      "Signature-Input": 'sig1=("@authority");created=1;keyid="x";tag="web-bot-auth"',
      Signature: "sig1=:AAAA:",
    },
  });
  await worker.fetch(request as never, env, ctx);
  const forwarded = seen.at(-1)!;
  assert.equal(forwarded.headers.get("x-descope-agent"), "unverified");
  assert.equal(forwarded.headers.get("x-descope-agent-origin"), null);
});

test("an oversized key directory is rejected without buffering it all", async () => {
  fakeCache();
  let pulled = 0;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(16_000).fill(32));
      if (pulled > 1000) controller.close();
    },
  }))) as typeof fetch;
  await assert.rejects(cachedJsonFetcher(ctx)("https://agent.test/dir"), /too large/);
  assert.ok(pulled < 20, `read ${pulled} chunks`);
});

test("a key directory that isn't JSON is not cached", async () => {
  const puts = fakeCache();
  globalThis.fetch = (async () => new Response("<html>error</html>")) as typeof fetch;
  await assert.rejects(cachedJsonFetcher(ctx)("https://agent.test/dir"));
  assert.deepEqual(puts, []);
});

test("key directory redirects are not followed", async () => {
  fakeCache();
  let init: RequestInit | undefined;
  globalThis.fetch = (async (_: unknown, i?: RequestInit) => {
    init = i;
    return new Response(null, { status: 302, headers: { location: "http://evil.test/" } });
  }) as typeof fetch;
  await assert.rejects(cachedJsonFetcher(ctx)("https://agent.test/dir"), /302/);
  assert.equal(init?.redirect, "manual");
});
