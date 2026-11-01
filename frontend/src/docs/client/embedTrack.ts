"use client";

/**
 * What a Markdrop file embedded in a docs page reports (MarkdropEmbed), and to whom. Cookieless,
 * no storage, no id that outlives the page load, nothing sent from the studio's previews.
 *
 * 1. The guide's Insights, through `POST /api/v1/embeds/{slug}/beacon` {site, p, a, s?}: the file
 *    was seen (`view`, once per page load), opened full screen, opened on Markdrop, its video
 *    played, and how many seconds of it were watched (`watch`, when the page is left). The API
 *    keeps daily counts per file and page, nothing per reader, and drops all of it for a browser
 *    that sends Do Not Track or Global Privacy Control.
 * 2. The file's own creator analytics: the same `view` beacon counts a view of the file, from the
 *    "Guides" channel with the guide's name as its campaign ("seen in <guide>"); and for a video,
 *    a PDF or a page, the engagement session the file's page on Markdrop would send
 *    (`/documents/{slug}/engage`, lib/engage.ts's wire format: watched ranges, pages read, active
 *    time), tagged the same way. Opted-out browsers (DNT, GPC) send no session at all.
 */
import { MediaAgg, PdfAgg, emptyDelta, type BridgeMessage, type EngageDelta, type EngagePos } from "@/lib/engageCore";

export interface EmbedTrackConfig {
  api: string;
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
