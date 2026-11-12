import assert from "node:assert/strict";
import { test } from "node:test";
import { withResourceMetadata } from "../src/challenge";
import { loadConfig, pathMatches, type Env } from "../src/config";
import { metadataUrl, protectedResourceMetadata } from "../src/discovery";
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
