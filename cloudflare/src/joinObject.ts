import {
  authorize,
  complete,
  type CompleteOutcome,
  type JoinIdentity,
  type JoinRecord,
} from "./browserJoin";

/**
 * One Durable Object per join code.
 *
 * A code is touched three times within a minute by three different parties, and step 3 must
 * see step 2's write. KV is eventually consistent, so a browser could post its code back
 * before the agent's authorization had landed and be told, truthfully but uselessly, that
 * nobody had authorized it. `idFromName(code)` gives each code its own single-threaded
 * object, which is the smallest thing that makes the ordering real.
 *
 * The objects are addressed by a random 256-bit code and expire in a minute, so they cost
 * nothing to keep and nothing to clean up.
 */
export class PoppyJoin implements DurableObject {
  readonly #state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.#state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Math.floor(Date.now() / 1000);

    if (url.pathname === "/start") {
      const record = (await request.json()) as JoinRecord;
      await this.#state.storage.put("record", record);
      // Let the object clean itself up even if nobody ever comes back for the code.
      await this.#state.storage.setAlarm(Date.now() + (record.expiresAt - now + 5) * 1000);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/authorize") {
      const identity = (await request.json()) as JoinIdentity;
      const record = await this.#state.storage.get<JoinRecord>("record");
      const result = authorize(record, identity, now);
      if (!result.ok) return Response.json(result, { status: 400 });
      await this.#state.storage.put("record", result.record);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/complete") {
      const { secret } = (await request.json()) as { secret?: string };
      const record = await this.#state.storage.get<JoinRecord>("record");
      const outcome: CompleteOutcome = await complete(record, secret, now);
      // Spend the code whatever the outcome. A completion that failed must not leave a live
      // code behind for a second attempt to probe.
      await this.#state.storage.deleteAll();
      return Response.json(outcome, { status: outcome.ok ? 200 : 400 });
    }

    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.#state.storage.deleteAll();
  }
}

/** Calls one code's object. The code is the object's name, so no lookup table is needed. */
export async function joinObject(
  namespace: DurableObjectNamespace,
  code: string,
  path: "start" | "authorize" | "complete",
  body: unknown,
): Promise<Response> {
  const stub = namespace.get(namespace.idFromName(code));
  return stub.fetch(`https://join.invalid/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
