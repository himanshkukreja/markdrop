"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { refreshAssetUrls, resolveEmbeds, type AssetUrl, type ResolvedEmbed } from "@/lib/pages";
import { refreshDelay } from "@/lib/pageBlocks.mjs";
import { pageRefs } from "@/lib/pageRefs.mjs";

/**
 * The page's embeds and mentions, resolved for this viewer in one batch (POST …/embeds), and again
 * before the earliest signed URL expires. New slugs (the editor's preview, a live update) are
 * resolved as they appear; what's known stays on screen meanwhile.
 *
 * `undefined` for a slug: still resolving. `null`: resolving failed (shown as unavailable).
 */
export function usePageEmbeds(pageSlug: string | null, slugs: string[], enabled = true, viewer: string | null = null) {
  const [map, setMap] = useState<Record<string, ResolvedEmbed | null>>({});
  const key = useMemo(() => [...new Set(slugs)].sort().join(","), [slugs]);
  const known = useRef(map);
  known.current = map;
  const [tick, setTick] = useState(0);
  // Someone signed in (or out) while the page was open, e.g. a workspace domain's sign-in coming
  // back with its token after the first resolve: what they may see changed, so ask again.
  const lastViewer = useRef(viewer);
  useEffect(() => {
    if (lastViewer.current === viewer) return;
    lastViewer.current = viewer;
    setTick((n) => n + 1);
  }, [viewer]);

  useEffect(() => {
    if (!pageSlug || !enabled || !key) return;
    const all = key.split(",");
    // A refresh (tick) asks for everything; otherwise only what isn't known yet.
    const want = tick ? all : all.filter((s) => !(s in known.current));
    if (!want.length) return;
    let live = true;
    resolveEmbeds(pageSlug, want)
      .then((r) => {
        if (!live) return;
        setMap((m) => {
          const next = { ...m };
          for (const s of want) next[s] = r[s] ?? { state: "missing" };
          return next;
        });
      })
      .catch(() => {
        if (!live) return;
        setMap((m) => {
          const next = { ...m };
          for (const s of want) if (!(s in next)) next[s] = null;
          return next;
        });
      });
    return () => {
      live = false;
    };
  }, [pageSlug, key, enabled, tick]);

  // Signed URLs expire: re-resolve a minute before the soonest one does.
  useEffect(() => {
    const d = refreshDelay(map as Record<string, ResolvedEmbed>);
    if (d === null) return;
    const t = window.setTimeout(() => setTick((n) => n + 1), d);
    return () => window.clearTimeout(t);
  }, [map]);

  return map;
}

/**
 * The page images' URLs for this viewer: the document read's `assets`, refreshed through
 * GET …/assets/urls before they expire (and when the content names an image not in the map yet,
 * e.g. one just pasted).
 */
export function usePageAssets(pageSlug: string | null, initial: Record<string, AssetUrl> | null | undefined, content: string, enabled = true) {
  const [assets, setAssets] = useState<Record<string, AssetUrl>>(initial ?? {});
  useEffect(() => {
    if (initial) setAssets((a) => ({ ...a, ...initial }));
  }, [initial]);
  const ids = useMemo(() => pageRefs(content).assets, [content]);
  const missing = ids.filter((id) => !assets[id]).join(",");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!pageSlug || !enabled || (!missing && !tick)) return;
    let live = true;
    refreshAssetUrls(pageSlug)
      .then((r) => live && setAssets((a) => ({ ...a, ...(r.assets ?? {}) })))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [pageSlug, enabled, missing, tick]);

  useEffect(() => {
    const d = refreshDelay(assets);
    if (d === null) return;
    const t = window.setTimeout(() => setTick((n) => n + 1), d);
    return () => window.clearTimeout(t);
  }, [assets]);

  return assets;
}
