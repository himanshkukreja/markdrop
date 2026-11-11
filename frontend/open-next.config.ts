// Cloudflare Workers (OpenNext) build config: `npm run cf:build` (scripts/cf/build.sh). Vercel ignores this file.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import { withRegionalCache } from "@opennextjs/cloudflare/overrides/incremental-cache/regional-cache";
import doQueue from "@opennextjs/cloudflare/overrides/queue/do-queue";
import doShardedTagCache from "@opennextjs/cloudflare/overrides/tag-cache/do-sharded-tag-cache";
import { withStaleOnRevalidate } from "./cloudflare/swr-incremental-cache";

const config = defineCloudflareConfig({
  // ISR pages in R2 with the colo's cache in front; a page whose (non-access) tags were revalidated is served stale
  // while it re-renders (cloudflare/swr-incremental-cache.ts; access-bearing tags stay strict).
  incrementalCache: withStaleOnRevalidate(withRegionalCache(r2IncrementalCache, { mode: "long-lived" })),
  // time-based ISR re-renders (documents: revalidate 60) go through a Durable Object, deduplicated per page
  queue: doQueue,
  // revalidateTag / revalidatePath (the API's revalidate outbox): sharded Durable Objects, replicated per region,
  // answers cached in the colo for 45 s (without it nearly every page request hit a DO, often > 1 s). A colo may say
  // "never revalidated" for up to 45 s after a revalidation; with the Worker's 15 s edge copies of ISR pages
  // (cloudflare/edge-cache.ts ISR_TTL) an edit or access change reaches every reader within 60 s, the documents' own
  // revalidate.
  tagCache: doShardedTagCache({
    baseShardSize: 12,
    regionalCache: true,
    regionalCacheTtlSec: 45,
    regionalCacheDangerouslyPersistMissingTags: true,
    shardReplication: { numberOfSoftReplicas: 4, numberOfHardReplicas: 2, regionalReplication: { defaultRegion: "apac" } },
  }),
  // cached pages are answered before Next is loaded (else a DO hit per request)
  enableCacheInterception: true,
});

// route handlers' client manifests are emptied between `next build` and bundling (scripts/cf/prune-route-manifests.mjs)
export default { ...config, buildCommand: "npx next build && node scripts/cf/prune-route-manifests.mjs" };
