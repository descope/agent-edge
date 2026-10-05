import type { Config } from "./config";
import { base64Url, utf8 } from "./encoding";

interface Discovery {
  issuer: string;
  token_endpoint: string;
  backchannel_authentication_endpoint?: string;
}

const CIBA_GRANT = "urn:openid:params:grant-type:ciba";

let discoveryCache: { url: string; value: Discovery } | undefined;

/** Reads the inbound app's endpoints from its discovery document, cached for the isolate's lifetime. */
export async function discover(config: Config): Promise<Discovery> {
  if (discoveryCache?.url === config.discoveryUrl) return discoveryCache.value;
  const response = await fetch(config.discoveryUrl, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`discovery failed (${response.status})`);
  const value = (await response.json()) as Discovery;
  if (!value.backchannel_authentication_endpoint) {
    throw new Error("discovery has no backchannel_authentication_endpoint; enable CIBA on the inbound app");
  }
  discoveryCache = { url: config.discoveryUrl, value };
  return value;
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

async function post(url: string, params: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
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
  const endpoint = discovery.backchannel_authentication_endpoint!;
  const { status, body } = await post(endpoint, {
    ...(await clientAuth(config, request.clientId, endpoint, discovery.issuer)),
    scope: request.scope,
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

export type PollResult =
  | { status: "pending" }
  | { status: "approved"; token: { access_token: string; token_type: string; expires_in?: number; scope?: string } }
  | { status: "denied" | "expired" }
  | { status: "error"; error: string };

export async function pollToken(config: Config, clientId: string, authReqId: string): Promise<PollResult> {
  const discovery = await discover(config);
  const endpoint = discovery.token_endpoint;
  const { status, body } = await post(endpoint, {
    ...(await clientAuth(config, clientId, endpoint, discovery.issuer)),
    grant_type: CIBA_GRANT,
    auth_req_id: authReqId,
  });
  if (status === 200 && typeof body.access_token === "string") {
    // The refresh token stays here: the agent couldn't use it without the front door's client credentials.
    return {
      status: "approved",
      token: {
        access_token: body.access_token,
        token_type: String(body.token_type ?? "Bearer"),
        expires_in: body.expires_in as number | undefined,
        scope: body.scope as string | undefined,
      },
    };
  }
  switch (body.error) {
    case "authorization_pending":
    case "slow_down":
      return { status: "pending" };
    case "access_denied":
      return { status: "denied" };
    case "expired_token":
      return { status: "expired" };
    default:
      return { status: "error", error: `${String(body.error ?? status)} ${String(body.error_description ?? "")}`.trim() };
  }
}
