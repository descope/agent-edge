import assert from "node:assert/strict";
import { test } from "node:test";
import { withResourceMetadata } from "../src/challenge";
import { loadConfig, pathMatches, type Env } from "../src/config";
import {
  isResourceMetadataPath,
  metadataUrl,
  poppyCanonicalRedirect,
  poppyDocument,
  protectedResourceMetadata,
  requestedResource,
  versionedPoppyPath,
} from "../src/discovery";
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

// The API's own document, at the path metadataUrl computes for RESOURCE_URL.
const metadata = async (overrides: Partial<Env> = {}): Promise<Metadata> =>
  (await protectedResourceMetadata(loadConfig({ ...env, ...overrides }), new URL(META)).json()) as Metadata;

// The site's own document, at the bare path, which is the one Poppy derives and checks.
const siteMetadata = async (origin: string, overrides: Partial<Env> = {}): Promise<Metadata> =>
  (await protectedResourceMetadata(
    loadConfig({ ...env, ...overrides }),
    new URL(`${origin}/.well-known/oauth-protected-resource`),
  ).json()) as Metadata;

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

// The regression this file exists to hold: Poppy 0.4 section 3.2 builds this URL from
// `organization.domain` and RFC 9728 section 3.3 makes the document declare that same URL.
// Answering here with RESOURCE_URL is what made agents refuse northbound.camp's document.
test("the bare well-known path names the host that served it", async () => {
  assert.equal((await siteMetadata("https://example.com")).resource, "https://example.com");
  // Served on another host, it speaks for that host, not for the one in RESOURCE_URL.
  assert.equal((await siteMetadata("https://www.example.com")).resource, "https://www.example.com");
  assert.equal((await siteMetadata("http://localhost:8787")).resource, "http://localhost:8787");
});

test("the site's document links the domain to the same issuer, with the same scopes", async () => {
  const overrides = { SCOPES_SUPPORTED: "orders:read,orders:write" };
  const site = await siteMetadata("https://example.com", overrides);
  const api = await metadata(overrides);
  assert.deepEqual(site.authorization_servers, api.authorization_servers);
  assert.deepEqual(site.scopes_supported, ["orders:read", "orders:write"]);
  assert.equal(site.resource_name, "Example Store");
  // Only the resource differs, which is the whole point of serving two.
  assert.notEqual(site.resource, api.resource);
});

test("the API's own path still names RESOURCE_URL", async () => {
  assert.equal((await metadata()).resource, "https://example.com/api");
});

test("a path for a resource this worker doesn't serve is a 404", async () => {
  const notOurs = async (url: string) =>
    protectedResourceMetadata(config, new URL(url)).status;
  assert.equal(await notOurs("https://example.com/.well-known/oauth-protected-resource/nonsense"), 404);
  // The API lives on example.com; the same path on another host asks about another resource.
  assert.equal(await notOurs("https://other.example/.well-known/oauth-protected-resource/api"), 404);
});

test("a trailing slash asks about the same resource", () => {
  const bare = "https://example.com/.well-known/oauth-protected-resource";
  assert.equal(requestedResource(new URL(`${bare}/`)), "https://example.com");
  assert.equal(requestedResource(new URL(`${bare}/api/`)), "https://example.com/api");
});

test("the metadata paths are the bare one and everything under it", () => {
  assert.equal(isResourceMetadataPath("/.well-known/oauth-protected-resource"), true);
  assert.equal(isResourceMetadataPath("/.well-known/oauth-protected-resource/api"), true);
  assert.equal(isResourceMetadataPath("/.well-known/oauth-protected-resource-other"), false);
  assert.equal(isResourceMetadataPath("/.well-known/poppy.json"), false);
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

const redirect = (host: string, overrides: Partial<Env> = {}) =>
  poppyCanonicalRedirect(
    loadConfig({ ...env, SITE_DOMAIN: "example.com", ...overrides }),
    new URL(`https://${host}/.well-known/poppy.json`),
  );

// The document names one domain. Served from another host it fails 3.1's check that
// organization.domain is the host that served it, and an agent refuses it.
test("a subdomain redirects to the domain the document names", () => {
  const res = redirect("www.example.com");
  assert.equal(res?.status, 301);
  assert.equal(res?.headers.get("location"), "https://example.com/.well-known/poppy.json");
});

test("the domain itself serves the document rather than redirecting", () => {
  assert.equal(redirect("example.com"), undefined);
});

// A worker on a staging domain, or on localhost under `wrangler dev`, must not bounce
// agents to production.
test("an unrelated host is left alone", () => {
  assert.equal(redirect("localhost:8787"), undefined);
  assert.equal(redirect("staging.example.net"), undefined);
  assert.equal(redirect("notexample.com"), undefined);
});

test("host comparison ignores case", () => {
  assert.equal(redirect("WWW.Example.COM")?.status, 301);
  assert.equal(redirect("EXAMPLE.com"), undefined);
});

test("deeper subdomains come home too", () => {
  assert.equal(
    redirect("shop.eu.example.com")?.headers.get("location"),
    "https://example.com/.well-known/poppy.json",
  );
});

const SERVED = new URL("https://example.com/.well-known/poppy.json");
const withVersions = (v: string) => loadConfig({ ...env, SITE_DOMAIN: "example.com", SUPPORTED_VERSIONS: v });
const docFor = async (cfg: ReturnType<typeof loadConfig>, version?: string) =>
  (await poppyDocument(cfg, SERVED, version).json()) as Poppy & {
    supported_versions?: Record<string, string>;
  };

test("the preferred document links the older versions it also serves", async () => {
  const body = await docFor(withVersions("0.3"));
  assert.equal(body.protocol_version, "0.4");
  assert.deepEqual(body.supported_versions, {
    "0.3": "https://example.com/poppy/0.3.json",
  });
});

// 3.4: the linked document has the version it is listed under, and no supported_versions
// of its own — otherwise an agent could walk a chain of them.
test("an older document names its own version and links nothing", async () => {
  const body = await docFor(withVersions("0.3"), "0.3");
  assert.equal(body.protocol_version, "0.3");
  assert.equal("supported_versions" in body, false);
});

// 3.4: every document served at the same time must agree on these two, or the Company's
// identifier changes with the version and User IDs stop meaning the same thing.
test("both documents name the same domain and the same issuer", async () => {
  const cfg = withVersions("0.3");
  const current = await docFor(cfg);
  const older = await docFor(cfg, "0.3");
  assert.equal(current.organization.domain, older.organization.domain);
  assert.equal(current.auth.issuer, older.auth.issuer);
});

test("no supported_versions key when nothing older is served", async () => {
  assert.equal("supported_versions" in (await docFor(withVersions(""))), false);
});

// The URL must be on the host that served poppy.json, so an uploaded file elsewhere
// cannot be linked in as this Company's document.
test("the linked URL sits on the host that served the document", async () => {
  const body = await docFor(withVersions("0.3"));
  assert.equal(new URL(body.supported_versions!["0.3"]).host, SERVED.host);
});

test("unusable version entries are dropped", async () => {
  assert.deepEqual(withVersions("0.3, 0.2").supportedVersions, ["0.3", "0.2"]);
  // Not major.minor.
  assert.deepEqual(withVersions("nonsense,0.3.1,v0.3").supportedVersions, []);
  // A document cannot be an older alternative to itself.
  assert.deepEqual(withVersions("0.4").supportedVersions, []);
  // Repeats collapse.
  assert.deepEqual(withVersions("0.3,0.3").supportedVersions, ["0.3"]);
});

test("the versioned path is derived from the version", () => {
  assert.equal(versionedPoppyPath("0.3"), "/poppy/0.3.json");
});
