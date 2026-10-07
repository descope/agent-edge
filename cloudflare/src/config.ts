export interface Env {
  MODE?: string;
  SITE_NAME?: string;
  DESCOPE_ISSUER: string;
  /** The agent front door. Optional. */
  FRONT_DOOR_URL?: string;
  RESOURCE_URL: string;
  SCOPES_SUPPORTED?: string;
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

export interface Config {
  mode: Mode;
  siteName: string;
  issuer: string;
  frontDoorUrl?: string;
  resourceUrl: string;
  scopes: string[];
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
    scopes: list(env.SCOPES_SUPPORTED),
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
