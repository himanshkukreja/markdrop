"use client";

/**
 * Reader signals for a Markdrop Guides site with Insights on (site.json `insights`): what feeds the
 * guide's Fix list (backend services/guide_signals.py, services/guide_fixes.py). One beacon per page
 * view to `<insights>/signal`, sent once when the reader leaves the page (another page, the tab
 * hidden or closed):
 *
 *   how far down the page they got   the deepest h2/h3 of the article whose top passed 3/4 of the
 *                                     window, or the end of the article (its last line on screen)
 *   videos played                     which 40ths of each docs-player video (data-video-id) played
 *   code copied                       which code block's Copy was used, and in which section
 *
 * and, from the guide's 404 page, the missing address and the guide page that linked to it
 * (`BrokenLinkSignal`).
 *
 * The same rules as the rest of Insights, stricter: no cookie, no storage, no id of any kind (not
 * even the daily visitor hash), nothing a reader typed, no third party. Nothing at all when the
 * browser sends Do Not Track or Global Privacy Control. A guide can measure a share of its views
 * (site.json `signals.sample`). Sent as text/plain with keepalive, errors never surface. The pure
 * parts are ../signals.mjs (signals.test.mjs).
 */
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { brokenBeacon, deepestReached, markPlayed, optedOut, readBeacon, sampled, sectionAt, type ViewState } from "../signals.mjs";
import { useDocsSite } from "./site";

const ARTICLE = "main#main";
const HEADINGS = "h2[id], h3[id]";

function send(base: string, body: object | null) {
  if (!body) return;
  try {
    void fetch(`${base}/signal`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(body),
      keepalive: true,
      credentials: "omit",
    }).catch(() => {});
  } catch {
    /* never surfaces */
  }
}

function allowed(): boolean {
  try {
    return !optedOut(navigator, window);
  } catch {
    return false;
  }
}

function headingsOf(article: Element | null): HTMLElement[] {
  if (!article) return [];
  // Headings inside a hidden tab panel aren't on the reader's path down the page.
  return Array.from(article.querySelectorAll<HTMLElement>(HEADINGS)).filter((h) => !h.closest("[hidden]"));
}

/** Mounted once by the docs layout; a new view starts at every navigation. */
export function ReaderSignals({ base, sample }: { base: string; sample?: number }) {
  const pathname = usePathname();
  useEffect(() => {
    if (!allowed() || !sampled(sample, Math.random())) return;
    const article = document.querySelector(ARTICLE);
    if (!article) return;
    const heads = headingsOf(article);
    const view: ViewState = {
      path: window.location.pathname, n: heads.length, deepest: -1, end: false, ids: heads.map((h) => h.id),
      seconds: 0, copies: [], videos: new Map(),
    };
    let sent = false;
    let frame = 0;

    const measure = () => {
      frame = 0;
      // The page was swapped out from under us (a navigation): what was measured stands.
      if (!article.isConnected || !heads.every((h) => h.isConnected)) return;
      const h = window.innerHeight;
      view.deepest = Math.max(view.deepest, deepestReached(heads.map((x) => x.getBoundingClientRect().top), h));
      if (!view.end && article.getBoundingClientRect().bottom <= h + 4) view.end = true;
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };

    // Seconds the page is on screen (a hidden tab doesn't count).
    const tick = window.setInterval(() => {
      if (document.visibilityState === "visible") view.seconds += 1;
    }, 1000);

    const onClick = (e: MouseEvent) => {
      const btn = (e.target as Element | null)?.closest?.(".md-codeblock__copy");
      const block = btn?.closest(".md-codeblock");
      if (!block || !article.contains(block)) return;
      const blocks = Array.from(article.querySelectorAll(".md-codeblock"));
      const y = block.getBoundingClientRect().top + window.scrollY;
      const s = sectionAt(heads.map((x) => x.getBoundingClientRect().top + window.scrollY), y);
      view.copies.push([s, Math.max(0, blocks.indexOf(block))]);
    };

    // Docs-player videos: the slices played, never a seek (a jump of more than 2 s).
    const last = new WeakMap<HTMLVideoElement, number>();
    const onTime = (e: Event) => {
      const v = e.target;
      if (!(v instanceof HTMLVideoElement) || !v.dataset.videoId || !article.contains(v)) return;
      const dur = v.duration;
      if (!(dur > 0) || !Number.isFinite(dur)) return;
      const t = v.currentTime;
      const prev = last.get(v);
      last.set(v, t);
      if (prev === undefined || v.seeking || Math.abs(t - prev) > 2) return;
      const rec = view.videos.get(v.dataset.videoId) ?? { length: dur, mask: 0 };
      rec.mask = markPlayed(rec.mask, prev, t, dur);
      rec.length = dur;
      view.videos.set(v.dataset.videoId, rec);
    };
    const onSeek = (e: Event) => {
      if (e.target instanceof HTMLVideoElement) last.delete(e.target);
    };

    const flush = (final = true) => {
      if (sent) return;
      sent = true;
      if (final) measure();
      send(base, readBeacon(view, sample));
    };
    const onPageHide = () => flush();
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    document.addEventListener("click", onClick, true);
    document.addEventListener("timeupdate", onTime, true);
    document.addEventListener("seeking", onSeek, true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      // The next navigation (or unmount): this view is over. The next page may already be on
      // screen, so nothing is measured now.
      flush(false);
      window.clearInterval(tick);
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("timeupdate", onTime, true);
      document.removeEventListener("seeking", onSeek, true);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [pathname, base, sample]);
  return null;
}

/** On the guide's 404 page: the address that doesn't exist, and the guide page that led there. */
export function BrokenLinkSignal() {
  const { insights } = useDocsSite();
  useEffect(() => {
    if (!insights || !allowed()) return;
    send(insights, brokenBeacon(window.location.pathname, document.referrer, window.location.origin));
  }, [insights]);
  return null;
}
