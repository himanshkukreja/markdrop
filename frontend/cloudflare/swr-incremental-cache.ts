// Stale-while-revalidate for revalidatePath / revalidateTag on Next 15 (OpenNext serves stale on a revalidated tag only
// from Next 16). Vercel serves the old page while it re-renders after an on-demand revalidation; OpenNext on Next 15
// treats the page as missing and renders it while the visitor waits: after a content release (POST
// /api/revalidate-courses expires every course page) first visits took 13-45 s on staging, Nov 2026.
//
// This wraps the incremental cache: a page or route entry (cacheType "cache") whose tags were revalidated after it
// was written is handed back as time-expired (lastModified 1) and marked to skip OpenNext's own tag check. Every page
// has a numeric `revalidate`, so OpenNext's cache interception (and Next itself) serves it as STALE and queues a
// background re-render (DO queue, deduplicated per page). Fetch / unstable_cache entries (cacheType "fetch") keep the
// strict check, so that re-render reads fresh data. Vercel ignores this file.
// (Same fix as the portfolio site's Workers migration, Nov 2026.)
import type { IncrementalCache } from "@opennextjs/aws/types/overrides";

const CACHE_TAGS_HEADER = "x-next-cache-tags";

/**
 * Markdrop: tags whose revalidation means "who may read this changed" (the API's revalidate outbox after an
 * access-affecting change: app/api/revalidate) and path tags (revalidatePath, used only for documents). When one of
 * those was revalidated, a stale copy must never be handed to the next visitor: the entry keeps OpenNext's strict
 * check (a re-render while the visitor waits; documents render in well under a second). Only a revalidation of other
 * tags gets the stale-while-revalidate treatment.
 */
const STRICT_TAG = /^(doc|wsl|host|share):|^_N_T_\//;

type TagCache = { mode?: string; hasBeenRevalidated(tags: string[], lastModified?: number): Promise<boolean> };

export function withStaleOnRevalidate(base: IncrementalCache): IncrementalCache {
  return {
    name: `swr-${base.name}`,
    async get(key, cacheType) {
      const t0 = Date.now();
      const entry = await base.get(key, cacheType);
      // slow cache reads in the logs, bucketed so wrangler tail can count them (Nov 2026: misses at the colo took 1.3-1.9 s)
      const ms = Date.now() - t0;
      if (ms > 300) console.warn(`[cache-timing] ${cacheType ?? "cache"} get ${ms > 1000 ? ">1s" : "0.3-1s"}${entry ? "" : " (none)"}`);
      if ((cacheType && cacheType !== "cache") || !entry?.value || entry.shouldBypassTagCache) return entry;
      const value = entry.value as { meta?: { headers?: Record<string, string | undefined> } };
      // read, don't consume: OpenNext's getTagsFromValue deletes the header
      const tags = value.meta?.headers?.[CACHE_TAGS_HEADER]?.split(",").filter(Boolean) ?? [];
      const tagCache = (globalThis as unknown as { tagCache?: TagCache }).tagCache;
      if (!tags.length || !tagCache || tagCache.mode !== "nextMode") return entry;
      const strict = tags.filter((t) => STRICT_TAG.test(t));
      const loose = tags.filter((t) => !STRICT_TAG.test(t));
      if (!loose.length) return entry;
      try {
        const t1 = Date.now();
        if (strict.length && (await tagCache.hasBeenRevalidated(strict, entry.lastModified ?? Date.now()))) return entry;
        const revalidated = await tagCache.hasBeenRevalidated(loose, entry.lastModified ?? Date.now());
        const tagMs = Date.now() - t1;
        if (tagMs > 300) console.warn(`[cache-timing] tag check ${tagMs > 1000 ? ">1s" : "0.3-1s"}`);
        if (revalidated) return { ...entry, lastModified: 1, shouldBypassTagCache: true };
      } catch {
        // tag cache unreachable: OpenNext checks again itself
      }
      return entry;
    },
    set: (key, value, isFetch) => base.set(key, value, isFetch),
    delete: (key) => base.delete(key),
  };
}
