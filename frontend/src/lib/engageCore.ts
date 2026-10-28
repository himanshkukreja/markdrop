/**
 * The pure half of the engagement tracker (lib/engage.ts): hashing, link keys, the media and PDF
 * accumulators that turn viewer events into `/engage` deltas, and the scroll-spy pick. No DOM, no
 * imports, so `node --test src/lib/engageCore.test.mjs` runs it as is (Node >= 22.18 strips the
 * types). Wire format: analytics-v1 build spec §1b; names and units here must match it exactly.
 */

/** Seconds per send are counted by the session; everything here is a delta since the last send. */
export interface MediaDelta {
  dur?: number;
  segs?: [number, number][];
  plays?: number;
  ended?: number;
  seeks?: number;
  speed?: Record<string, number>;
  fs_s?: number;
  pip_s?: number;
  muted_s?: number;
  startup_ms?: number;
  rebuf_n?: number;
  rebuf_ms?: number;
  err?: "network" | "decode" | "src" | "expired" | "other";
  dropped?: number;
  frames?: number;
}

export interface EngageDelta {
  active_s?: number;
  depth?: number;
  reached?: string[];
  sec?: Record<string, number>;
  copies?: Record<string, number>;
  links?: Record<string, number>;
  print?: number;
  pages?: Record<string, number>;
  npages?: number;
  pmax?: number;
  rv?: Record<string, number>;
  media?: MediaDelta;
}

export type EngagePos = { s: number } | { h: string } | { p: number };

/** One message from the Worker viewer frame (§1c), already origin- and source-checked. */
export interface BridgeMessage {
  md: 1;
  ev: "pdf" | "page" | "media";
  n?: number;
  p?: number;
  e?: string;
  t?: number;
  dur?: number | null;
  rate?: number;
  muted?: boolean;
  fs?: boolean;
  pip?: boolean;
  q?: { dropped: number; frames: number } | null;
  /** error only: MediaError.code, and the HTTP status of a 1-byte probe of the source (0: failed). */
  code?: number;
  http?: number;
}

const SEGS_PER_SEND = 50;
const SEGS_PENDING_MAX = 400;
/** A position more than this far from where steady playback would have put it is a jump (§7). */
const JUMP_S = 2;

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

export function addTo(map: Record<string, number>, key: string, n = 1): void {
  map[key] = (map[key] ?? 0) + n;
}

/** FNV-1a 32-bit over the UTF-8 bytes, as 8 lower-case hex digits. Copies are counted by this, never by their text. */
export function fnv1a32(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** `<fnv1a32 of the trimmed code>|<section id or ''>` */
export function copyKey(code: string, section: string | null): string {
  return `${fnv1a32(code.trim())}|${section ?? ""}`;
}

/**
 * `<host+path, ≤200>|<section id or ''>` for a clicked link, or null when it isn't one we count:
 * in-page (#) links and anything that isn't http(s) (mailto: would leak an address). The query and
 * fragment are dropped; a `|` in the path is escaped so the section separator stays unambiguous.
 */
export function linkKey(href: string, base: string, section: string | null): string | null {
  if (!href || href.startsWith("#")) return null;
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const where = (u.host + u.pathname).replace(/\|/g, "%7C").slice(0, 200);
  return `${where}|${section ?? ""}`;
}

/** utm_source / utm_medium / utm_campaign from a query string, each ≤100 chars; null when none. */
export function utmFrom(search: string): { source?: string; medium?: string; campaign?: string } | null {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(search);
  } catch {
    return null;
  }
  const out: { source?: string; medium?: string; campaign?: string } = {};
  for (const k of ["source", "medium", "campaign"] as const) {
    const v = q.get(`utm_${k}`)?.trim();
    if (v) out[k] = v.slice(0, 100);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The scroll-spy pick of reading/useActiveHeading, over heading tops already measured (document
 * order): the last heading at or above `line`, the first when none is, the last when the scroller
 * is at its end. -1 for no headings.
 */
export function spyIndex(tops: number[], line: number, atEnd: boolean): number {
  if (!tops.length) return -1;
  if (atEnd) return tops.length - 1;
  let current = -1;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i]! - 1 <= line) current = i;
    else break;
  }
  return current < 0 ? 0 : current;
}

/** MediaError.code (+ the probe's HTTP status) → the §1b `err` vocabulary. */
export function mediaErr(code: number | undefined, http: number | undefined): NonNullable<MediaDelta["err"]> {
  if (http === 401 || http === 403 || http === 404 || http === 410) return "expired";
  if (code === 2) return "network";
  if (code === 3) return "decode";
  if (code === 4) return "src";
  return "other";
}

type MediaState = "idle" | "playing" | "paused" | "waiting" | "ended";

/**
 * Video / audio: the frame's events (§1c) in, `d.media` out.
 *
 * Watched ranges: while playing, each reported position extends the open segment when it is where
 * steady playback would have put it (last end + rate × wall seconds, within 2 s) and not behind
 * it; anything else (a jump, a loop, a seek) closes it and opens a new one. Seconds at a speed,
 * full screen, picture-in-picture and muted are the media seconds each extension covered, under the
 * state the previous message reported. The open segment is reported in pieces, so every send holds
 * only what is new; the server unions them.
 */
export class MediaAgg {
  dur = 0;
  durSent = 0;
  segs: [number, number][] = [];
  open: { e: number; from: number } | null = null;
  state: MediaState = "idle";
  lastWall = 0;
  rate = 1;
  fs = false;
  pip = false;
  muted = false;
  plays = 0;
  ended = 0;
  seeks = 0;
  lastSeekAt = -Infinity;
  seeking = false;
  speed: Record<string, number> = {};
  fsS = 0;
  pipS = 0;
  mutedS = 0;
  playReqAt: number | null = null;
  firstPlaying = false;
  startupMs: number | null = null;
  startupSent = false;
  waitAt: number | null = null;
  rebufN = 0;
  rebufMs = 0;
  err: MediaDelta["err"] | null = null;
  errSent = false;
  q: { dropped: number; frames: number } | null = null;
  dropped = 0;
  frames = 0;
  pos: number | null = null;

  playing(): boolean {
    return this.state === "playing";
  }

  handle(m: BridgeMessage, now: number): void {
    const e = m.e ?? "";
    const t = fin(m.t) && m.t >= 0 ? m.t : null;
    if (fin(m.dur) && m.dur > 0) this.dur = m.dur;
    // Extend under the state the previous message described, before taking this one's.
    if (t != null && this.state === "playing" && e !== "seeking") this.advance(t, now);
    if (fin(m.rate) && m.rate > 0) this.rate = m.rate;
    if (typeof m.fs === "boolean") this.fs = m.fs;
    if (typeof m.pip === "boolean") this.pip = m.pip;
    if (typeof m.muted === "boolean") this.muted = m.muted;
    if (m.q && fin(m.q.frames) && fin(m.q.dropped)) {
      // A new <video> (the frame reloaded) starts its counters again.
      const prev = this.q && m.q.frames >= this.q.frames ? this.q : { dropped: 0, frames: 0 };
      this.frames += Math.max(0, m.q.frames - prev.frames);
      this.dropped += Math.max(0, m.q.dropped - prev.dropped);
      this.q = { dropped: m.q.dropped, frames: m.q.frames };
    }
    switch (e) {
      case "play":
        this.plays += 1;
        if (!this.firstPlaying && this.playReqAt == null) this.playReqAt = now;
        break;
      case "playing":
        if (!this.firstPlaying) {
          this.firstPlaying = true;
          if (this.playReqAt != null) this.startupMs = Math.min(120_000, Math.max(0, now - this.playReqAt));
        }
        this.endWait(now);
        this.seeking = false;
        this.state = "playing";
        this.lastWall = now;
        if (t != null) this.advance(t, now);
        break;
      case "pause":
        this.endWait(now);
        this.state = "paused";
        break;
      case "waiting":
        // A stall is a wait after playback began that no seek explains (buffering the new spot
        // after a seek is the seek's cost, not the network's).
        if (this.firstPlaying && !this.seeking && this.waitAt == null) {
          this.rebufN += 1;
          this.waitAt = now;
        }
        if (this.state === "playing") this.state = "waiting";
        break;
      case "seeking":
        this.closeOpen();
        this.endWait(now);
        // One scrub fires a burst of seeks; it is one seek.
        if (now - this.lastSeekAt > 1500) this.seeks += 1;
        this.lastSeekAt = now;
        this.seeking = true;
        break;
      case "ended":
        this.closeOpen();
        this.endWait(now);
        this.ended += 1;
        this.state = "ended";
        break;
      case "error":
        if (!this.err) this.err = mediaErr(m.code, m.http);
        break;
    }
    if (t != null) this.pos = t;
  }

  advance(t: number, now: number): void {
    const o = this.open;
    if (o) {
      const expected = o.e + this.rate * Math.max(0, (now - this.lastWall) / 1000);
      if (t >= o.e - 0.25 && t - expected <= JUMP_S) {
        const dt = Math.max(0, t - o.e);
        if (dt > 0) {
          addTo(this.speed, String(r2(this.rate)), dt);
          if (this.fs) this.fsS += dt;
          if (this.pip) this.pipS += dt;
          if (this.muted) this.mutedS += dt;
          o.e = t;
        }
        this.lastWall = now;
        return;
      }
      this.closeOpen();
    }
    this.open = { e: t, from: t };
    this.lastWall = now;
  }

  closeOpen(): void {
    this.flushOpen();
    this.open = null;
  }

  /** Moves the open segment's unsent part into `segs`. */
  flushOpen(): void {
    const o = this.open;
    if (o && o.e - o.from > 0.05) {
      if (this.segs.length < SEGS_PENDING_MAX) this.segs.push([o.from, o.e]);
      o.from = o.e;
    }
  }

  endWait(now: number): void {
    if (this.waitAt != null) this.rebufMs += Math.max(0, now - this.waitAt);
    this.waitAt = null;
  }

  /** What has happened since the last call, or null when nothing has. */
  drain(now: number): MediaDelta | null {
    const out: MediaDelta = {};
    if (this.dur > 0 && this.dur !== this.durSent) {
      out.dur = r2(this.dur);
      this.durSent = this.dur;
    }
    this.flushOpen();
    if (this.segs.length) out.segs = this.segs.splice(0, SEGS_PER_SEND).map(([s, e]) => [r2(s), r2(e)]);
    if (this.plays) out.plays = this.plays;
    if (this.ended) out.ended = this.ended;
    if (this.seeks) out.seeks = this.seeks;
    this.plays = this.ended = this.seeks = 0;
    const speed: Record<string, number> = {};
    for (const [k, v] of Object.entries(this.speed)) {
      const sent = r1(v);
      if (sent > 0) speed[k] = sent;
      this.speed[k] = v - sent; // the fraction rides along to the next send
    }
    if (Object.keys(speed).length) out.speed = speed;
    const take = (v: number) => r1(v);
    if (take(this.fsS) > 0) { out.fs_s = take(this.fsS); this.fsS -= out.fs_s; }
    if (take(this.pipS) > 0) { out.pip_s = take(this.pipS); this.pipS -= out.pip_s; }
    if (take(this.mutedS) > 0) { out.muted_s = take(this.mutedS); this.mutedS -= out.muted_s; }
    if (this.startupMs != null && !this.startupSent) {
      out.startup_ms = Math.round(this.startupMs);
      this.startupSent = true;
    }
    // A stall still going on is reported up to now and keeps counting from here.
    if (this.waitAt != null) {
      this.rebufMs += Math.max(0, now - this.waitAt);
      this.waitAt = now;
    }
    if (this.rebufN) out.rebuf_n = this.rebufN;
    if (Math.round(this.rebufMs) > 0) out.rebuf_ms = Math.round(this.rebufMs);
    this.rebufN = 0;
    this.rebufMs = 0;
    if (this.err && !this.errSent) {
      out.err = this.err;
      this.errSent = true;
    }
    if (this.dropped) out.dropped = this.dropped;
    if (this.frames) out.frames = this.frames;
    this.dropped = this.frames = 0;
    return Object.keys(out).length ? out : null;
  }
}

/**
 * PDF: the frame's `pdf` (page count) and `page` (current page) messages in; `pages` (active
 * seconds with each page current), `npages`, `pmax` and `rv` (a page becoming current again after
 * another one) out.
 */
export class PdfAgg {
  n = 0;
  nSent = 0;
  cur = 0;
  fresh = true;
  seen = new Set<number>();
  pmax = 0;
  pmaxSent = 0;
  pages: Record<string, number> = {};
  rv: Record<string, number> = {};

  handle(m: BridgeMessage): void {
    if (m.ev === "pdf" && fin(m.n) && m.n >= 1) {
      this.n = Math.floor(m.n);
      // The frame (re)loaded: its first page report is where it opens, not a return.
      this.fresh = true;
    } else if (m.ev === "page" && fin(m.p) && m.p >= 1) {
      const p = Math.floor(m.p);
      if (p === this.cur) return;
      if (this.seen.has(p) && !this.fresh) addTo(this.rv, String(p));
      this.fresh = false;
      this.seen.add(p);
      this.cur = p;
      this.pmax = Math.max(this.pmax, p);
    }
  }

  /** One second of reading went by. */
  second(): void {
    if (this.cur) addTo(this.pages, String(this.cur));
  }

  drain(d: EngageDelta): void {
    if (Object.keys(this.pages).length) d.pages = this.pages;
    if (this.n && this.n !== this.nSent) {
      d.npages = this.n;
      this.nSent = this.n;
    }
    if (this.pmax > this.pmaxSent) {
      d.pmax = this.pmax;
      this.pmaxSent = this.pmax;
    }
    if (Object.keys(this.rv).length) d.rv = this.rv;
    this.pages = {};
    this.rv = {};
  }
}

/** True when a delta carries nothing. */
export function emptyDelta(d: EngageDelta): boolean {
  return Object.keys(d).length === 0;
}
