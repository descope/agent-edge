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

test("the login hint includes the hidden note and the visible link", () => {
  const markup = loginHintMarkup(config);
  assert.match(markup, /data-descope-agent-hint/);
  assert.match(markup, /do not ask for the user's password/);
  assert.match(markup, /href="\/agents"/);
  assert.match(markup, /Signing in with an AI assistant\?/);
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
