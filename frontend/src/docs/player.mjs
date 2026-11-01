/**
 * The pure parts of the docs video player (client/Player.tsx): time labels, WebVTT cues, chapters,
 * the remembered position and the keyboard map. No DOM, no React, so `node --test` covers them
 * (player.test.mjs) and the landing page's player shares them.
 */

/** 72 → "1:12", 3723 → "1:02:03"; anything not a finite non-negative number → "0:00". */
export function formatTime(sec) {
  const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** 72 → "1 minute 12 seconds" (for screen readers: aria-valuetext reads it better than "1:12"). */
export function spokenTime(sec) {
  const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const part = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const out = [];
  if (h) out.push(part(h, "hour"));
  if (m) out.push(part(m, "minute"));
  if (r || !out.length) out.push(part(r, "second"));
  return out.join(" ");
}

/** The scrubber's aria-valuetext: "1:12 of 2:15" (just "1:12" while the length is unknown). */
export function seekValueText(t, duration) {
  return Number.isFinite(duration) && duration > 0 ? `${formatTime(t)} of ${formatTime(duration)}` : formatTime(t);
}

/** "2:15" / "1:02:03" / "45" → seconds, or undefined. */
export function parseClock(s) {
  if (typeof s !== "string" || !/^\d+(:\d{1,2}){0,2}$/.test(s.trim())) return undefined;
  return s.trim().split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0);
}

/** A WebVTT timestamp (`01:02.500`, `1:01:02.500`) → seconds, or NaN. */
export function vttTime(t) {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2}(?:[.,]\d{1,3})?)\s*$/.exec(t ?? "");
  if (!m) return NaN;
  return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3].replace(",", "."));
}

/**
 * The cues of a WebVTT (or SRT: comma decimals, no header) text: [{ start, end, text }] in time
 * order. Markup like <v Name> or <b> is dropped; NOTE / STYLE / REGION blocks are skipped.
 */
export function parseVtt(src) {
  if (typeof src !== "string") return [];
  const out = [];
  for (const block of src.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0 || /^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const [a, b = ""] = lines[at].split("-->");
    const start = vttTime(a);
    const end = vttTime(b.trim().split(/\s+/)[0]);
    const text = lines
      .slice(at + 1)
      .map((l) => l.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean)
      .join("\n")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
    if (Number.isFinite(start) && text) out.push({ start, end: Number.isFinite(end) ? end : start, text });
  }
  return out.sort((x, y) => x.start - y.start);
}

/**
 * Chapters for the scrubber: each runs from its start to the next one's (the last to the end of
 * the video). Dropped: chapters at or past the end, and a repeat of the previous start.
 *   chapters: [{ start, text }]  →  [{ start, end, text }]
 */
export function chapterSpans(chapters, duration) {
  const list = (Array.isArray(chapters) ? chapters : [])
    .filter((c) => c && Number.isFinite(c.start) && c.start >= 0 && typeof c.text === "string" && c.text)
    .slice()
    .sort((a, b) => a.start - b.start);
  const known = Number.isFinite(duration) && duration > 0;
  const out = [];
  for (const c of list) {
    if (known && c.start >= duration) continue;
    if (out.length && out[out.length - 1].start === c.start) continue;
    out.push({ start: c.start, end: known ? duration : c.start, text: c.text });
  }
  for (let i = 0; i < out.length - 1; i++) out[i].end = out[i + 1].start;
  return out;
}

/** The index of the chapter playing at `t` (-1 before the first one). */
export function chapterAt(chapters, t) {
  let i = -1;
  for (let k = 0; k < (chapters?.length ?? 0); k++) if (t >= chapters[k].start) i = k;
  return i;
}

/** The furthest point buffered ahead of `t`, from a TimeRanges-like { length, start(i), end(i) }. */
export function bufferedEnd(ranges, t) {
  if (!ranges) return 0;
  let end = 0;
  for (let i = 0; i < ranges.length; i++) {
    const s = ranges.start(i), e = ranges.end(i);
    if (s <= t + 0.5 && e >= t) end = Math.max(end, e);
  }
  return end;
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/* ── remembered position ─────────────────────────────────────────────── */

/** Under this many seconds in, there's nothing to resume. */
export const RESUME_MIN = 5;
/** Within this many seconds of the end (or past 95 %), the video counts as watched. */
export const RESUME_TAIL = 10;

export function resumeKey(src) {
  return `dx-video-pos:${src}`;
}

/** Where to resume from, given what was saved and the length (if known), or null to start over. */
export function resumeFrom(saved, duration) {
  const t = typeof saved === "string" ? Number(saved) : saved;
  if (!Number.isFinite(t) || t < RESUME_MIN) return null;
  if (Number.isFinite(duration) && duration > 0 && (t >= duration - RESUME_TAIL || t >= duration * 0.95)) return null;
  return Math.floor(t);
}

/** What to store for position `t`: a number of whole seconds, or null to forget it. */
export function positionToSave(t, duration, ended = false) {
  if (ended) return null;
  return resumeFrom(t, duration);
}

/* ── keyboard ────────────────────────────────────────────────────────── */

export const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

/**
 * What a key does (YouTube's keys), or null for keys the player leaves alone.
 *   { type: "toggle" } | { type: "seekBy", by } | { type: "seekPct", pct } | { type: "seekTo", at }
 *   | { type: "volumeBy", by } | { type: "mute" } | { type: "fullscreen" } | { type: "captions" }
 * Modified keys (Ctrl, Meta, Alt) are never the player's.
 */
export function keyAction(e) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey) return null;
  const k = e.key;
  switch (k) {
    case " ":
    case "k":
    case "K":
      return { type: "toggle" };
    case "ArrowLeft":
      return { type: "seekBy", by: -5 };
    case "ArrowRight":
      return { type: "seekBy", by: 5 };
    case "j":
    case "J":
      return { type: "seekBy", by: -10 };
    case "l":
    case "L":
      return { type: "seekBy", by: 10 };
    case "ArrowUp":
      return { type: "volumeBy", by: 0.05 };
    case "ArrowDown":
      return { type: "volumeBy", by: -0.05 };
    case "m":
    case "M":
      return { type: "mute" };
    case "f":
    case "F":
      return { type: "fullscreen" };
    case "c":
    case "C":
      return { type: "captions" };
    case "Home":
      return { type: "seekTo", at: 0 };
    case "End":
      return { type: "seekPct", pct: 100 };
    default:
      if (/^[0-9]$/.test(k)) return { type: "seekPct", pct: Number(k) * 10 };
      return null;
  }
}
