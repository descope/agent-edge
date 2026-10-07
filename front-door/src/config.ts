/** A Workers rate limiting binding ([[ratelimits]] in wrangler.toml). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** Optional. Limits /connect per client IP. */
  CONNECT_IP_LIMITER?: RateLimiter;
  /** Optional. Limits /connect per email address, so one inbox can't be flooded with approval requests. */
  CONNECT_EMAIL_LIMITER?: RateLimiter;
  SITE_NAME?: string;
  DESCOPE_DISCOVERY_URL: string;
  UNVERIFIED_CLIENT_ID: string;
  VERIFIED_CLIENT_ID?: string;
  TRUSTED_PLATFORMS?: string;
  TRUSTED_SCOPES?: string;
  VERIFIED_SCOPES?: string;
  UNVERIFIED_SCOPES?: string;
  TRUSTED_ACCESS?: string;
  STEP_UP_SECRET?: string;
  CIBA_FALLBACK?: string;
  RESOURCE?: string;
  STEP_UP_SCOPE?: string;
  VERIFIED_ACCESS?: string;
  UNVERIFIED_ACCESS?: string;
  STATE_SECRET: string;
  HINT_SIGNING_SECRET?: string;
  PRIVATE_KEY_JWK?: string;
  CLIENT_SECRETS?: string;
  SESSION_COOKIES?: string;
  COOKIE_DOMAIN?: string;
  ACCESS_TOKEN_COOKIE?: string;
  REFRESH_TOKEN_COOKIE?: string;
  REFRESH_COOKIE_MAX_AGE?: string;
}

export type Tier = "trusted" | "verified" | "unverified";

export interface Config {
  siteName: string;
  discoveryUrl: string;
  clients: { unverified: string; verified: string; trusted: Record<string, string> };
  scopes: Record<Tier, string>;
  /** What each tier is asking to do, in words the user reads on the consent screen. */
  access: Record<Tier, string>;
  /** Shared with the store, which signs the order description it sends agents to step-up with. */
  stepUpSecret?: string;
  /** The scope a step-up asks for. */
  stepUpScope: string;
  /** Whether agents can connect by having an approval email sent (CIBA). Device codes are the main path. */
  cibaFallback: boolean;
  /** Sent as the resource parameter (RFC 8707) when Descope ties the scopes to a resource. */
  resource?: string;
  stateSecret: string;
  hintSigningSecret?: string;
  privateKey?: JsonWebKey & { kid?: string };
  clientSecrets: Record<string, string>;
  cookies?: { domain?: string; access: string; refresh: string; refreshMaxAge: number };
}

function required(name: keyof Env, value: string | undefined): string {
  if (!value || value.startsWith("YOUR_") || value.includes("YOUR_PROJECT_ID")) {
    throw new Error(`Missing configuration: set ${name}`);
  }
  return value;
}

function json<T>(name: keyof Env, value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Invalid configuration: ${name} must be JSON`);
  }
}

export function loadConfig(env: Env): Config {
  const unverified = required("UNVERIFIED_CLIENT_ID", env.UNVERIFIED_CLIENT_ID);
  const config: Config = {
    siteName: env.SITE_NAME ?? "This site",
    discoveryUrl: required("DESCOPE_DISCOVERY_URL", env.DESCOPE_DISCOVERY_URL),
    clients: {
      unverified,
      verified: env.VERIFIED_CLIENT_ID || unverified,
      trusted: json("TRUSTED_PLATFORMS", env.TRUSTED_PLATFORMS, {}),
    },
    scopes: {
      trusted: env.TRUSTED_SCOPES || "openid",
      verified: env.VERIFIED_SCOPES || "openid",
      unverified: env.UNVERIFIED_SCOPES || "openid",
    },
    access: {
      trusted: env.TRUSTED_ACCESS || "connect to {site}",
      verified: env.VERIFIED_ACCESS || "connect to {site}",
      unverified: env.UNVERIFIED_ACCESS || "connect to {site}",
    },
    stateSecret: required("STATE_SECRET", env.STATE_SECRET),
    stepUpSecret: env.STEP_UP_SECRET || undefined,
    stepUpScope: env.STEP_UP_SCOPE || "openid orders:read orders:write",
    cibaFallback: env.CIBA_FALLBACK !== "false",
    resource: env.RESOURCE || undefined,
    hintSigningSecret: env.HINT_SIGNING_SECRET || undefined,
    privateKey: json("PRIVATE_KEY_JWK", env.PRIVATE_KEY_JWK, undefined),
    clientSecrets: json("CLIENT_SECRETS", env.CLIENT_SECRETS, {}),
    cookies: env.SESSION_COOKIES === "false" ? undefined : {
      domain: env.COOKIE_DOMAIN || undefined,
      access: env.ACCESS_TOKEN_COOKIE || "DS",
      refresh: env.REFRESH_TOKEN_COOKIE || "DSR",
      refreshMaxAge: Number(env.REFRESH_COOKIE_MAX_AGE || 30 * 24 * 3600),
    },
  };
  if (!config.privateKey && Object.keys(config.clientSecrets).length === 0) {
    throw new Error("Missing configuration: set PRIVATE_KEY_JWK or CLIENT_SECRETS");
  }
  return config;
}
