import { bytesToBase64url, sha256Base64url } from "./jwt";

/**
 * The Poppy browser join (spec section 6), as a state machine with no storage or HTTP in it.
 *
 * Three parties touch one code: the agent's browser loads a page and gets the code, the
 * agent authorizes that code over its own back channel, and the browser posts it back. Only
 * when all three line up does the Company know that *this* browser belongs to *that* agent,
 * acting for that User.
 *
 * Two rules here are not obvious from reading section 6, and both were learned by driving a
 * real browser through a working implementation:
 *
 * 1. **A code is spent by the first completion, whatever the result.** Otherwise a failed
 *    completion leaves the code live and a forged one becomes a probe that can be retried.
 * 2. **The page must not submit its own form.** A page that posted on load would spend the
 *    code before the agent had authorized it — and because of rule 1, every join would then
 *    fail with nothing to retry.
 */

/** Section 6: the one scope the protocol itself defines. */
export const BROWSER_SIGN_IN_SCOPE = "poppy:browser-sign-in";

/** The cookie that ties a code to the browser that was given it. */
export const JOIN_COOKIE = "__Host-poppy_join";

/** Short, because the whole exchange is three requests in a row. */
export const JOIN_TTL_SECONDS = 60;

export interface JoinIdentity {
  /** The agent's client_id, from its verified Session JWT. */
  clientId: string;
  /** The Poppy User ID (5.1) — assigned by the agent, not by us. */
  userId: string;
  /** The Session this browser is joining. */
  sid: string;
  /** Scopes from the access token, when the join was signed in. */
  scopes: string[];
  /** False when the agent authorized the code without an access token (6, signed out). */
  signedIn: boolean;
}

export interface JoinRecord {
  /** Hash of the secret handed to the browser. Never the secret itself. */
  secretHash: string;
  expiresAt: number;
  identity?: JoinIdentity;
}

export type CompleteOutcome =
  | { ok: true; identity: JoinIdentity }
  | { ok: false; reason: string };

/** A fresh code and the secret that proves the browser was the one given it. */
export function newJoin(now: number): { code: string; secret: string; record: Promise<JoinRecord> } {
  const code = randomToken();
  const secret = randomToken();
  return {
    code,
    secret,
    record: sha256Base64url(secret).then((secretHash) => ({
      secretHash,
      expiresAt: now + JOIN_TTL_SECONDS,
    })),
  };
}

/**
 * Step 2: the agent authorizes a code it was given, over its own back channel.
 *
 * Section 6 requires the access token in this step to carry `poppy:browser-sign-in`, and to
 * be refused with `insufficient_scope` when it does not. A join with no token at all is
 * valid and produces a signed-out Session.
 */
export function authorize(
  record: JoinRecord | undefined,
  identity: JoinIdentity,
  now: number,
): { ok: true; record: JoinRecord } | { ok: false; reason: string } {
  if (!record) return { ok: false, reason: "unknown code" };
  if (record.expiresAt <= now) return { ok: false, reason: "code has expired" };
  if (record.identity) return { ok: false, reason: "code was already authorized" };
  return { ok: true, record: { ...record, identity } };
}

/**
 * Step 3: the browser posts the code back, carrying the cookie it was given.
 *
 * The caller MUST delete the record before acting on this result, whatever it says — see
 * rule 1 above. Returning the outcome and deleting are separate so the storage layer cannot
 * accidentally keep a spent code alive.
 */
export async function complete(
  record: JoinRecord | undefined,
  presentedSecret: string | undefined,
  now: number,
): Promise<CompleteOutcome> {
  if (!record) return { ok: false, reason: "unknown or already used code" };
  if (record.expiresAt <= now) return { ok: false, reason: "code has expired" };
  if (!presentedSecret) return { ok: false, reason: "no join cookie" };

  // Section 10.6: without this the code alone would be enough, and a code seen in a log or
  // guessed by a third party would join someone else's browser to the agent's Session.
  const presentedHash = await sha256Base64url(presentedSecret);
  if (!timingSafeEqual(presentedHash, record.secretHash)) {
    return { ok: false, reason: "join cookie does not match this code" };
  }

  if (!record.identity) return { ok: false, reason: "code was never authorized by the agent" };
  return { ok: true, identity: record.identity };
}

/**
 * Compares two equal-length hashes without an early return.
 *
 * Both sides are SHA-256 output here, so length is constant and the loop leaks nothing. The
 * worker has no `timingSafeEqual`, and `===` on a secret-derived value is the kind of thing
 * that is fine until the day it is not.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function randomToken(): string {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
}
