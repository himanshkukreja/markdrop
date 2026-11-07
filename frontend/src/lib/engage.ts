"use client";

/**
 * Creator analytics: how a document or file was actually read, watched or listened to, reported to
 * `POST /api/v1/documents/{slug}/engage` (analytics-v1 build spec §1b, §1d, §7).
 *
 * One session per page load per document: a random `sid`, an increasing `seq`, and a body of
 * DELTAS since the previous send, every 15 s and once more (`final`) when the page is hidden, left
 * or unmounted. Active time follows lib/readDepth.ts: a second counts only while the tab is visible
 * and the reader did something in the last minute (or media is playing).
 *
 * Each send also carries the view's activity timeline (`ev`: sections, pages, slides and tabs with
 * their active seconds, playback, depth milestones, links, copies, downloads), the browser's
 * anonymous analytics id (`a`) and, first, where and on what it was opened (`first.sys`): the
 * owner's Viewers tab (backend services/doc_views.py). The first send goes out about a second in.
 *
 * What is never sent: copied text (only a hash of a copied code block), link queries or fragments,
 * anything typed, anything from an encrypted document beyond time, depth and page numbers. Nothing
 * here reaches PostHog or GA. Opted-out browsers (the admin "don't count me" flag, Global Privacy
 * Control) send nothing at all. The owner's own sessions are sent and kept apart on the server.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getToken, landingReferrer, landingUtm } from "@/lib/api";
import { analyticsVisitorId, previousRoute, trackingDisabled } from "@/lib/track";
import {
  DepthMarks,
  EV_PER_SEND,
  MediaAgg,
  MediaMarks,
  PdfAgg,
  Timeline,
  VisitTracker,
  addTo,
  copyKey,
  emptyDelta,
  fromFrameOrigin,
  linkKey,
  spyIndex,
  type BridgeMessage,
  type EngageDelta,
  type EngagePos,
  type TlEvent,
  type TrackSwitches,
  eventAllowed,
} from "@/lib/engageCore";

/** Which kinds of analytics an item collects (its document's `track`); missing means on. */
export type EngageTrack = TrackSwitches;

export type EngageKind = "doc" | "pdf" | "video" | "audio" | "other";

const API = process.env.NEXT_PUBLIC_API_URL ?? "https://api.markdrop.in";
const IDLE_MS = 60_000;
const REPORT_EVERY_MS = 15_000;
/** A visible tab nobody has touched for this long stops sending presence heartbeats. */
const HEARTBEAT_IDLE_MS = 5 * 60_000;
/** Focus inside the artifact frame stands in for input we can't see, for this long. */
const FRAME_FOCUS_MS = 5 * 60_000;
const MAX_BODY = 16384;
/** The first send goes out this soon, so the view is on the owner's list while it happens. */
const OPEN_SEND_MS = 1200;
/** Heading ids per send (a long document reached at once goes over a few sends). */
const REACHED_CHARS = 3000;

function randomId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** §1d: the admin "don't count me" flag, or Global Privacy Control. The view still counts, bare. */
export function engagementOptedOut(): boolean {
  if (typeof window === "undefined") return true;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return trackingDisabled() || nav.globalPrivacyControl === true;
}

/** The renderer → the session `k`. */
export function engageKindFor(renderer: string | null | undefined): EngageKind {
  return renderer === "pdf" || renderer === "video" || renderer === "audio" ? renderer : "other";
}

/** What a surface (markdown column, artifact frame) adds to a session. */
interface Collector {
  /** Once a second while the tab is visible; `active` says whether it counted as reading. */
  second?(active: boolean): void;
  /** Moves what has accumulated since the last send into `d` (`final`: the last send for now). */
  drain(d: EngageDelta, now: number, final: boolean): void;
  pos?(): EngagePos | undefined;
  /** Counts as active without input (media playing). */
  busy?(): boolean;
  /** Extra activity rule (focus inside the artifact frame). */
  engaged?(now: number, lastActivity: number): boolean;
}

interface SessionOptions {
  slug: string;
  kind: EngageKind;
  ver: number | null;
  ticket: () => string | null;
  collector: Collector;
  /** The session's activity timeline (viewer analytics); the collector marks into it too. */
  tl: Timeline;
  /** The item's analytics settings: what isn't collected isn't sent. */
  track?: EngageTrack | null;
}

/** A timeline for an item with these switches (events it doesn't collect are never queued). */
export function timelineFor(track: EngageTrack | null | undefined): Timeline {
  return new Timeline(Date.now(), track ? (k) => eventAllowed(k, track) : null);
}

/** Sessions running now: what lib/engage's `engageMark` adds an event to (a download, a print). */
const running = new Set<Timeline>();

/** Adds a timeline event to every engagement session on this page (downloads, exports). */
export function engageMark(k: "dl" | "print", extra: Record<string, unknown> = {}): void {
  for (const tl of running) tl.mark(k, extra);
}

/**
 * What the owner's Viewers tab says about where and on what this was opened: screen, language,
 * timezone, installed app vs browser tab vs embedded (and the embedding site), the Markdrop page
 * the reader came from, a touch screen (an iPad asking for desktop pages), and the real OS version
 * where the browser tells it (User-Agent Client Hints). No fingerprinting extras.
 */
export function systemInfo(app?: "tab" | "pwa" | "embed", track?: EngageTrack | null): Record<string, unknown> {
  const out = systemInfoAll(app);
  // Only what the item collects: device and system, location (timezone), source (where from).
  if (track?.device === false) for (const k of ["vw", "vh", "sw", "sh", "dpr", "lang", "app", "emb", "touch", "pv"]) delete out[k];
  if (track?.location === false) delete out.tz;
  if (track?.source === false) delete out.from;
  return out;
}

function systemInfoAll(app?: "tab" | "pwa" | "embed"): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    out.vw = window.innerWidth;
    out.vh = window.innerHeight;
    out.sw = window.screen?.width;
    out.sh = window.screen?.height;
    out.dpr = Math.round((window.devicePixelRatio || 1) * 100) / 100;
    out.lang = navigator.language;
    out.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let embedded = false;
    try {
      embedded = window.top !== window.self;
    } catch {
      embedded = true;
    }
    const nav = navigator as Navigator & { standalone?: boolean };
    out.app = app ?? (embedded ? "embed" : window.matchMedia?.("(display-mode: standalone)").matches || nav.standalone ? "pwa" : "tab");
    if (out.app === "embed") {
      const anc = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
      const host = anc && anc.length ? anc[anc.length - 1] : document.referrer;
      if (host) out.emb = new URL(host).host;
    }
    const from = previousRoute();
    if (from) out.from = from;
    if ((navigator.maxTouchPoints ?? 0) > 1) out.touch = true;
  } catch {
    /* whatever we couldn't read stays unsaid */
  }
  return out;
}

/** The real OS version, from Client Hints (Chromium only); resolves quickly or not at all. */
function platformVersion(): Promise<string | null> {
  const uad = (navigator as Navigator & { userAgentData?: { getHighEntropyValues?(h: string[]): Promise<{ platformVersion?: string }> } }).userAgentData;
  if (!uad?.getHighEntropyValues) return Promise.resolve(null);
  return Promise.race([
    uad.getHighEntropyValues(["platformVersion"]).then((v) => v.platformVersion || null).catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), 400)),
  ]);
}

interface Session {
  /** Marks the reader as active (input we only hear about indirectly, e.g. from the frame). */
  activity(): void;
  stop(): void;
}

function startSession({ slug, kind, ver, ticket, collector, tl, track }: SessionOptions): Session {
  const sid = randomId();
  const url = `${API}/api/v1/documents/${encodeURIComponent(slug)}/engage`;
  let seq = 0;
  let activeS = 0;
  let lastActivity = Date.now();
  let lastPos = "";
  let closed = false; // the last send was final and nothing has happened since
  const sys = systemInfo(undefined, track);
  const anon = analyticsVisitorId();
  running.add(tl);

  const visible = () => document.visibilityState === "visible";

  const send = (final: boolean) => {
    const now = Date.now();
    const d: EngageDelta = {};
    if (activeS > 0) d.active_s = Math.min(120, activeS);
    collector.drain(d, now, final);
    const pos = collector.pos?.();
    const posKey = pos ? JSON.stringify(pos) : "";
    // Periodic sends also keep the reader's live presence (45 s on the server) while they're here.
    const present = visible() && (now - lastActivity < HEARTBEAT_IDLE_MS || !!collector.busy?.());
    const hasEv = tl.q.length > 0;
    if (emptyDelta(d) && !hasEv && !(final ? seq > 0 && !closed : present || posKey !== lastPos || seq === 0)) return;
    closed = final;
    activeS -= d.active_s ?? 0;
    lastPos = posKey;
    seq += 1;
    const ev: TlEvent[] = tl.take(EV_PER_SEND);
    const body: Record<string, unknown> = { v: 1, sid, k: kind, seq, final, d };
    if (ev.length) body.ev = ev;
    if (anon) body.a = anon;
    const t = ticket();
    if (t) body.t = t;
    const u = getToken();
    if (u) body.u = u;
    if (ver != null) body.ver = ver;
    if (pos) body.pos = pos;
    if (seq === 1) {
      const first: Record<string, unknown> = { vw: window.innerWidth, sys };
      if (track?.source !== false) {
        const ref = landingReferrer();
        if (ref) first.ref = ref.slice(0, 512);
        const utm = landingUtm();
        if (utm) first.utm = utm;
      }
      body.first = first;
    }
    let text = JSON.stringify(body);
    // Over the server's limit (only a very long heading list can do it): lose the list, not the send.
    if (new Blob([text]).size > MAX_BODY && d.reached) {
      delete d.reached;
      text = JSON.stringify(body);
    }
    // Still over: the events wait for the next send.
    while (new Blob([text]).size > MAX_BODY && ev.length) {
      if (ev.length > 1) tl.giveBack(ev.splice(Math.ceil(ev.length / 2)));
      else ev.length = 0; // one event too big to send at all: dropped
      if (ev.length) body.ev = ev;
      else delete body.ev;
      text = JSON.stringify(body);
    }
    try {
      if (final && navigator.sendBeacon?.(url, new Blob([text], { type: "text/plain" }))) return;
      // text/plain, no credentials: a CORS "simple" request, no preflight.
      void fetch(url, { method: "POST", body: text, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(() => {});
    } catch {
      /* analytics must never break reading */
    }
  };

  const tick = setInterval(() => {
    if (!visible()) return;
    const now = Date.now();
    const active =
      now - lastActivity < IDLE_MS || !!collector.busy?.() || !!collector.engaged?.(now, lastActivity);
    if (active) activeS += 1;
    collector.second?.(active);
  }, 1000);
  const periodic = setInterval(() => send(false), REPORT_EVERY_MS);
  // The view is on the owner's list right away (the real OS version first, where it's quick).
  let opened = false;
  const openSend = setTimeout(() => {
    void platformVersion().then((pv) => {
      if (pv && track?.device !== false) sys.pv = pv;
      if (!opened && seq === 0) send(false);
      opened = true;
    });
  }, OPEN_SEND_MS);
  const onFullscreen = () => tl.mark("fs", { on: !!document.fullscreenElement });

  const onActivity = () => {
    lastActivity = Date.now();
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") send(true);
    else lastActivity = Date.now();
  };
  const onPageHide = () => send(true);

  document.addEventListener("scroll", onActivity, { capture: true, passive: true });
  window.addEventListener("pointermove", onActivity, { passive: true });
  window.addEventListener("pointerdown", onActivity, { passive: true });
  window.addEventListener("keydown", onActivity);
  window.addEventListener("wheel", onActivity, { passive: true });
  window.addEventListener("touchstart", onActivity, { passive: true });
  window.addEventListener("resize", onActivity);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("fullscreenchange", onFullscreen);

  return {
    activity: onActivity,
    stop() {
      send(true); // client-side navigation away, or the session ends (owner found, version changed)
      running.delete(tl);
      clearTimeout(openSend);
      document.removeEventListener("fullscreenchange", onFullscreen);
      clearInterval(tick);
      clearInterval(periodic);
      document.removeEventListener("scroll", onActivity, { capture: true });
      window.removeEventListener("pointermove", onActivity);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("wheel", onActivity);
      window.removeEventListener("touchstart", onActivity);
      window.removeEventListener("resize", onActivity);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    },
  };
}

// ── Markdown documents ─────────────────────────────────────────────────────────

/** The element that scrolls `el`: the immersive layer, or the page. */
function scrollerOf(el: HTMLElement): Element | null {
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight - n.clientHeight >= 2) return n;
  }
  return document.scrollingElement;
}

const HEADINGS = "h1[id], h2[id], h3[id], h4[id]";

/**
 * The markdown column: depth (lib/readDepth's measure), the section being read (the scroll-spy of
 * reading/useActiveHeading, same 30% line, same "at the end means the last heading"), sections
 * reached, code copies, link clicks and prints. An encrypted document reports depth only: its
 * heading ids are derived from its text.
 */
class DocCollector implements Collector {
  depth = 0;
  depthSent = 0;
  active: string | null = null;
  maxIdx = -1;
  allReached = false;
  reachedQueue: string[] = [];
  sec: Record<string, number> = {};
  copies: Record<string, number> = {};
  links: Record<string, number> = {};
  prints = 0;
  visits = new VisitTracker("sec", "h");
  depthMarks = new DepthMarks();

  constructor(
    readonly el: () => HTMLElement | null,
    readonly encrypted: boolean,
    readonly tl: Timeline,
    /** The item collects its activity timeline (sections, depth, links, copies). Off: time only. */
    readonly activity: boolean = true,
  ) {}

  headings(): HTMLElement[] {
    const node = this.el();
    if (!node) return [];
    // Only the rendered markdown's own headings (ids `user-content-…`), never the page's chrome.
    return Array.from(node.querySelectorAll<HTMLElement>(HEADINGS)).filter((h) => h.id.startsWith("user-content-"));
  }

  measure(): void {
    const node = this.el();
    if (!node) return;
    const r = node.getBoundingClientRect();
    if (r.height <= 0) return;
    const seen = (window.innerHeight - r.top) / r.height;
    this.depth = Math.max(this.depth, Math.max(0, Math.min(100, Math.round(seen * 100))));
    this.depthMarks.update(this.tl, this.depth);
  }

  second(active: boolean): void {
    if (!this.activity) return;
    this.measure();
    if (this.encrypted) return;
    const node = this.el();
    const list = this.headings();
    if (!node || !list.length) {
      this.active = null;
      return;
    }
    const s = scrollerOf(node);
    const atEnd = !!s && s.scrollHeight - s.clientHeight >= 2 && s.scrollHeight - s.clientHeight - s.scrollTop < 4;
    const idx = spyIndex(list.map((h) => h.getBoundingClientRect().top), window.innerHeight * 0.3, atEnd);
    this.active = list[idx]?.id ?? null;
    // Reached: every heading up to the furthest one read, and all of them once the end of the
    // document is on screen (a short document never moves the scroll-spy past its first heading).
    const upTo = this.depth >= 100 ? list.length - 1 : idx;
    if (upTo > this.maxIdx) {
      for (let i = this.maxIdx + 1; i <= upTo; i++) this.reachedQueue.push(list[i]!.id);
      this.maxIdx = upTo;
    }
    if (active && this.active) addTo(this.sec, this.active);
    // The timeline: a visit per section, with the active seconds spent in it.
    this.visits.enter(this.tl, this.active, Date.now());
    if (active) this.visits.second();
  }

  /** The section a node sits in: the last heading before it, or '' above the first. */
  sectionOf(node: Node | null): string | null {
    if (!node) return null;
    let id: string | null = null;
    for (const h of this.headings()) {
      if (h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) id = h.id;
      else break;
    }
    return id;
  }

  copy(code: string, node: HTMLElement | null): void {
    if (this.encrypted || !this.activity) return;
    const section = this.sectionOf(node);
    addTo(this.copies, copyKey(code, section));
    this.tl.mark("copy", section ? { h: section } : {});
  }

  click(e: MouseEvent): void {
    if (this.encrypted || !this.activity || (e.type === "auxclick" && e.button !== 1)) return;
    const node = this.el();
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!node || !a || !node.contains(a) || !a.closest(".md-prose")) return;
    const section = this.sectionOf(a);
    const key = linkKey(a.getAttribute("href") ?? "", window.location.href, section);
    if (key) {
      addTo(this.links, key);
      const where = key.slice(0, key.lastIndexOf("|"));
      this.tl.mark("link", section ? { u: where, h: section } : { u: where });
    }
  }

  print(): void {
    if (!this.activity) return;
    this.tl.mark("print");
    if (!this.encrypted) this.prints += 1;
  }

  drain(d: EngageDelta, now: number, final: boolean): void {
    if (!this.activity) return;
    this.measure();
    this.visits.flush(this.tl, final, now);
    if (this.depth > this.depthSent) {
      d.depth = this.depth;
      this.depthSent = this.depth;
    }
    if (this.encrypted) return;
    if (this.reachedQueue.length) {
      let chars = 0;
      let n = 0;
      while (n < this.reachedQueue.length && (n === 0 || chars + this.reachedQueue[n]!.length <= REACHED_CHARS)) {
        chars += this.reachedQueue[n]!.length;
        n += 1;
      }
      d.reached = this.reachedQueue.splice(0, n);
    }
    if (Object.keys(this.sec).length) d.sec = this.sec;
    if (Object.keys(this.copies).length) d.copies = this.copies;
    if (Object.keys(this.links).length) d.links = this.links;
    if (this.prints) d.print = this.prints;
    this.sec = {};
    this.copies = {};
    this.links = {};
    this.prints = 0;
  }

  pos(): EngagePos | undefined {
    return this.activity && !this.encrypted && this.active ? { h: this.active } : undefined;
  }
}

/**
 * Engagement for a markdown document. `enabled` must already exclude a locked or unreadable
 * document and the editor; opt-out is checked here. Returns the code-copy callback for
 * MarkdownPreview's `onCodeCopy` (a no-op while no session runs).
 */
export function useDocEngagement(
  slug: string,
  el: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  { encrypted, ticket, track = null }: { encrypted: boolean; ticket: string | null; track?: EngageTrack | null },
): (code: string, node: HTMLElement | null) => void {
  const ticketRef = useRef(ticket);
  ticketRef.current = ticket;
  const collectorRef = useRef<DocCollector | null>(null);

  useEffect(() => {
    if (!enabled || engagementOptedOut() || track?.counts === false) return;
    const tl = timelineFor(track);
    const collector = new DocCollector(() => el.current, encrypted, tl, track?.activity !== false);
    collectorRef.current = collector;
    const session = startSession({ slug, kind: "doc", ver: null, ticket: () => ticketRef.current, collector, tl, track });
    const onClick = (e: MouseEvent) => collector.click(e);
    const onPrint = () => collector.print();
    document.addEventListener("click", onClick, { capture: true });
    document.addEventListener("auxclick", onClick, { capture: true });
    window.addEventListener("beforeprint", onPrint);
    return () => {
      document.removeEventListener("click", onClick, { capture: true });
      document.removeEventListener("auxclick", onClick, { capture: true });
      window.removeEventListener("beforeprint", onPrint);
      session.stop();
      collectorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, el, enabled, encrypted, JSON.stringify(track ?? null)]);

  return useCallback((code: string, node: HTMLElement | null) => collectorRef.current?.copy(code, node), []);
}

// ── Artifacts ──────────────────────────────────────────────────────────────────

/**
 * Engagement for an artifact. pdf / video / audio listen to the Worker viewer's bridge (§1c):
 * a message is taken only from the frame we mounted (`source`), from its opaque origin ("null": the
 * frame is sandboxed without allow-same-origin) or the origin we pointed it at.
 * A deck reports its slides and a spreadsheet its tabs (the Worker's `slide`, `sheet` and `tab`
 * messages); every other kind reports active time only. Opt-out is checked here; `enabled` must
 * already exclude a locked file. The owner's own session runs too: the server keeps it out of the
 * numbers and files it under "your own views" (backend services/doc_views.py).
 */
export function useArtifactEngagement(
  slug: string,
  {
    enabled,
    kind,
    renderer,
    ver,
    ticket,
    frame,
    origin,
    track = null,
  }: {
    enabled: boolean;
    /** The item's analytics settings (its document's `track`). */
    track?: EngageTrack | null;
    kind: EngageKind;
    /** The file's renderer (pptx, sheet, …): what its frame reports beyond pdf and media. */
    renderer?: string | null;
    ver: number | null;
    ticket: string | null;
    frame: React.RefObject<HTMLIFrameElement | null>;
    origin: string | null;
  },
) {
  const ticketRef = useRef(ticket);
  ticketRef.current = ticket;

  useEffect(() => {
    if (!enabled || engagementOptedOut() || track?.counts === false) return;
    const tl = timelineFor(track);
    const video = track?.video !== false, pages = track?.pages !== false;
    const media = video && (kind === "video" || kind === "audio") ? new MediaAgg() : null;
    const marks = media ? new MediaMarks() : null;
    const pdf = pages && kind === "pdf" ? new PdfAgg() : null;
    // The timeline's units: PDF pages, slides, spreadsheet tabs (when the item collects pages).
    const visits = !pages ? null : pdf ? new VisitTracker("pg", "p") : renderer === "pptx" ? new VisitTracker("sl", "n")
      : renderer === "sheet" ? new VisitTracker("tab", "n") : null;
    const deck = { n: 0, nSent: 0, max: 0, maxSent: 0 };
    const sheet = { n: 0, nSent: 0, seen: new Set<number>(), sent: new Set<number>() };
    const collector: Collector = {
      second(active) {
        if (active) {
          pdf?.second();
          visits?.second();
        }
      },
      drain(d, now, final) {
        pdf?.drain(d);
        const m = media?.drain(now);
        if (m) d.media = m;
        visits?.flush(tl, final, now);
        if (deck.n && deck.n !== deck.nSent) d.nsl = deck.nSent = deck.n;
        if (deck.max > deck.maxSent) d.smax = deck.maxSent = deck.max;
        if (sheet.n && sheet.n !== sheet.nSent) d.ntab = sheet.nSent = sheet.n;
        const fresh = [...sheet.seen].filter((n) => !sheet.sent.has(n));
        if (fresh.length) {
          d.tabs = fresh;
          fresh.forEach((n) => sheet.sent.add(n));
        }
      },
      pos() {
        if (media && media.pos != null) return { s: Math.round(media.pos * 10) / 10 };
        if (pdf && pdf.cur) return { p: pdf.cur };
        return undefined;
      },
      busy: () => !!media?.playing(),
      // The reader's input inside the frame never reaches this window. While focus is in it (they
      // clicked into the artifact), that stands in for input, for a while.
      engaged(now, lastActivity) {
        const f = frame.current;
        return !!f && document.activeElement === f && now - lastActivity < FRAME_FOCUS_MS;
      },
    };
    const session = startSession({ slug, kind, ver, ticket: () => ticketRef.current, collector, tl, track });

    const onMessage = (e: MessageEvent) => {
      const f = frame.current;
      if (!f || !origin || e.source !== f.contentWindow || !fromFrameOrigin(e.origin, origin)) return;
      const m = e.data as BridgeMessage | null;
      if (!m || typeof m !== "object" || m.md !== 1) return;
      const now = Date.now();
      const n = typeof m.n === "number" && Number.isFinite(m.n) ? Math.floor(m.n) : null;
      if (pdf && (m.ev === "pdf" || m.ev === "page")) {
        pdf.handle(m);
        if (m.ev === "page" && pdf.cur) visits?.enter(tl, pdf.cur, now);
        session.activity();
      } else if (media && m.ev === "media") {
        media.handle(m, now);
        marks?.handle(tl, m, now);
        // A position report on its own isn't the reader doing anything.
        if (m.e !== "timeupdate") session.activity();
      } else if (pages && renderer === "pptx" && m.ev === "slide" && n != null && n >= 1) {
        if (typeof m.of === "number" && m.of >= 1) deck.n = Math.floor(m.of);
        deck.max = Math.max(deck.max, n);
        visits?.enter(tl, n, now);
        session.activity();
      } else if (pages && renderer === "sheet" && m.ev === "sheet" && n != null && n >= 1) {
        sheet.n = n;
      } else if (pages && renderer === "sheet" && m.ev === "tab" && n != null && n >= 0) {
        sheet.seen.add(n);
        const name = typeof m.name === "string" ? m.name.slice(0, 80) : "";
        visits?.enter(tl, n, now, name ? { name } : {});
        session.activity();
      }
    };
    const onBlur = () => {
      // Focus left this window for our frame: the reader clicked into the artifact.
      setTimeout(() => {
        if (frame.current && document.activeElement === frame.current) session.activity();
      }, 0);
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("blur", onBlur);
      session.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, enabled, kind, renderer, ver, origin, frame, JSON.stringify(track ?? null)]);
}

/**
 * True once sign-in has settled, or after `capMs` regardless: the view beacon reads the token
 * itself, so it waits only briefly (a workspace domain hands its token over just after load) and
 * never on a slow or retrying /auth/me.
 */
export function useAuthSettled(authLoading: boolean, capMs = 1500): boolean {
  const [capped, setCapped] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setCapped(true), capMs);
    return () => clearTimeout(t);
  }, [capMs]);
  return !authLoading || capped;
}
