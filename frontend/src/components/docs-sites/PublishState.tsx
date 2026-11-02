"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useToast } from "@/components/ui";
import { guideEvents } from "@/lib/guidesEvents";
import {
  addressSecuring, docsErrorMessage, docsErrorStatus, getPublishStatus, primaryAddress, publishSite,
  type Build, type PublishStatus, type Site,
} from "@/lib/docsSites";
import { SECURING_TEXT } from "./AddressSecuring";
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
// The guide itself, while its new address is being secured (AddressSecuring.tsx), or a first
// publish runs before the address is attached.
const ADDRESS_MS = 10_000;

/** "Publish #n is live" with Open, or, while the new address is being secured, that it opens soon. */
function liveToast(n: number, host: string, securing: boolean): { message: React.ReactNode; open: boolean } {
  return {
    open: !securing,
    message: (
      <span className="flex flex-col">
        <strong>Publish #{n} is live</strong>
        {securing
          ? <span className="text-[12px] opacity-80">Securing <span className="ph-sensitive ph-mask">{host}</span> first. {SECURING_TEXT}</span>
          : <span className="text-[12px] opacity-80"><span className="ph-sensitive ph-mask">{host}</span> shows your changes now</span>}
      </span>
    ),
  };
}

/**
 * Polls GET /publish-status for every screen of one guide (it lives in the guide's layout): every
 * 2 s while a publish runs, every 20 s otherwise (paused while the tab is hidden), again whenever
 * the guide's settings are saved. When a publish goes live: "Publish #n is live" with Open (a new tab).
 *
 * A new guide's address takes a minute or three to be secured after its first publish
 * (`address_state` "securing"): meanwhile the guide is loaded again every 10 s, and when the
 * address opens, "Your guide is live at …" with Open.
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
  const siteRef = useRef<Site>(site);
  siteRef.current = site;

  const settle = useCallback((next: PublishStatus) => {
    // Builds we saw running that aren't any more: live (say so) or failed.
    for (const id of [...watching.current]) {
      if (next.running && next.running.id === id) continue;
      watching.current.delete(id);
      if (next.live?.id === id) {
        const n = next.live.number;
        // The guide again first: a first publish's address may still be being secured.
        void reload().then((fresh) => {
          const s = fresh ?? siteRef.current;
          const h = primaryAddress(s);
          const t = liveToast(n, h, s.status === "live" && addressSecuring(s));
          if (t.open) {
            toast.success(t.message, { duration: 9000, action: { label: "Open", onClick: () => { guideEvents.liveOpened("toast"); openLive(h); } } });
          } else toast.info(t.message, { duration: 12_000 });
        });
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

  // The new address: load the guide every 10 s while it's being secured (or a first publish runs
  // before it is attached), and say so when it opens.
  const securing = site.address_state === "securing";
  const watchAddress = securing || (!!running && site.address_state === "pending");
  useEffect(() => {
    if (!watchAddress) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, ADDRESS_MS);
    return () => window.clearInterval(t);
  }, [watchAddress, reload]);
  const wasSecuring = useRef(site.status === "live" && addressSecuring(site));
  useEffect(() => {
    const now = site.status === "live" && addressSecuring(site);
    if (wasSecuring.current && !now && site.status === "live" && site.address_state === "ready") {
      const h = primaryAddress(site);
      toast.success(
        <span className="flex flex-col">
          <strong>Your guide is live at <span className="ph-sensitive ph-mask">{h}</span></strong>
          <span className="text-[12px] opacity-80">The address is secured. It opens for everyone now.</span>
        </span>,
        { duration: 12_000, action: { label: "Open", onClick: () => { guideEvents.liveOpened("toast"); openLive(h); } } },
      );
    }
    wasSecuring.current = now;
  }, [site, toast]);

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
