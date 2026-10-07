import assert from "node:assert/strict";
import { test } from "node:test";
import { withResourceMetadata } from "../src/challenge";
import { loadConfig, pathMatches, type Env } from "../src/config";
import { metadataUrl } from "../src/discovery";
import { loginHintMarkup } from "../src/loginHint";

const env: Env = {
  SITE_NAME: "Example Store",
  DESCOPE_ISSUER: "https://api.descope.com/P123",
  FRONT_DOOR_URL: "https://agents.example.com",
  RESOURCE_URL: "https://example.com/api",
};
const config = loadConfig(env);
const META = "https://example.com/.well-known/oauth-protected-resource/api";

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

test("the login hint sends agents straight to the front door and back to the page", () => {
  const markup = loginHintMarkup(config, "https://example.com/login?next=/cart");
  assert.match(markup, /data-descope-agent-hint/);
  assert.match(markup, /Don't ask for their password/);
  assert.match(markup, /approve read-only access on their own device/);
  assert.match(markup, /approve each purchase separately/);
  const link = "https://agents.example.com/?return_to=https%3A%2F%2Fexample.com%2Flogin%3Fnext%3D%2Fcart";
  assert.ok(markup.includes(`Ask them, then go to ${link.replace(/&/g, "&#38;")}`), markup);
  assert.ok(markup.includes(`href="${link}"`), markup);
  assert.match(markup, /Signing in with an AI assistant\?/);
  assert.doesNotMatch(markup, /href="\/agents"/);
});

test("the visible link can be turned off", () => {
  const markup = loginHintMarkup(loadConfig({ ...env, LOGIN_HINT_VISIBLE: "false" }));
  assert.match(markup, /data-descope-agent-hint/);
  assert.doesNotMatch(markup, /data-descope-agent-link/);
});

test("the site name is escaped in the hint", () => {
  const markup = loginHintMarkup(loadConfig({ ...env, SITE_NAME: `<script>"x"</script>` }));
  assert.doesNotMatch(markup, /<script>/);
});
