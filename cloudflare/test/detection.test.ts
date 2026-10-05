import assert from "node:assert/strict";
import { test } from "node:test";
import { generateNonce, sign } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";
import { detectAgent, type JsonFetcher } from "../src/agentDetection";
import { loadConfig, pathMatches, type Env } from "../src/config";
import { signAgentHint } from "../src/hint";

// Testing-only key pair from RFC 9421 Appendix B.1.4.
const PRIVATE_KEY = {
  kty: "OKP",
  crv: "Ed25519",
  alg: "EdDSA",
  d: "n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU",
  x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs",
};
const PUBLIC_KEY = { kty: "OKP", crv: "Ed25519", alg: "EdDSA", x: PRIVATE_KEY.x };
const AGENT_ORIGIN = "https://signature-agent.test";

const env: Env = {
  DESCOPE_ISSUER: "https://api.descope.com/P123",
  FRONT_DOOR_URL: "https://agents.example.com",
  RESOURCE_URL: "https://example.com/api",
  LOGIN_PATHS: "/login",
  BLOCKED_AGENT_PATHS: "/account/password,/account/payment-methods*",
  AGENT_USER_AGENT_PATTERNS: "ChatGPT-User,HeadlessChrome",
  CLOUDFLARE_AGENT_BOT_CATEGORIES: "AI Assistant",
};
const config = loadConfig(env);

const directory: JsonFetcher = async (url) => {
  assert.equal(url, `${AGENT_ORIGIN}/.well-known/http-message-signatures-directory`);
  return { keys: [PUBLIC_KEY] };
};

async function signedRequest(target = "https://example.com/login"): Promise<Request> {
  const signatureAgent = `sig1="${AGENT_ORIGIN}";type=directory`;
  const unsigned = new Request(target, { headers: { "Signature-Agent": signatureAgent } });
  const now = new Date();
  const fields = await sign(unsigned, {
    signer: await signerFromJWK(PRIVATE_KEY),
    created: now,
    expires: new Date(now.getTime() + 300_000),
    nonce: generateNonce(),
  });
  return new Request(target, {
    headers: {
      "Signature-Agent": signatureAgent,
      "Signature-Input": fields.signatureInput,
      Signature: fields.signature,
    },
  });
}

test("a valid Web Bot Auth signature is verified", async () => {
  const result = await detectAgent(await signedRequest(), config, directory);
  assert.equal(result.status, "verified");
  assert.equal(result.signatureAgent, AGENT_ORIGIN);
});

test("a signature replayed against another host is rejected", async () => {
  const original = await signedRequest("https://example.com/login");
  const moved = new Request("https://attacker.example/login", { headers: original.headers });
  const result = await detectAgent(moved, config, directory);
  assert.equal(result.status, "unverified");
});

test("a signature with an unknown key is rejected", async () => {
  const otherKeys: JsonFetcher = async () => ({ keys: [] });
  const result = await detectAgent(await signedRequest(), config, otherKeys);
  assert.equal(result.status, "unverified");
  assert.match(result.reason, /no key/);
});

test("an agent-like user agent without a signature is unverified", async () => {
  const request = new Request("https://example.com/login", {
    headers: { "user-agent": "Mozilla/5.0 HeadlessChrome/126.0" },
  });
  const result = await detectAgent(request, config, directory);
  assert.equal(result.status, "unverified");
});

test("ordinary browser traffic is not flagged", async () => {
  const request = new Request("https://example.com/login", {
    headers: { "user-agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15" },
  });
  const result = await detectAgent(request, config, directory);
  assert.equal(result.status, "none");
});

test("path patterns match exact paths and prefixes", () => {
  assert.equal(pathMatches("/login", config.loginPaths), true);
  assert.equal(pathMatches("/login/extra", config.loginPaths), false);
  assert.equal(pathMatches("/account/payment-methods/42", config.blockedAgentPaths), true);
});

test("missing configuration is caught", () => {
  assert.throws(() => loadConfig({ ...env, DESCOPE_ISSUER: "https://api.descope.com/YOUR_PROJECT_ID" }));
});

test("agent hints carry a payload and a signature", async () => {
  const hint = await signAgentHint({ status: "verified", signatureAgent: AGENT_ORIGIN, reason: "" }, "secret", 0);
  const [body, signature] = hint.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString());
  assert.equal(payload.signature_agent, AGENT_ORIGIN);
  assert.equal(payload.exp, 300);
  assert.ok(signature.length > 20);
});
