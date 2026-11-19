// Cloudflare Workers (OpenNext) build config: `npm run cf:build` (scripts/cf/build.sh). Vercel ignores this file.
import { defineCloudflareConfig, getCloudflareContext } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import { withRegionalCache } from "@opennextjs/cloudflare/overrides/incremental-cache/regional-cache";
import doQueue from "@opennextjs/cloudflare/overrides/queue/do-queue";
import doShardedTagCache from "@opennextjs/cloudflare/overrides/tag-cache/do-sharded-tag-cache";
import { withPrerenderedAssets } from "./cloudflare/prerendered-assets-cache";
import { withStaleOnRevalidate } from "./cloudflare/swr-incremental-cache";
import { timing } from "./cloudflare/timing";

type TagCache = ReturnType<typeof doShardedTagCache>;

/** The tag cache with each lookup's time in the Server-Timing header ("tag"). Methods run on the real object (it has private fields). */
function timedTagCache(tc: TagCache): TagCache {
  return new Proxy(tc, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      if (prop !== "hasBeenRevalidated" && prop !== "isStale" && prop !== "getLastRevalidated") return v.bind(target);
      return async (...args: unknown[]) => {
        const t0 = Date.now();
        try {
          return await v.apply(target, args);
        } finally {
          timing("tag", Date.now() - t0);
        }
      };
    },
  });
}

const config = defineCloudflareConfig({
  // Pages that never revalidate come from the Worker's static assets (cloudflare/prerendered-assets-cache.ts: no R2
  // read, no tag-cache lookup). ISR pages in R2 with the colo's cache in front; a page whose (non-access) tags were
  // revalidated is served stale while it re-renders (cloudflare/swr-incremental-cache.ts; access-bearing tags stay
  // strict).
  incrementalCache: withStaleOnRevalidate(withPrerenderedAssets(withRegionalCache(r2IncrementalCache, { mode: "long-lived" }))),
  // time-based ISR re-renders (documents: revalidate 60) go through a Durable Object, deduplicated per page. The
  // visitor gets the stale page without waiting for the hand-off (a cold DO's RPC could add hundreds of ms).
  queue: {
    name: doQueue.name,
    async send(msg) {
      getCloudflareContext().ctx.waitUntil(doQueue.send(msg).catch((e) => console.error("[queue] revalidation hand-off failed", e)));
    },
  },
  // revalidateTag / revalidatePath (the API's revalidate outbox): sharded Durable Objects, one copy per region (reads go
  // to the closest), answers cached in the colo for 45 s (without it nearly every page request hit a DO, often > 1 s).
  // A colo may say "never revalidated" for up to 45 s after a revalidation; with the Worker's 15 s edge copies of ISR
  // pages (cloudflare/edge-cache.ts ISR_TTL) an edit or access change reaches every reader within 60 s, the
  // documents' own revalidate.
  // Few shards and no replicas: at Markdrop's traffic every extra Durable Object is one more that is cold (asleep) when
  // a page needs it, and the colo cache is kept per DO, so 12 shards x 4 replicas split it 48 ways (Nov 2026: 0.5-2 s
  // misses). Tag records aren't per build, but every cache entry is (rendered after the deploy), so a revalidation
  // stored under the old layout can't make a new entry stale: changing the layout on a deploy is safe.
  tagCache: timedTagCache(
    doShardedTagCache({
      baseShardSize: 4,
      regionalCache: true,
      regionalCacheTtlSec: 45,
      regionalCacheDangerouslyPersistMissingTags: true,
      shardReplication: { numberOfSoftReplicas: 1, numberOfHardReplicas: 1, regionalReplication: { defaultRegion: "apac" } },
    }),
  ),
  // cached pages are answered before Next is loaded (else a DO hit per request)
  enableCacheInterception: true,
});

// route handlers' client manifests are emptied between `next build` and bundling (scripts/cf/prune-route-manifests.mjs)
export default { ...config, buildCommand: "npx next build && node scripts/cf/prune-route-manifests.mjs" };
