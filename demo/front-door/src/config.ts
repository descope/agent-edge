export interface Env {
  SITE_NAME?: string;
  DESCOPE_DISCOVERY_URL: string;
  UNVERIFIED_CLIENT_ID: string;
  VERIFIED_CLIENT_ID?: string;
  TRUSTED_PLATFORMS?: string;
  TRUSTED_SCOPES?: string;
  VERIFIED_SCOPES?: string;
  UNVERIFIED_SCOPES?: string;
  STATE_SECRET: string;
  HINT_SIGNING_SECRET?: string;
  PRIVATE_KEY_JWK?: string;
  CLIENT_SECRETS?: string;
}

export type Tier = "trusted" | "verified" | "unverified";

export interface Config {
  siteName: string;
  discoveryUrl: string;
  clients: { unverified: string; verified: string; trusted: Record<string, string> };
  scopes: Record<Tier, string>;
  stateSecret: string;
  hintSigningSecret?: string;
  privateKey?: JsonWebKey & { kid?: string };
  clientSecrets: Record<string, string>;
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
    stateSecret: required("STATE_SECRET", env.STATE_SECRET),
    hintSigningSecret: env.HINT_SIGNING_SECRET || undefined,
    privateKey: json("PRIVATE_KEY_JWK", env.PRIVATE_KEY_JWK, undefined),
    clientSecrets: json("CLIENT_SECRETS", env.CLIENT_SECRETS, {}),
  };
  if (!config.privateKey && Object.keys(config.clientSecrets).length === 0) {
    throw new Error("Missing configuration: set PRIVATE_KEY_JWK or CLIENT_SECRETS");
  }
  return config;
}
