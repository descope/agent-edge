import type { Config } from "./config";
import { base64Url, utf8 } from "./encoding";

interface Discovery {
  issuer: string;
  token_endpoint: string;
  backchannel_authentication_endpoint?: string;
  device_authorization_endpoint?: string;
}

const CIBA_GRANT = "urn:openid:params:grant-type:ciba";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** How a pending request is approved: CIBA (an approval email) or the device flow (a link the user opens). */
export type Flow = "ciba" | "device";

let discoveryCache: { url: string; value: Discovery } | undefined;

/** Reads the inbound app's endpoints from its discovery document, cached for the isolate's lifetime. */
export async function discover(config: Config): Promise<Discovery> {
  if (discoveryCache?.url === config.discoveryUrl) return discoveryCache.value;
  const response = await fetch(config.discoveryUrl, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`discovery failed (${response.status})`);
  const value = (await response.json()) as Discovery;
  discoveryCache = { url: config.discoveryUrl, value };
  return value;
}

/** Whether the inbound app offers the device flow. False if discovery can't be read. */
export async function deviceFlowAvailable(config: Config): Promise<boolean> {
  try {
    return Boolean((await discover(config)).device_authorization_endpoint);
  } catch {
    return false;
  }
}

/** Test hook: forget the cached discovery document. */
export function resetDiscoveryCache(): void {
  discoveryCache = undefined;
}

/** Client authentication: private_key_jwt when a key is configured, otherwise the client's secret. */
async function clientAuth(config: Config, clientId: string, endpoint: string, issuer: string): Promise<Record<string, string>> {
  if (config.privateKey) {
    return {
      client_id: clientId,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: await clientAssertion(config.privateKey, clientId, [issuer, endpoint]),
    };
  }
  const secret = config.clientSecrets[clientId];
  if (!secret) throw new Error(`no client secret configured for ${clientId}`);
  return { client_id: clientId, client_secret: secret };
}

/** RFC 7523 client assertion, signed with ES256. The audience lists both the issuer and the endpoint. */
export async function clientAssertion(jwk: JsonWebKey & { kid?: string }, clientId: string, audience: string[]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", typ: "JWT", ...(jwk.kid ? { kid: jwk.kid } : {}) };
  const claims = { iss: clientId, sub: clientId, aud: audience, iat: now, exp: now + 60, jti: crypto.randomUUID() };
  const input = `${base64Url(utf8(JSON.stringify(header)))}.${base64Url(utf8(JSON.stringify(claims)))}`;
  const { kid: _kid, ...keyData } = jwk;
  const key = await crypto.subtle.importKey("jwk", keyData, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(input));
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

/** The resource parameter (RFC 8707), when one is configured. */
function resourceParam(config: Config): Record<string, string> {
  return config.resource ? { resource: config.resource } : {};
}

async function post(url: string, params: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params),
  });
  const text = await response.text();
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    // Descope reports errors as { errorCode, errorDescription } rather than OAuth's { error, error_description }.
    if (body.error === undefined && body.errorCode !== undefined) {
      body.error = body.errorCode;
      // errorMessage is the specific reason ("missing secret"); errorDescription is the category.
      body.error_description = body.errorMessage ?? body.errorDescription;
    }
    return { status: response.status, body };
  } catch {
    return { status: response.status, body: { error: "invalid_response", error_description: text.slice(0, 200) } };
  }
}

export interface CibaStart {
  authReqId: string;
  expiresIn: number;
  interval: number;
}

export async function startCiba(
  config: Config,
  request: { clientId: string; email: string; scope: string; bindingMessage: string },
): Promise<CibaStart> {
  const discovery = await discover(config);
  const endpoint = discovery.backchannel_authentication_endpoint;
  if (!endpoint) throw new Error("discovery has no backchannel_authentication_endpoint; enable CIBA on the inbound app");
  const { status, body } = await post(endpoint, {
    ...(await clientAuth(config, request.clientId, endpoint, discovery.issuer)),
    scope: request.scope,
    ...resourceParam(config),
    login_hint: request.email,
    binding_message: request.bindingMessage,
  });
  if (status !== 200 || typeof body.auth_req_id !== "string") {
    throw new Error(`CIBA request failed: ${String(body.error ?? status)} ${String(body.error_description ?? "")}`.trim());
  }
  return {
    authReqId: body.auth_req_id,
    expiresIn: Number(body.expires_in ?? 300),
    interval: Number(body.interval ?? 5),
  };
}

export interface TokenSet {
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
  /** Kept by the front door, in a sealed cookie. Never returned to the agent. */
  refresh_token?: string;
}

function tokenSet(body: Record<string, unknown>): TokenSet {
  return {
    access_token: String(body.access_token),
    token_type: String(body.token_type ?? "Bearer"),
    expires_in: body.expires_in as number | undefined,
    scope: body.scope as string | undefined,
    refresh_token: body.refresh_token as string | undefined,
  };
}

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

/** Starts a device flow (RFC 8628). Nothing is sent to the user: the agent passes the link on. */
export async function startDevice(
  config: Config,
  request: { clientId: string; scope: string; loginHint?: string },
): Promise<DeviceStart> {
  const discovery = await discover(config);
  const endpoint = discovery.device_authorization_endpoint;
  if (!endpoint) throw new Error("discovery has no device_authorization_endpoint; enable the device flow on the inbound app");
  const { status, body } = await post(endpoint, {
    ...(await clientAuth(config, request.clientId, endpoint, discovery.issuer)),
    scope: request.scope,
    ...resourceParam(config),
    // Not part of RFC 8628, but some servers use it to pre-fill sign-in.
    ...(request.loginHint ? { login_hint: request.loginHint } : {}),
  });
  if (status !== 200 || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    throw new Error(`device authorization failed: ${String(body.error ?? status)} ${String(body.error_description ?? "")}`.trim());
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: String(body.verification_uri ?? body.verification_url ?? ""),
    verificationUriComplete: typeof body.verification_uri_complete === "string" ? body.verification_uri_complete : undefined,
    expiresIn: Number(body.expires_in ?? 600),
    interval: Number(body.interval ?? 5),
  };
}

export type PollResult =
  | { status: "pending"; slowDown?: boolean }
  | { status: "approved"; token: TokenSet }
  | { status: "denied" | "expired" }
  | { status: "error"; error: string };

/** Polls for the token. requestId is the CIBA auth_req_id or the device flow's device_code. */
export async function pollToken(config: Config, clientId: string, requestId: string, flow: Flow = "ciba"): Promise<PollResult> {
  const discovery = await discover(config);
  const endpoint = discovery.token_endpoint;
  const { status, body } = await post(endpoint, {
    ...(await clientAuth(config, clientId, endpoint, discovery.issuer)),
    ...(flow === "device"
      ? { grant_type: DEVICE_GRANT, device_code: requestId }
      : { grant_type: CIBA_GRANT, auth_req_id: requestId }),
    ...resourceParam(config),
  });
  if (status === 200 && typeof body.access_token === "string") return { status: "approved", token: tokenSet(body) };
  switch (body.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      // CIBA: still pending, and the client must poll at least 5 seconds slower from now on.
      return { status: "pending", slowDown: true };
    case "access_denied":
      return { status: "denied" };
    case "expired_token":
      return { status: "expired" };
    default:
      return { status: "error", error: `${String(body.error ?? status)} ${String(body.error_description ?? "")}`.trim() };
  }
}

/** Exchanges a refresh token for new tokens. Needs the front door's client credentials. */
export async function refreshTokens(config: Config, clientId: string, refreshToken: string): Promise<TokenSet | undefined> {
  const discovery = await discover(config);
  const endpoint = discovery.token_endpoint;
  const { status, body } = await post(endpoint, {
    ...(await clientAuth(config, clientId, endpoint, discovery.issuer)),
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    ...resourceParam(config),
  });
  return status === 200 && typeof body.access_token === "string" ? tokenSet(body) : undefined;
}
