import type { JsonFetcher } from "./agentDetection";

const MAX_DIRECTORY_BYTES = 64_000;

/** Fetches agent key directories and caches them at the edge. */
export function cachedJsonFetcher(ctx: ExecutionContext, ttlSeconds = 3600): JsonFetcher {
  return async (url: string) => {
    const cache = caches.default;
    const cacheKey = new Request(url, { method: "GET" });

    const cached = await cache.match(cacheKey);
    if (cached) return JSON.parse(await cached.text());

    const upstream = await fetch(url, {
      headers: { accept: "application/http-message-signatures-directory+json, application/json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!upstream.ok) throw new Error(`key directory fetch failed (${upstream.status})`);

    const body = await upstream.text();
    if (body.length > MAX_DIRECTORY_BYTES) throw new Error("key directory too large");

    const toCache = new Response(body, {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttlSeconds}` },
    });
    ctx.waitUntil(cache.put(cacheKey, toCache));
    return JSON.parse(body);
  };
}
