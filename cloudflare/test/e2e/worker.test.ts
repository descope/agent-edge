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
// Only the site serves this. A /poppy/ path that comes back with it reached the origin;
// the worker has no way to produce it, and the origin's 404 is not it either.
const ORIGIN_POPPY = '{"served_by":"the site"}';

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
    } else if (req.url?.startsWith("/poppy/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(ORIGIN_POPPY);
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
      // The API lives on the host the worker is serving, as it does in production: a document
      // is only served where the resource it names actually is.
      "--var", `RESOURCE_URL:${BASE}/api`,
      "--var", 'POPPY_APIS:[{"url": "/openapi.json", "description": "Buy things"}]',
      "--var", "SUPPORTED_VERSIONS:0.3",
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
    `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/api"`,
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
  assert.equal(body.resource, `${BASE}/api`);
  assert.deepEqual(body.authorization_servers, ["https://api.descope.com/P123"]);
});

// What a Personal Agent fetches: it derives this URL from the Poppy document's
// organization.domain and refuses a document that names anything else.
test("the bare metadata path names the host that served it", async () => {
  const res = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { resource: string; authorization_servers: string[] };
  assert.equal(body.resource, BASE);
  assert.deepEqual(body.authorization_servers, ["https://api.descope.com/P123"]);
});

test("a metadata path for some other resource is a 404, not a wrong document", async () => {
  const res = await fetch(`${BASE}/.well-known/oauth-protected-resource/nonsense`);
  assert.equal(res.status, 404);
});

test("the Poppy discovery document is served at the edge", async () => {
  const res = await fetch(`${BASE}/.well-known/poppy.json`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  const body = (await res.json()) as {
    protocol_version: string;
    auth: { issuer: string };
    apis: { type: string; url: string }[];
    supported_versions: Record<string, string>;
  };
  assert.equal(body.protocol_version, "0.4");
  assert.equal(body.auth.issuer, "https://api.descope.com/P123");
  // Resolved against the host the request came in on, which here is the worker's own.
  assert.deepEqual(body.apis, [
    { type: "openapi", url: `${BASE}/openapi.json`, description: "Buy things" },
  ]);
  // Section 3.4's cross-link, on the host that served this document.
  assert.deepEqual(body.supported_versions, { "0.3": `${BASE}/poppy/0.3.json` });
});

test("other .well-known paths still reach the origin", async () => {
  // The worker claims two paths under /.well-known, not the whole prefix, so a site can
  // serve its own files there.
  assert.equal((await fetch(`${BASE}/.well-known/change-password`)).status, 404);
});

test("a listed older draft is served by the worker, not by the site", async () => {
  const res = await fetch(`${BASE}/poppy/0.3.json`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.notEqual(text, ORIGIN_POPPY);
  const body = JSON.parse(text) as { protocol_version: string; supported_versions?: unknown };
  assert.equal(body.protocol_version, "0.3");
  // The older document is a leaf: it links nothing, so there is no chain to walk.
  assert.equal("supported_versions" in body, false);
});

// The routing matches only the versions SUPPORTED_VERSIONS lists. Without this, an `else`
// or a reordering in the discovery block could start answering for versions this worker
// never named, and every other test here would still pass.
test("a version-shaped path that isn't listed reaches the site", async () => {
  const res = await fetch(`${BASE}/poppy/0.2.json`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), ORIGIN_POPPY);
});

test("a /poppy/ path that isn't a version at all reaches the site", async () => {
  const res = await fetch(`${BASE}/poppy/nonsense.json`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), ORIGIN_POPPY);
});
