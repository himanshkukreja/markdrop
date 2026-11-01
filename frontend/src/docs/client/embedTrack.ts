"use client";

/**
 * What a Markdrop file embedded in a docs page reports (MarkdropEmbed), and to whom. Cookieless,
 * no storage, no id that outlives the page load, nothing sent from the studio's previews.
 *
 * 1. The guide's Insights (and its Fix list), in the Insights beacon format: `POST <insights>/event`
 *    (client/Insights.tsx sendInsight) with
 *
 *      {k: "embed", p: <page path>, e: <embed id>, s: <file slug>, a: <action>, …}
 *
 *    `e` is stable per page (embed.mjs embedIds: the slug, `<slug>~2` for the same file again) and
 *    `p` is the page; actions, each at most once per page load unless noted:
 *      view                      the block was on screen (≥ 25 % of it) with the file showing
 *      interact                  the reader first used it (a click into the frame, a play, a page turn)
 *      fullscreen | open         Full screen / Open on Markdrop (each time)
 *      play                      the video's first play
 *      quartile  q: 25|50|75|100 the furthest point watched crossed that share of the video
 *      leave     t, w, d         the page was left after the video played: where it stopped (t, s),
 *                                seconds watched (w) and its length (d): drop-off for the Fix list
 *      pages     pg, n           the page was left after a PDF was read: furthest page, page count
 *    The API keeps the page path, the device class, a daily-rotating visitor hash (none under Do Not
 *    Track / Global Privacy Control), and nothing else about the reader (services/guide_insights.py).
 * 2. The file's own creator analytics: `POST /api/v1/embeds/{slug}/beacon` {site, p, a: "view"}
 *    counts a view of the file, from the "Guides" channel with the guide's name as its campaign
 *    ("seen in <guide>"); and for a video or a PDF, the engagement session the file's page on
 *    Markdrop would send (`/documents/{slug}/engage`, lib/engage.ts's wire format: watched ranges,
 *    pages read, active time), tagged the same way. Opted-out browsers send no session at all.
 */
import { useCallback, useEffect, useRef, type RefObject } from "react";
import { MediaAgg, PdfAgg, emptyDelta, type BridgeMessage, type EngageDelta, type EngagePos } from "@/lib/engageCore";
import { sendInsight } from "./Insights";

export interface EmbedTrackConfig {
  api: string;
  /** The guide's Insights endpoint (site.json `insights`), when Insights is on. */
  insights?: string | null;
  /** The docs site's id (a Markdrop Guides site's id, or "markdrop" for docs.markdrop.in). */
  site: string;
  /** The guide's name: the campaign the file's creator sees ("seen in Acme Docs"). */
  guide: string;
}

const REPORT_EVERY_MS = 15_000;
const IDLE_MS = 60_000;
const MAX_BODY = 8192;

export function optedOut(): boolean {
  if (typeof navigator === "undefined") return true;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
  return nav.globalPrivacyControl === true || nav.doNotTrack === "1" || nav.msDoNotTrack === "1";
}

function post(url: string, body: unknown, final = false) {
  try {
    const text = JSON.stringify(body);
    if (final && typeof navigator !== "undefined" && navigator.sendBeacon?.(url, new Blob([text], { type: "text/plain" }))) return;
    // text/plain, no credentials: a CORS "simple" request, no preflight.
    void fetch(url, { method: "POST", body: text, keepalive: true, credentials: "omit", headers: { "Content-Type": "text/plain" } }).catch(() => {});
  } catch {
    /* analytics never breaks reading */
  }
}

/** One Insights beacon: `view` | `fullscreen` | `open` | `play` | `watch` (with seconds). */
export function embedBeacon(cfg: EmbedTrackConfig, slug: string, a: "view" | "fullscreen" | "open" | "play" | "watch", extra: { s?: number; v?: number | null } = {}, final = false) {
  const body: Record<string, unknown> = { site: cfg.site, p: typeof location !== "undefined" ? location.pathname : "/", a };
  if (typeof extra.s === "number") body.s = Math.max(0, Math.min(86_400, Math.round(extra.s)));
  if (extra.v) body.v = extra.v;
  post(`${cfg.api.replace(/\/+$/, "")}/api/v1/embeds/${encodeURIComponent(slug)}/beacon`, body, final);
}

function randomId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type EmbedKind = "video" | "pdf" | "other";

export interface EmbedSession {
  /** A <video> event, as the Worker's player bridge would describe it. */
  media(m: BridgeMessage): void;
  /** A message from the PDF viewer frame (already source- and origin-checked). */
  pdf(m: BridgeMessage): void;
  /** The reader did something with the block (focus, a click into the frame). */
  activity(): void;
  /** Seconds of the video watched so far (for the guide's Insights). */
  watched(): number;
  stop(): void;
}

/**
 * An engagement session for one embedded file: deltas every 15 s while there is something new,
 * and a final one when the page is hidden or left (sendBeacon). Active seconds count while the
 * block is on screen, the tab is visible and the reader did something in the last minute (or the
 * video is playing).
 */
export function startEmbedSession(cfg: EmbedTrackConfig, slug: string, kind: EmbedKind, ver: number | null, onScreen: () => boolean): EmbedSession {
  const url = `${cfg.api.replace(/\/+$/, "")}/api/v1/documents/${encodeURIComponent(slug)}/engage`;
  const sid = randomId();
  const media = kind === "video" ? new MediaAgg() : null;
  const pdf = kind === "pdf" ? new PdfAgg() : null;
  let seq = 0;
  let activeS = 0;
  let lastActivity = Date.now();
  let closed = false;
  let watchedS = 0;

  const send = (final: boolean) => {
    const now = Date.now();
    const d: EngageDelta = {};
    if (activeS > 0) d.active_s = Math.min(120, activeS);
    pdf?.drain(d);
    const m = media?.drain(now);
    if (m) {
      d.media = m;
      for (const [s, e] of m.segs ?? []) watchedS += Math.max(0, e - s);
    }
    if (emptyDelta(d) && !(final && seq > 0 && !closed)) return;
    closed = final;
    activeS -= d.active_s ?? 0;
    seq += 1;
    const body: Record<string, unknown> = { v: 1, sid, k: kind, seq, final, d };
    if (ver != null) body.ver = ver;
    let pos: EngagePos | undefined;
    if (media && media.pos != null) pos = { s: Math.round(media.pos * 10) / 10 };
    else if (pdf && pdf.cur) pos = { p: pdf.cur };
    if (pos) body.pos = pos;
    if (seq === 1) body.first = { vw: window.innerWidth, utm: { source: "markdrop-guides", medium: "embed", campaign: cfg.guide.slice(0, 100) } };
    const text = JSON.stringify(body);
    if (new Blob([text]).size > MAX_BODY) return;
    post(url, body, final);
  };

  const tick = window.setInterval(() => {
    if (document.visibilityState !== "visible" || !onScreen()) return;
    const now = Date.now();
    const active = now - lastActivity < IDLE_MS || !!media?.playing();
    if (active) {
      activeS += 1;
      pdf?.second();
    }
  }, 1000);
  const periodic = window.setInterval(() => send(false), REPORT_EVERY_MS);
  const onVisibility = () => {
    if (document.visibilityState === "hidden") send(true);
    else lastActivity = Date.now();
  };
  const onPageHide = () => send(true);
  const onActivity = () => {
    lastActivity = Date.now();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pointerdown", onActivity, { passive: true });
  window.addEventListener("keydown", onActivity);

  return {
    media(m) {
      media?.handle(m, Date.now());
      if (m.e !== "timeupdate") lastActivity = Date.now();
    },
    pdf(m) {
      pdf?.handle(m);
      lastActivity = Date.now();
    },
    activity: onActivity,
    watched() {
      // What has been sent plus what is still open.
      let open = 0;
      if (media?.open) open = Math.max(0, media.open.e - media.open.from);
      for (const [s, e] of media?.segs ?? []) open += Math.max(0, e - s);
      return watchedS + open;
    },
    stop() {
      send(true);
      window.clearInterval(tick);
      window.clearInterval(periodic);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
    },
  };
}

/** Feeds a <video>'s events into a session, shaped like the Worker player's bridge messages. */
export function watchVideo(v: HTMLVideoElement, onMessage: (m: BridgeMessage) => void): () => void {
  let lastTU = 0;
  let lastT = 0;
  const msg = (e: string, extra: Partial<BridgeMessage> = {}): BridgeMessage => {
    const d = v.duration;
    const pe = (document as Document & { pictureInPictureElement?: Element | null }).pictureInPictureElement;
    const out: BridgeMessage = {
      md: 1,
      ev: "media",
      e,
      t: Math.round((v.currentTime || 0) * 100) / 100,
      dur: Number.isFinite(d) && d > 0 ? Math.round(d * 100) / 100 : null,
      rate: v.playbackRate || 1,
      muted: !!(v.muted || v.volume === 0),
      fs: !!document.fullscreenElement,
      pip: !!pe && pe === v,
      ...extra,
    };
    const q = (v as HTMLVideoElement & { getVideoPlaybackQuality?: () => VideoPlaybackQuality }).getVideoPlaybackQuality?.();
    if (q) out.q = { dropped: q.droppedVideoFrames || 0, frames: q.totalVideoFrames || 0 };
    return out;
  };
  const names = ["play", "playing", "pause", "waiting", "seeked", "ratechange", "ended", "loadedmetadata", "volumechange"] as const;
  const handlers: Array<[string, EventListener]> = names.map((n) => [n, () => onMessage(msg(n))]);
  handlers.push(["seeking", () => onMessage(msg("seeking", { pt: Math.round(lastT * 100) / 100 }))]);
  handlers.push([
    "timeupdate",
    () => {
      if (!v.seeking) lastT = v.currentTime || 0;
      const now = Date.now();
      if (now - lastTU < 1000) return;
      lastTU = now;
      onMessage(msg("timeupdate"));
    },
  ]);
  handlers.push(["error", () => onMessage(msg("error", { code: v.error?.code ?? 0, http: 0 }))]);
  for (const [n, h] of handlers) v.addEventListener(n, h);
  const onFs = () => onMessage(msg("fullscreen"));
  document.addEventListener("fullscreenchange", onFs);
  return () => {
    for (const [n, h] of handlers) v.removeEventListener(n, h);
    document.removeEventListener("fullscreenchange", onFs);
  };
}


/* ── the block's analytics, as one hook ──────────────────────────────────── */

type InsightAction = "view" | "interact" | "fullscreen" | "open" | "play" | "quartile" | "leave" | "pages";

export interface EmbedAnalyticsInput {
  cfg: EmbedTrackConfig;
  track: boolean;
  slug: string | null;
  eid: string | null;
  /** What is showing: a video, a PDF, a page / site, a card, or nothing yet. */
  kind: "video" | "pdf" | "other" | "card" | null;
  version: number | null;
  pinned: boolean;
  seen: boolean;
  onScreen: () => boolean;
  video: HTMLVideoElement | null;
  frame: RefObject<HTMLIFrameElement | null>;
  frameOrigin: string | null;
}

/**
 * Everything MarkdropEmbed reports (see the top of this file). Returns the chrome's callbacks
 * (Full screen, Open on Markdrop) and `interact()` for a click into the frame.
 */
export function useEmbedAnalytics(i: EmbedAnalyticsInput) {
  const { cfg, track, slug, eid, kind, version, pinned, seen, video, frame, frameOrigin } = i;
  const onScreen = useRef(i.onScreen);
  onScreen.current = i.onScreen;
  const once = useRef(new Set<string>());
  const session = useRef<EmbedSession | null>(null);
  const media = useRef({ played: false, max: 0, last: 0, dur: 0 });
  const pdf = useRef({ max: 0, n: 0 });

  const insight = useCallback(
    (a: InsightAction, extra: Record<string, unknown> = {}, onceKey?: string) => {
      if (!track || !slug || !cfg.insights) return;
      if (onceKey) {
        if (once.current.has(onceKey)) return;
        once.current.add(onceKey);
      }
      sendInsight(cfg.insights, { k: "embed", p: location.pathname, e: eid || slug, s: slug, a, ...extra });
    },
    [track, slug, eid, cfg.insights],
  );
  const interact = useCallback(() => {
    session.current?.activity();
    insight("interact", {}, "interact");
  }, [insight]);

  // Seen with the file showing: one view for the guide's Insights and one for the file's creator.
  useEffect(() => {
    if (!track || !slug || !seen || !kind || once.current.has("view")) return;
    insight("view", {}, "view");
    embedBeacon(cfg, slug, "view", { v: pinned ? version : null });
  }, [track, slug, seen, kind, insight, cfg, pinned, version]);

  // The creator's engagement session (video, PDF, page), unless the browser opted out.
  const sessionKind = kind === "video" ? "video" : kind === "pdf" ? "pdf" : kind === "other" ? "other" : null;
  useEffect(() => {
    if (!track || !slug || !sessionKind || optedOut()) return;
    const s = startEmbedSession(cfg, slug, sessionKind, version, () => onScreen.current());
    session.current = s;
    return () => {
      s.stop();
      session.current = null;
    };
  }, [track, slug, sessionKind, cfg, version]);

  // Leaving the page: where the video stopped and how much of it was watched; the furthest PDF page.
  useEffect(() => {
    if (!track || !slug) return;
    const flush = () => {
      const m = media.current;
      if (m.played && !once.current.has("leave")) {
        once.current.add("leave");
        const w = session.current?.watched() ?? 0;
        insight("leave", { t: Math.round(m.last * 10) / 10, w: Math.round(w), d: Math.round(m.dur * 10) / 10 });
      }
      const p = pdf.current;
      if (p.max > 0 && !once.current.has("pages")) {
        once.current.add("pages");
        insight("pages", { pg: p.max, n: p.n || undefined });
      }
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [track, slug, insight]);

  // The video: plays, quartiles of the furthest point reached, the position it stops at.
  useEffect(() => {
    if (!track || !video || !slug) return;
    return watchVideo(video, (m) => {
      session.current?.media(m);
      const st = media.current;
      if (typeof m.dur === "number" && m.dur > 0) st.dur = m.dur;
      if (typeof m.t === "number") st.last = m.t;
      if (m.e === "play") {
        st.played = true;
        insight("play", {}, "play");
        interact();
      }
      if (st.played && st.dur > 0 && typeof m.t === "number" && m.e !== "seeking") {
        st.max = Math.max(st.max, m.t);
        const frac = m.e === "ended" ? 1 : st.max / st.dur;
        for (const q of [25, 50, 75, 100]) if (frac >= q / 100 - (q === 100 ? 0.02 : 0)) insight("quartile", { q }, `q${q}`);
      }
    });
  }, [track, video, slug, insight, interact]);

  // The PDF viewer's page reports (its bridge), from our frame and the artifact origin only.
  useEffect(() => {
    if (!track || kind !== "pdf" || !frameOrigin) return;
    const onMessage = (e: MessageEvent) => {
      const f = frame.current;
      if (!f || e.source !== f.contentWindow || e.origin !== frameOrigin) return;
      const m = e.data as BridgeMessage | null;
      if (!m || typeof m !== "object" || m.md !== 1) return;
      if (m.ev === "pdf" && typeof m.n === "number") pdf.current.n = Math.floor(m.n);
      if (m.ev === "page" && typeof m.p === "number") {
        const p = Math.floor(m.p);
        if (p > 1) interact();
        pdf.current.max = Math.max(pdf.current.max, p);
      }
      if (m.ev === "pdf" || m.ev === "page") session.current?.pdf(m);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [track, kind, frameOrigin, frame, interact]);

  // A click into the frame moves focus out of this window: the reader is using the file.
  useEffect(() => {
    if (!track || (kind !== "other" && kind !== "pdf")) return;
    const onBlur = () =>
      window.setTimeout(() => {
        if (frame.current && document.activeElement === frame.current) interact();
      }, 0);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [track, kind, frame, interact]);

  return {
    interact,
    onFullscreen: useCallback(() => insight("fullscreen"), [insight]),
    onOpen: useCallback(() => insight("open"), [insight]),
  };
}
