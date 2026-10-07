// End-to-end test: runs the worker in workerd (via `wrangler dev`) in front of a
// fake origin, so HTMLRewriter and response handling run in the real runtime.
// Run with: npm run test:e2e
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

const WORKER_PORT = 8799;
const BASE = `http://localhost:${WORKER_PORT}`;
const LOGIN_HTML = "<!doctype html><html><head><title>Sign in</title></head><body><form>Email</form></body></html>";

let origin: Server;
let worker: ChildProcess;

before(async () => {
  origin = createServer((req, res) => {
    if (req.url === "/login" || req.url === "/about") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(LOGIN_HTML);
    } else if (req.url === "/api/orders") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":"unauthorized"}');
    } else if (req.url === "/api/legacy") {
      res.writeHead(401, { "www-authenticate": 'Bearer realm="api"' });
      res.end();
    } else if (req.url === "/api/public") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
    } else if (req.url === "/account/settings") {
      res.writeHead(401);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = (origin.address() as AddressInfo).port;

  worker = spawn(
    "npx",
    [
      "wrangler", "dev", "--port", String(WORKER_PORT),
      "--var", "DESCOPE_ISSUER:https://api.descope.com/P123",
      "--var", `UPSTREAM_ORIGIN:http://127.0.0.1:${originPort}`,
      "--var", "MODE:monitor",
    ],
    { stdio: "ignore" },
  );

  // Wait for the worker to come up.
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("worker did not start");
});

after(() => {
  worker?.kill();
  origin?.close();
});

test("a 401 from an API path gains the resource_metadata challenge", async () => {
  const res = await fetch(`${BASE}/api/orders`);
  assert.equal(res.status, 401);
  assert.equal(
    res.headers.get("www-authenticate"),
    'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource/api"',
  );
  assert.equal(await res.text(), '{"error":"unauthorized"}');
});

test("an existing Bearer challenge keeps its realm", async () => {
  const res = await fetch(`${BASE}/api/legacy`);
  assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer realm="api", resource_metadata="/);
});

test("successful API responses are untouched", async () => {
  const res = await fetch(`${BASE}/api/public`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("www-authenticate"), null);
});

test("401s outside the API paths are untouched", async () => {
  const res = await fetch(`${BASE}/account/settings`);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), null);
});

test("without a front door, the login page is left as it is", async () => {
  const html = await (await fetch(`${BASE}/login`)).text();
  assert.equal(html, LOGIN_HTML);
});
test("other pages are left alone", async () => {
  const html = await (await fetch(`${BASE}/about`)).text();
  assert.equal(html, LOGIN_HTML);
});

test("path-specific protected resource metadata is served", async () => {
  const res = await fetch(`${BASE}/.well-known/oauth-protected-resource/api`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { resource: string; authorization_servers: string[] };
  assert.equal(body.resource, "https://example.com/api");
  assert.deepEqual(body.authorization_servers, ["https://api.descope.com/P123"]);
});
