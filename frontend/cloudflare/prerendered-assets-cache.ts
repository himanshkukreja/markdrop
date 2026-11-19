// Prerendered pages that never revalidate (landing, marketing, /login, the docs site, app shells: revalidate false)
// read from the Worker's static assets instead of R2, without a tag-cache lookup. Vercel ignores this file.
//
// Why: on a quiet colo an edge-copy miss (cloudflare/edge-cache.ts) went through the regional cache, an R2 read and
// the sharded tag-cache Durable Objects: 0.5-2.5 s of waiting for ~15 ms of CPU (wrangler tail, Nov 2026). Static
// assets are served from Cloudflare's own tiered cache, so the same page answers in tens of ms.
//
// scripts/cf/postbuild.mjs copies exactly those cache entries (revalidate false in the prerender manifest, only
// route tags `_N_T_/...`, never a data tag that revalidateTag could expire) to .open-next/assets/cdn-cgi/_next_cache
// (the directory OpenNext's own static-assets cache uses: assets under cdn-cgi/ are reachable by the Worker only).
// Everything else (documents and other ISR pages, fetch-cache entries) misses here and reads the wrapped cache as
// before; set/delete always go to it. populateCache still fills R2 with every prerendered page (the fallback).
import type { IncrementalCache } from "@opennextjs/aws/types/overrides";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { timing } from "./timing";

export const ASSETS_CACHE_DIR = "cdn-cgi/_next_cache";

type Assets = { fetch(input: string, init?: RequestInit): Promise<Response> };

/** The asset URL of a page's cache entry, or null for a key the URL parser would rewrite (`.` / `..` segments). */
export function assetUrl(buildId: string, key: string): string | null {
  const segments = `${ASSETS_CACHE_DIR}/${buildId}/${key}.cache`.replace(/\/+/g, "/").split("/");
  if (segments.some((s) => s === "." || s === "..")) return null;
  return `http://assets.local/${segments.map(encodeURIComponent).join("/")}`;
}

export function withPrerenderedAssets(base: IncrementalCache): IncrementalCache {
  return {
    // the wrapped cache's name: `opennextjs-cloudflare populateCache` picks the store (R2) by name
    name: base.name,
    async get(key, cacheType) {
      if (!cacheType || cacheType === "cache") {
        const entry = await fromAssets(key);
        // an app/route page entry, as the wrapped cache returns it for this key
        if (entry) return entry as never;
      }
      return base.get(key, cacheType);
    },
    set: (key, value, isFetch) => base.set(key, value, isFetch),
    delete: (key) => base.delete(key),
  };
}

async function fromAssets(key: string) {
  const buildId = process.env.OPEN_NEXT_BUILD_ID;
  const assets = (getCloudflareContext().env as { ASSETS?: Assets }).ASSETS;
  const url = buildId && assets ? assetUrl(buildId, key) : null;
  if (!url || !assets) return null;
  const t0 = Date.now();
  try {
    // the asset server redirects non-canonical URLs; a redirect is a miss
    const res = await assets.fetch(url, { redirect: "manual" });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const value = await res.json();
    // the build's time: a page that never revalidates is a HIT for its whole deployment
    const built = (globalThis as { __BUILD_TIMESTAMP_MS__?: number }).__BUILD_TIMESTAMP_MS__;
    return { value, lastModified: built ?? Date.now(), shouldBypassTagCache: true };
  } catch {
    return null;
  } finally {
    timing("asset", Date.now() - t0);
  }
}

