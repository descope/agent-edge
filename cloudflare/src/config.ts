export interface Env {
  MODE?: string;
  SITE_NAME?: string;
  DESCOPE_ISSUER: string;
  /** The agent front door. Optional. */
  FRONT_DOOR_URL?: string;
  RESOURCE_URL: string;
  /** The organization's domain in the Poppy document. Defaults to the RESOURCE_URL host. */
  SITE_DOMAIN?: string;
  SCOPES_SUPPORTED?: string;
  /** Scopes the Poppy document asks agents to request in the device flow. Defaults to openid. */
  POPPY_SCOPES?: string;
  POPPY_SCOPE_HINTS?: string;
  /**
   * The APIs the Poppy document advertises, as a JSON array. Each entry needs a url, which may
   * be a path on your own site, and may carry a type (default "openapi") and a description:
   * [{"url": "/openapi.json", "description": "Browse and buy"}]
   */
  POPPY_APIS?: string;
  SUPPORTED_VERSIONS?: string;
  AUTHORIZATION_DETAILS_TYPES?: string;
  LOGIN_PATHS?: string;
  BLOCKED_AGENT_PATHS?: string;
  AGENT_USER_AGENT_PATTERNS?: string;
  TRUST_CLOUDFLARE_VERIFIED_BOTS?: string;
  CLOUDFLARE_AGENT_BOT_CATEGORIES?: string;
  HINT_SIGNING_SECRET?: string;
  API_PATHS?: string;
  INJECT_LOGIN_HINT?: string;
  /** Local development only: forward to this origin instead of the request's host. */
  UPSTREAM_ORIGIN?: string;
  /** The cookie the front door sets once an agent is signed in. Defaults to DS. */
  AGENT_SESSION_COOKIE?: string;
}

/** The Poppy draft this worker's own poppy.json follows. */
export const POPPY_VERSION = "0.4";

export type Mode = "monitor" | "route";

/** One entry in the Poppy document's `auth.scope_hints` (4.7). */
export interface ScopeHint {
  changes: "none" | "reversible" | "irreversible";
  personal_data: boolean;
}

/** One entry in the Poppy document's `apis` list. */
export interface PoppyApi {
  type: string;
  url: string;
  description?: string;
}

export interface Config {
  mode: Mode;
  siteName: string;
  issuer: string;
  frontDoorUrl?: string;
  resourceUrl: string;
  siteDomain: string;
  scopes: string[];
  scopeDescriptions?: Record<string, string>;
  scopeHints?: Record<string, ScopeHint>;
  apis: PoppyApi[];
  /** Older protocol versions served alongside the one poppy.json names (3.4). */
  supportedVersions: string[];
  authorizationDetailsTypes: string[];
  loginPaths: string[];
  blockedAgentPaths: string[];
  agentUserAgentPatterns: string[];
  trustCloudflareVerifiedBots: boolean;
  cloudflareAgentBotCategories: string[];
  hintSigningSecret?: string;
  apiPaths: string[];
  injectLoginHint: boolean;
  upstreamOrigin?: string;
  agentSessionCookie: string;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * The Poppy `apis` list. It is JSON rather than a comma-separated list because each entry
 * carries a type, a URL and a description. A value that doesn't parse costs the site its API
 * advertisement and nothing else: the rest of the document is still worth serving, so the
 * problem is logged and the list is dropped.
 */
function poppyApis(value: string | undefined): PoppyApi[] {
  if (!value?.trim()) return [];
  const giveUp = (reason: string): PoppyApi[] => {
    console.error(JSON.stringify({ event: "config_error", error: `POPPY_APIS ${reason}` }));
    return [];
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return giveUp("is not valid JSON");
  }
  if (!Array.isArray(parsed)) return giveUp("is not a JSON array");
  return parsed.flatMap((entry) => {
    const { type, url, description } = (entry ?? {}) as Record<string, unknown>;
    // Checked here, with a base, so rendering the document later can resolve it without throwing.
    if (typeof url !== "string" || !URL.canParse(url, "https://site.invalid")) {
      giveUp(`entry ${JSON.stringify(entry)} has no usable url`);
      return [];
    }
    return [{
      type: typeof type === "string" && type ? type : "openapi",
      url,
      ...(typeof description === "string" && description ? { description } : {}),
    }];
  });
}

/**
 * A Poppy setting that is a JSON object. Shares POPPY_APIS's bargain: a value that doesn't
 * parse costs the document that one field and nothing else, because the rest of it is still
 * worth serving.
 */
function poppyObject(name: string, value: string | undefined): Record<string, unknown> | undefined {
  if (!value?.trim()) return undefined;
  const giveUp = (reason: string): undefined => {
    console.error(JSON.stringify({ event: "config_error", error: `${name} ${reason}` }));
    return undefined;
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return giveUp("is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return giveUp("is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * `auth.scopes`: each scope mapped to the sentence a customer reads when they approve it
 * (4.7). Prose, so it has to be JSON rather than a comma-separated list.
 */
function poppyScopes(value: string | undefined): Record<string, string> | undefined {
  const parsed = poppyObject("POPPY_SCOPES", value);
  if (!parsed) return undefined;
  const scopes: Record<string, string> = {};
  for (const [scope, description] of Object.entries(parsed)) {
    if (typeof description === "string" && description) scopes[scope] = description;
  }
  return Object.keys(scopes).length ? scopes : undefined;
}

const CHANGES = ["none", "reversible", "irreversible"];

/**
 * `auth.scope_hints`: how consequential each scope is, so an agent can tell before it asks
 * (4.7). An entry missing either field, or naming a `changes` value the protocol doesn't
 * define, is dropped rather than passed through — a hint an agent can't read is worse than
 * no hint, because the whole point of it is to be relied on.
 */
function poppyScopeHints(value: string | undefined): Record<string, ScopeHint> | undefined {
  const parsed = poppyObject("POPPY_SCOPE_HINTS", value);
  if (!parsed) return undefined;
  const hints: Record<string, ScopeHint> = {};
  for (const [scope, hint] of Object.entries(parsed)) {
    const { changes, personal_data: personalData } = (hint ?? {}) as Record<string, unknown>;
    if (typeof changes === "string" && CHANGES.includes(changes) && typeof personalData === "boolean") {
      hints[scope] = { changes: changes as ScopeHint["changes"], personal_data: personalData };
    } else {
      console.error(JSON.stringify({
        event: "config_error",
        error: `POPPY_SCOPE_HINTS entry ${JSON.stringify(scope)} needs changes (${CHANGES.join("/")}) and personal_data`,
      }));
    }
  }
  return Object.keys(hints).length ? hints : undefined;
}

/**
 * Older protocol versions to serve beside the current one (3.4).
 *
 * Pre-1.0 two versions are compatible only when major AND minor match, so an agent built
 * against an older draft refuses the current document outright. Listing a version here
 * serves that draft its own document at its own URL, and names it in supported_versions,
 * which is how the protocol lets agents move at their own pace instead of being cut off
 * by a draft bump.
 *
 * Entries must be major.minor, and must not repeat the version this worker publishes: a
 * document cannot be an older alternative to itself.
 */
function supportedVersions(value: string | undefined, current: string): string[] {
  const out: string[] = [];
  for (const entry of list(value)) {
    if (!/^\d+\.\d+$/.test(entry) || entry === current) {
      console.error(JSON.stringify({
        event: "config_error",
        error: `SUPPORTED_VERSIONS entry ${JSON.stringify(entry)} is not an older major.minor version`,
      }));
      continue;
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

function required(name: keyof Env, value: string | undefined): string {
  if (!value || value.includes("YOUR_PROJECT_ID")) {
    throw new Error(`Missing configuration: set ${name} in wrangler.toml`);
  }
  return value.replace(/\/+$/, "");
}

function requiredUrl(name: keyof Env, value: string | undefined): string {
  const url = required(name, value);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid configuration: ${name} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Invalid configuration: ${name} must be an http(s) URL`);
  }
  return url;
}

export function loadConfig(env: Env): Config {
  return {
    mode: env.MODE === "route" ? "route" : "monitor",
    siteName: env.SITE_NAME ?? "This site",
    issuer: requiredUrl("DESCOPE_ISSUER", env.DESCOPE_ISSUER),
    frontDoorUrl: env.FRONT_DOOR_URL ? requiredUrl("FRONT_DOOR_URL", env.FRONT_DOOR_URL) : undefined,
    resourceUrl: requiredUrl("RESOURCE_URL", env.RESOURCE_URL),
    siteDomain: env.SITE_DOMAIN?.trim() || new URL(requiredUrl("RESOURCE_URL", env.RESOURCE_URL)).host,
    scopes: list(env.SCOPES_SUPPORTED),
    scopeDescriptions: poppyScopes(env.POPPY_SCOPES),
    scopeHints: poppyScopeHints(env.POPPY_SCOPE_HINTS),
    apis: poppyApis(env.POPPY_APIS),
    supportedVersions: supportedVersions(env.SUPPORTED_VERSIONS, POPPY_VERSION),
    authorizationDetailsTypes: list(env.AUTHORIZATION_DETAILS_TYPES),
    loginPaths: list(env.LOGIN_PATHS),
    blockedAgentPaths: list(env.BLOCKED_AGENT_PATHS),
    agentUserAgentPatterns: list(env.AGENT_USER_AGENT_PATTERNS),
    trustCloudflareVerifiedBots: env.TRUST_CLOUDFLARE_VERIFIED_BOTS !== "false",
    cloudflareAgentBotCategories: list(env.CLOUDFLARE_AGENT_BOT_CATEGORIES),
    hintSigningSecret: env.HINT_SIGNING_SECRET || undefined,
    apiPaths: list(env.API_PATHS ?? "/api/*"),
    injectLoginHint: env.INJECT_LOGIN_HINT !== "false",
    upstreamOrigin: env.UPSTREAM_ORIGIN ? requiredUrl("UPSTREAM_ORIGIN", env.UPSTREAM_ORIGIN) : undefined,
    agentSessionCookie: env.AGENT_SESSION_COOKIE || "DS",
  };
}

/** Matches "/login" exactly, or "/account/*" as a prefix. */
export function pathMatches(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern,
  );
}
