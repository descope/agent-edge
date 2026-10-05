import type { JsonFetcher } from "./agentDetection";

const MAX_DIRECTORY_BYTES = 64_000;

/** Fetches agent key directories and caches them at the edge. */
export function cachedJsonFetcher(ctx: ExecutionContext, ttlSeconds = 3600): JsonFetcher {
  return async (url: string) => {
    const cache = caches.default;
    const cacheKey = new Request(url, { method: "GET" });

    const cached = await cache.match(cacheKey);
    if (cached) return JSON.parse(await cached.text());

    // The URL comes from the request, so don't follow redirects past the https check.
    const upstream = await fetch(url, {
      headers: { accept: "application/http-message-signatures-directory+json, application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });
    if (!upstream.ok) throw new Error(`key directory fetch failed (${upstream.status})`);

    const body = await readCapped(upstream, MAX_DIRECTORY_BYTES);
    const parsed = JSON.parse(body);

    const toCache = new Response(body, {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttlSeconds}` },
    });
    ctx.waitUntil(cache.put(cacheKey, toCache));
    return parsed;
  };
}

/** Reads a response body as text, stopping as soon as it passes maxBytes. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new Error("key directory too large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("key directory too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
