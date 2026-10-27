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
  DEVICE_SCOPES?: string;
  /**
   * The APIs the Poppy document advertises, as a JSON array. Each entry needs a url, which may
   * be a path on your own site, and may carry a type (default "openapi") and a description:
   * [{"url": "/openapi.json", "description": "Browse and buy"}]
   */
  POPPY_APIS?: string;
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

export type Mode = "monitor" | "route";

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
  deviceScopes: string[];
  apis: PoppyApi[];
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
    // A document that asked for no scopes would be useless, so an empty setting falls back.
    deviceScopes: list(env.DEVICE_SCOPES || "openid"),
    apis: poppyApis(env.POPPY_APIS),
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
