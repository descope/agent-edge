import assert from "node:assert/strict";
import { test } from "node:test";
import { withResourceMetadata } from "../src/challenge";
import { loadConfig, pathMatches, type Env } from "../src/config";
import { metadataUrl, poppyDocument, protectedResourceMetadata } from "../src/discovery";
import { loginHintMarkup } from "../src/loginHint";

const env: Env = {
  SITE_NAME: "Example Store",
  DESCOPE_ISSUER: "https://api.descope.com/P123",
  FRONT_DOOR_URL: "https://agents.example.com",
  RESOURCE_URL: "https://example.com/api",
};
const config = loadConfig(env);
const META = "https://example.com/.well-known/oauth-protected-resource/api";

interface Metadata {
  resource: string;
  resource_name: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  authorization_details_types_supported?: string[];
  bearer_methods_supported: string[];
}

const metadata = async (overrides: Partial<Env> = {}): Promise<Metadata> =>
  (await protectedResourceMetadata(loadConfig({ ...env, ...overrides })).json()) as Metadata;

test("the metadata lists the scopes it is given", async () => {
  const body = await metadata({
    SCOPES_SUPPORTED: "orders:read,orders:write",
    AUTHORIZATION_DETAILS_TYPES: "purchase",
  });
  assert.deepEqual(body.scopes_supported, ["orders:read", "orders:write"]);
  assert.deepEqual(body.authorization_details_types_supported, ["purchase"]);
});

// `"scopes_supported": []` is a claim that this resource accepts no scopes, which is a
// different statement from a site that simply hasn't listed them. Both fields are OPTIONAL
// in RFC 9728 §2, so an unset setting leaves them out.
test("the metadata omits scope lists rather than publishing them empty", async () => {
  const body = await metadata();
  assert.equal("scopes_supported" in body, false);
  assert.equal("authorization_details_types_supported" in body, false);
  // Everything required is still there.
  assert.equal(body.resource, "https://example.com/api");
  assert.deepEqual(body.authorization_servers, ["https://api.descope.com/P123"]);
  assert.deepEqual(body.bearer_methods_supported, ["header"]);
});

test("metadata URL follows RFC 9728 path insertion", () => {
  assert.equal(metadataUrl(config), META);
  assert.equal(
    metadataUrl(loadConfig({ ...env, RESOURCE_URL: "https://example.com" })),
    "https://example.com/.well-known/oauth-protected-resource",
  );
  assert.equal(
    metadataUrl(loadConfig({ ...env, RESOURCE_URL: "https://example.com/api/" })),
    META,
  );
});

interface Poppy {
  protocol_version: string;
  organization: { name: string; domain: string };
  auth: {
    issuer: string;
    scopes?: Record<string, string>;
    scope_hints?: Record<string, { changes: string; personal_data: boolean }>;
  };
  web: Record<string, unknown>;
  apis?: { type: string; url: string; description?: string }[];
}

const SITE = new URL("https://example.com/.well-known/poppy.json");

const poppy = async (overrides: Partial<Env> = {}, url = SITE): Promise<Poppy> =>
  (await poppyDocument(loadConfig({ ...env, ...overrides }), url).json()) as Poppy;

test("the Poppy document names the site and the configured issuer", async () => {
  const response = poppyDocument(config, SITE);
  assert.equal(response.headers.get("content-type"), "application/json");
  const body = (await response.json()) as Poppy;
  assert.deepEqual(body, {
    protocol_version: "0.4",
    organization: { name: "Example Store", domain: "example.com" },
    auth: { issuer: "https://api.descope.com/P123" },
    web: {},
  });
});

// Pre-1.0 the match has to be exact (3.4), so an agent on 0.4 refuses a 0.3 document
// rather than reading it and ignoring what it doesn't know. Nothing else in this file
// matters if this is wrong.
test("the Poppy document declares draft 0.4", async () => {
  assert.equal((await poppy()).protocol_version, "0.4");
});

// 0.1 advertised Device Sign-In here. 0.4 takes it from the authorization server's
// grant_types_supported instead, so restating it would be inventing a field.
test("the Poppy document carries no auth.device", async () => {
  assert.equal("device" in (await poppy()).auth, false);
});

test("the Poppy issuer is the one the protected resource metadata names", async () => {
  const custom = { DESCOPE_ISSUER: "https://auth.example.com/v1/apps/P123" };
  assert.equal((await poppy(custom)).auth.issuer, loadConfig({ ...env, ...custom }).issuer);
});

test("the Poppy domain comes from RESOURCE_URL, and SITE_DOMAIN overrides it", async () => {
  assert.equal((await poppy({ RESOURCE_URL: "https://api.example.com/v2" })).organization.domain, "api.example.com");
  assert.equal((await poppy({ SITE_DOMAIN: "example.com" })).organization.domain, "example.com");
});

test("scope descriptions and hints are published when set", async () => {
  const body = await poppy({
    POPPY_SCOPES: '{"orders:read": "See your orders", "orders:write": "Place an order"}',
    POPPY_SCOPE_HINTS: '{"orders:read": {"changes": "none", "personal_data": true}}',
  });
  assert.deepEqual(body.auth.scopes, {
    "orders:read": "See your orders",
    "orders:write": "Place an order",
  });
  assert.deepEqual(body.auth.scope_hints, { "orders:read": { changes: "none", personal_data: true } });
});

// Absent beats empty: `scopes: {}` would claim the site describes its scopes and then
// describe none of them.
test("scope fields are omitted rather than sent empty", async () => {
  const body = await poppy();
  assert.equal("scopes" in body.auth, false);
  assert.equal("scope_hints" in body.auth, false);
  assert.equal("scopes" in (await poppy({ POPPY_SCOPES: "{}" })).auth, false);
});

// Same bargain POPPY_APIS makes: one unusable setting costs that field, not the document.
test("unusable scope settings are dropped, not served", async () => {
  assert.equal("scopes" in (await poppy({ POPPY_SCOPES: "not json" })).auth, false);
  assert.equal("scopes" in (await poppy({ POPPY_SCOPES: '["orders:read"]' })).auth, false);

  // A hint an agent cannot read is worse than no hint: it reads as a claim about risk.
  const bad = await poppy({
    POPPY_SCOPE_HINTS: '{"a": {"changes": "sometimes", "personal_data": true}, "b": {"changes": "none"}, "c": {"changes": "none", "personal_data": false}}',
  });
  assert.deepEqual(bad.auth.scope_hints, { c: { changes: "none", personal_data: false } });
});

test("advertised APIs carry a type and resolve against the host that was asked", async () => {
  const POPPY_APIS = '[{"url": "/openapi.json", "description": "Buy things"}]';
  assert.deepEqual((await poppy({ POPPY_APIS })).apis, [
    { type: "openapi", url: "https://example.com/openapi.json", description: "Buy things" },
  ]);
  // The same document asked for on www names www, so it stays on the opener's own origin.
  const onWww = await poppy({ POPPY_APIS }, new URL("https://www.example.com/.well-known/poppy.json"));
  assert.equal(onWww.apis?.[0].url, "https://www.example.com/openapi.json");
});

test("an absolute API URL and an explicit type are kept", async () => {
  const apis = (await poppy({
    POPPY_APIS: '[{"type": "mcp", "url": "https://api.example.com/mcp"}]',
  })).apis;
  assert.deepEqual(apis, [{ type: "mcp", url: "https://api.example.com/mcp" }]);
});

test("a broken POPPY_APIS costs the apis list, not the document", async () => {
  for (const POPPY_APIS of ["{", '{"url": "/x"}', "[]", '[{"description": "no url"}]']) {
    const body = await poppy({ POPPY_APIS });
    assert.equal(body.apis, undefined, POPPY_APIS);
    assert.equal(body.auth.issuer, "https://api.descope.com/P123", POPPY_APIS);
  }
  // One unusable entry doesn't take the usable ones with it.
  assert.equal((await poppy({ POPPY_APIS: '[{"url": "/ok"}, {"url": 7}]' })).apis?.length, 1);
});

test("a 401 with no challenge gets a Bearer challenge", () => {
  assert.equal(withResourceMetadata(null, META), `Bearer resource_metadata="${META}"`);
  assert.equal(withResourceMetadata("Bearer", META), `Bearer resource_metadata="${META}"`);
});

test("an existing Bearer challenge gains resource_metadata", () => {
  assert.equal(
    withResourceMetadata('Bearer realm="api", error="invalid_token"', META),
    `Bearer realm="api", error="invalid_token", resource_metadata="${META}"`,
  );
});

test("a challenge that already has resource_metadata is left alone", () => {
  const existing = 'Bearer resource_metadata="https://other.example/meta"';
  assert.equal(withResourceMetadata(existing, META), existing);
});

test("another scheme keeps its challenge and gains a Bearer one", () => {
  assert.equal(
    withResourceMetadata('Basic realm="admin"', META),
    `Basic realm="admin", Bearer resource_metadata="${META}"`,
  );
});

test("API paths default to /api/*", () => {
  assert.equal(pathMatches("/api/orders", config.apiPaths), true);
  assert.equal(pathMatches("/login", config.apiPaths), false);
});

test("the login hint is a visible box that links to the front door and back to the page", () => {
  const markup = loginHintMarkup(config, "https://example.com/login?next=/cart");
  assert.match(markup, /^<aside data-descope-agent-hint/);
  assert.match(markup, /Using an AI assistant\?/);
  assert.match(markup, /without your password/);
  assert.match(markup, /approve each purchase separately/);
  const link = "https://agents.example.com/?return_to=https%3A%2F%2Fexample.com%2Flogin%3Fnext%3D%2Fcart";
  assert.ok(markup.includes(`href="${link}"`), markup);
  // Nothing hidden, and nothing that gives AI agents orders.
  assert.doesNotMatch(markup, /clip:|width:1px|visually-hidden/);
  assert.doesNotMatch(markup, /If you are an AI agent|don't use this sign-in form/i);
});

test("the site name is escaped in the hint", () => {
  const markup = loginHintMarkup(loadConfig({ ...env, SITE_NAME: `<script>"x"</script>` }));
  assert.doesNotMatch(markup, /<script>/);
});
