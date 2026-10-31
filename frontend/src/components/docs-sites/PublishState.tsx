"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useToast } from "@/components/ui";
import { guideEvents } from "@/lib/guidesEvents";
import {
  docsErrorMessage, docsErrorStatus, getPublishStatus, primaryAddress, publishSite,
  type Build, type PublishStatus,
} from "@/lib/docsSites";
import { useSite } from "./SiteContext";

export type PublishFrom = "site_bar" | "publish_screen" | "design_banner";

export interface PublishCtx {
  /** null until the first answer. */
  status: PublishStatus | null;
  refresh: () => Promise<void>;
  /** A refresh a moment from now (after a save: several in a row make one call). */
  refreshSoon: () => void;
  /** Start a publish and go to the Publish screen's progress. Null when it was refused (a toast says why). */
  publish: (opts: { note?: string; from: PublishFrom }) => Promise<Build | null>;
  /** The publish request is on its way. */
  starting: boolean;
  /** An editor on a guide that requires a review sends changes for review instead. */
  mustReview: boolean;
  /** Changes waiting (0 until known). */
  count: number;
  running: Build | null;
}

const NOOP: PublishCtx = {
  status: null, refresh: async () => {}, refreshSoon: () => {}, publish: async () => null,
  starting: false, mustReview: false, count: 0, running: null,
};

const Ctx = createContext<PublishCtx | null>(null);

/** The guide's publish state (site bar, Publish screen, Design's saved banner). */
export function usePublishState(): PublishCtx {
  return useContext(Ctx) ?? NOOP;
}

export const liveUrl = (host: string, path = "/") => `https://${host}${path === "/" ? "" : path}`;

/** Open the live guide (or one of its pages) in a new tab. */
export function openLive(host: string, path = "/") {
  window.open(liveUrl(host, path), "_blank", "noopener");
}

const RUNNING_MS = 2000;
const IDLE_MS = 20_000;

/**
 * Polls GET /publish-status for every screen of one guide (it lives in the guide's layout): every
 * 2 s while a publish runs, every 20 s otherwise (paused while the tab is hidden), again whenever
 * the guide's settings are saved. When a publish goes live: "Publish #n is live" with Open (a new tab).
 */
export function PublishStateProvider({ children }: { children: React.ReactNode }) {
  const { site, base, isAdmin, reload } = useSite();
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const [status, setStatus] = useState<PublishStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const watching = useRef<Set<string>>(new Set());
  const timer = useRef<number | null>(null);
  const soon = useRef<number | null>(null);
  const host = primaryAddress(site);
  const hostRef = useRef(host);
  hostRef.current = host;

  const settle = useCallback((next: PublishStatus) => {
    // Builds we saw running that aren't any more: live (say so) or failed.
    for (const id of [...watching.current]) {
      if (next.running && next.running.id === id) continue;
      watching.current.delete(id);
      if (next.live?.id === id) {
        const n = next.live.number;
        const h = hostRef.current;
        toast.success(
          <span className="flex flex-col">
            <strong>Publish #{n} is live</strong>
            <span className="text-[12px] opacity-80"><span className="ph-sensitive ph-mask">{h}</span> shows your changes now</span>
          </span>,
          { duration: 9000, action: { label: "Open", onClick: () => { guideEvents.liveOpened("toast"); openLive(h); } } },
        );
        void reload();
      } else if (next.latest?.id === id && next.latest.status === "failed") {
        toast.error(next.latest.error || `Publish #${next.latest.number} didn't go live. Nothing changed for readers.`);
      }
    }
    if (next.running) watching.current.add(next.running.id);
    setStatus(next);
  }, [toast, reload]);

  const refresh = useCallback(async () => {
    try {
      settle(await getPublishStatus(site.id));
    } catch { /* keep the last state; the next tick retries */ }
  }, [site.id, settle]);

  const refreshSoon = useCallback(() => {
    if (soon.current) window.clearTimeout(soon.current);
    soon.current = window.setTimeout(() => void refresh(), 1200);
  }, [refresh]);

  // First load, and again when the guide itself changes (a design or settings save).
  useEffect(() => { void refresh(); }, [refresh, site.updated_at, site.status, site.live_build_id]);

  const running = status?.running ?? null;
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    timer.current = window.setInterval(tick, running ? RUNNING_MS : IDLE_MS);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [running, refresh]);
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refresh]);
  useEffect(() => () => { if (soon.current) window.clearTimeout(soon.current); }, []);

  const mustReview = !!site.settings.review?.required && !isAdmin;

  const publish = useCallback(async ({ note, from }: { note?: string; from: PublishFrom }) => {
    if (mustReview) {
      router.push(`${base}/publish`);
      return null;
    }
    setStarting(true);
    try {
      const b = await publishSite(site.id, note?.trim() || undefined);
      guideEvents.publishStarted(from);
      watching.current.add(b.id);
      setStatus((s) => s && {
        ...s,
        running: { ...b, status: b.status ?? "queued", progress: b.progress ?? { stage: "waiting", percent: 2, pages_done: 0, pages_total: 0, eta_seconds: 60, elapsed_seconds: 0 } },
        running_count: s.running_count + 1,
      });
      if (pathname !== `${base}/publish`) router.push(`${base}/publish`);
      void refresh();
      return b;
    } catch (e) {
      if (docsErrorStatus(e) === 409 && /review/i.test(docsErrorMessage(e))) {
        toast.error("This guide needs a review before it's published. Send it for review instead.");
        void reload();
      } else toast.error(docsErrorMessage(e, "The publish didn't start. Try again."));
      return null;
    } finally {
      setStarting(false);
    }
  }, [mustReview, router, base, site.id, pathname, refresh, toast, reload]);

  const value = useMemo<PublishCtx>(() => ({
    status, refresh, refreshSoon, publish, starting, mustReview, count: status?.count ?? 0, running,
  }), [status, refresh, refreshSoon, publish, starting, mustReview, running]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export default PublishStateProvider;
