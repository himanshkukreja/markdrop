/**
 * Reader signals for a Markdrop Guides site: the pure parts of client/Signals.tsx (tested in
 * signals.test.mjs). What a page view sends, once, when the reader leaves it (backend
 * services/guide_signals.py): how far down the page they got, the videos they played (which 40ths
 * of each), and the code blocks they copied. Never a cookie, storage, an id, or anything typed.
 */

/** Slices a video's length is cut into (2.5% each). */
export const SLICES = 40;
/** A view shorter than this (seconds on screen) is a bounce: nothing is sent. */
export const MIN_SECONDS = 3;
export const MAX_SECTIONS = 200;
export const MAX_COPIES = 20;
export const MAX_VIDEOS = 6;
export const MAX_EMBEDS = 10;
/** The event an embedded Markdrop file dispatches on its element (it bubbles to the document). */
export const EMBED_EVENT = "md:embed-signal";
/** A heading counts as reached once its top passes this share of the window's height. */
export const REACH_LINE = 0.75;

/**
 * Does the browser ask not to be tracked? Do Not Track ("1", or "yes" in old Firefox) or Global
 * Privacy Control. Then no signal is ever sent.
 */
export function optedOut(nav, win) {
  const dnt = (nav && (nav.doNotTrack ?? nav.msDoNotTrack)) ?? (win && win.doNotTrack);
  if (dnt === "1" || dnt === "yes" || dnt === 1) return true;
  return !!(nav && nav.globalPrivacyControl === true);
}

/** A guide's sampling rate (site.json `signals.sample`): a number in (0, 1], else 1. */
export function sampleRate(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 1;
}

/** Is this view measured? `rand` in [0, 1). The weight a measured view carries is 1 / rate. */
export function sampled(rate, rand) {
  return rand < sampleRate(rate);
}

export function weightOf(rate) {
  return Math.min(20, Math.max(1, Math.round(1 / sampleRate(rate))));
}

/**
 * The deepest section reached: `tops` are the headings' tops relative to the window (px, in page
 * order), `height` the window's height. -1 when none has come up yet (the introduction).
 */
export function deepestReached(tops, height, line = REACH_LINE) {
  let d = -1;
  const y = height * line;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] <= y) d = i;
    else break;
  }
  return d;
}

/** The section (index of the last heading above it) a point on the page belongs to; -1 the intro. */
export function sectionAt(headingYs, y) {
  let s = -1;
  for (let i = 0; i < headingYs.length; i++) {
    if (headingYs[i] <= y) s = i;
    else break;
  }
  return s;
}

/** The slice (0..39) a moment of a video falls in. */
export function sliceOf(time, duration) {
  if (!(duration > 0) || !(time >= 0)) return -1;
  return Math.min(SLICES - 1, Math.floor((time / duration) * SLICES));
}

/**
 * Marks the slices played between two moments (a normal step of playback, not a seek: callers
 * pass `from` only when the step is under a couple of seconds). Returns the new bitmask.
 */
export function markPlayed(mask, from, to, duration) {
  const a = sliceOf(Math.min(from, to), duration);
  const b = sliceOf(Math.max(from, to), duration);
  if (a < 0 || b < 0) return mask;
  let m = mask;
  // Arithmetic, not `|=`: bitwise operators cut numbers to 32 bits, and there are 40 slices.
  for (let i = a; i <= b; i++) if (Math.floor(m / 2 ** i) % 2 === 0) m += 2 ** i;
  return m;
}

/** A 40-slice bitmask as 10 hex digits (what the API reads). Numbers stay exact up to 2^53. */
export function maskHex(mask) {
  return Math.max(0, Math.floor(mask)).toString(16).padStart(10, "0").slice(-10);
}

/**
 * An embed's signal (the `md:embed-signal` event's detail, from an embedded Markdrop file on the
 * page) merged into what this view has for it: videos keep every slice played (or the furthest
 * quartile / second when that's all the embed reports), PDFs the furthest page reached. Returns
 * the new entry, or `prev` when the detail can't be used.
 */
export function mergeEmbed(prev, d) {
  if (!d || typeof d !== "object") return prev;
  const i = cleanId(d.id);
  const name = typeof d.name === "string" ? d.name.slice(0, 120) : undefined;
  if (!i) return prev;
  if (d.kind === "video") {
    const length = Number(d.length);
    if (!(length > 0)) return prev;
    const out = { i, k: "video", l: Math.round(length), mask: prev?.mask || 0, q: prev?.q || 0, s: prev?.s || 0, ...(name ? { name } : prev?.name ? { name: prev.name } : {}) };
    if (typeof d.mask === "number" && d.mask > 0) {
      for (let b = 0; b < SLICES; b++) if (Math.floor(d.mask / 2 ** b) % 2 === 1 && Math.floor(out.mask / 2 ** b) % 2 === 0) out.mask += 2 ** b;
    }
    if (typeof d.from === "number" && typeof d.to === "number") out.mask = markPlayed(out.mask, d.from, d.to, length);
    if (Number.isInteger(d.quartile) && d.quartile >= 1 && d.quartile <= 4) out.q = Math.max(out.q, d.quartile);
    if (typeof d.seconds === "number" && d.seconds > 0) out.s = Math.max(out.s, Math.min(length, Math.round(d.seconds)));
    return out;
  }
  if (d.kind === "pdf") {
    const n = Math.round(Number(d.pages));
    const r = Math.round(Number(d.page));
    if (!(n >= 1) || !(r >= 1)) return prev;
    return { i, k: "pdf", n, r: Math.max(prev?.r || 0, Math.min(n, r)), ...(name ? { name } : prev?.name ? { name: prev.name } : {}) };
  }
  return prev;
}

/** An embed entry as the beacon carries it (see backend services/guide_signals.py, Embeds). */
export function embedEntry(e) {
  if (!e) return null;
  if (e.k === "pdf") return { i: e.i, k: "pdf", n: e.n, r: e.r, ...(e.name ? { name: e.name } : {}) };
  const out = { i: e.i, k: "video", l: e.l, ...(e.name ? { name: e.name } : {}) };
  if (e.mask) out.b = maskHex(e.mask);
  else if (e.q) out.q = e.q;
  else if (e.s) out.s = e.s;
  else return null;
  return out;
}

/** A heading or video id as the API takes it (the author's slug), or null. */
export function cleanId(v) {
  return typeof v === "string" && /^[\p{L}\p{M}\p{N}_\-.:~%]{1,120}$/u.test(v) ? v : null;
}

/**
 * The beacon of one page view, or null when there is nothing worth sending (a bounce, or a page
 * with no path). `view`: {path, n, deepest, end, ids, seconds, copies: [[s, b]], videos: Map(id →
 * {length, mask})}; `rate` the sampling rate.
 */
export function readBeacon(view, rate = 1) {
  if (!view || typeof view.path !== "string" || !view.path.startsWith("/")) return null;
  const seconds = Math.round(view.seconds || 0);
  const videos = [];
  for (const [id, v] of view.videos || []) {
    const vid = cleanId(id);
    if (!vid || !(v.length > 0) || !v.mask) continue;
    videos.push({ i: vid, l: Math.round(v.length), b: maskHex(v.mask) });
    if (videos.length >= MAX_VIDEOS) break;
  }
  const embeds = [];
  for (const e of (view.embeds || new Map()).values()) {
    const entry = embedEntry(e);
    if (entry) embeds.push(entry);
    if (embeds.length >= MAX_EMBEDS) break;
  }
  if (seconds < MIN_SECONDS && !videos.length && !embeds.length) return null;
  const n = Math.min(MAX_SECTIONS, Math.max(0, view.n | 0));
  const d = view.end ? n : Math.min(n, Math.max(-1, view.deepest | 0));
  const out = { k: "read", p: view.path.split("#")[0].split("?")[0], n, d, t: seconds, w: weightOf(rate) };
  const h = d >= 0 && d < n ? cleanId((view.ids || [])[d]) : null;
  if (h) out.h = h;
  if (view.copies && view.copies.length) out.c = view.copies.slice(0, MAX_COPIES);
  if (videos.length) out.v = videos;
  if (embeds.length) out.e = embeds;
  return out;
}

/** The 404 page's beacon: the missing address, and the guide page the reader came from (same origin only). */
export function brokenBeacon(path, referrer, origin) {
  if (typeof path !== "string" || !path.startsWith("/") || path === "/") return null;
  const out = { k: "broken", p: path.split("#")[0].split("?")[0] };
  try {
    if (referrer) {
      const r = new URL(referrer);
      if (r.origin === origin && r.pathname !== out.p) out.f = r.pathname;
    }
  } catch {
    /* not an address */
  }
  return out;
}
