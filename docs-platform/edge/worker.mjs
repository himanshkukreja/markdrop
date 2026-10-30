/**
 * Cloudflare Worker entry: the docs edge over an R2 bucket (binding DOCS). Objects are immutable
 * (named by hash), so whole objects are also kept in the colo's Cache API: a warm page view costs
 * no R2 read. Pointers and manifests are cached in the isolate (handler.mjs).
 */
import { createHandler } from "./handler.mjs";

let handler = null;

function r2Store(bucket) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  return {
    async getText(key) {
      const o = await bucket.get(key);
      return o ? await o.text() : null;
    },
    async getObject(hash, range, ctx) {
      const key = `objects/${hash}`;
      // Whole objects only in the cache (a Range request on a video goes straight to R2).
      const cacheKey = `https://docs-objects.internal/${hash}`;
      if (!range && cache) {
        const hit = await cache.match(cacheKey);
        if (hit) return { body: hit.body, size: Number(hit.headers.get("content-length")) };
      }
      const o = await bucket.get(key, range ? { range } : undefined);
      if (!o) return null;
      if (!range && cache && ctx?.waitUntil && o.size <= 25 * 1024 * 1024) {
        const [a, b] = o.body.tee();
        ctx.waitUntil(cache.put(cacheKey, new Response(b, { headers: { "content-length": String(o.size), "cache-control": "public, max-age=31536000, immutable" } })));
        return { body: a, size: o.size };
      }
      return { body: o.body, size: o.size };
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    // One handler per isolate: its host/pointer/manifest caches live as long as the isolate.
    handler ??= createHandler(r2Store(env.DOCS), { pointerTtlMs: Number(env.POINTER_TTL_MS || 5000) });
    return handler.fetch(request, ctx);
  },
};
