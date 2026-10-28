// Engagement tracker helpers. Run: node --test src/lib/engageCore.test.mjs
// (Node >= 22.18 strips the types from engageCore.ts; it has no imports.)
import test from "node:test";
import assert from "node:assert/strict";
import { MediaAgg, PdfAgg, copyKey, fnv1a32, linkKey, mediaErr, spyIndex, utmFrom } from "./engageCore.ts";

test("fnv1a32 matches the reference vectors, over UTF-8", () => {
  assert.equal(fnv1a32(""), "811c9dc5");
  assert.equal(fnv1a32("a"), "e40c292c");
  assert.equal(fnv1a32("foobar"), "bf9cf968");
  assert.equal(fnv1a32("é"), fnv1a32("é")); // 2 UTF-8 bytes, hashed as bytes
  assert.notEqual(fnv1a32("é"), fnv1a32("e"));
});

test("copy keys hash the trimmed code and never carry it", () => {
  assert.equal(copyKey("  npm i markdrop\n", "user-content-install"), `${fnv1a32("npm i markdrop")}|user-content-install`);
  assert.equal(copyKey("x", null), `${fnv1a32("x")}|`);
});

test("link keys keep host + path only", () => {
  const base = "https://markdrop.in/doc";
  assert.equal(linkKey("https://GitHub.com/a/b?token=1#x", base, "user-content-a"), "github.com/a/b|user-content-a");
  assert.equal(linkKey("/other", base, null), "markdrop.in/other|");
  assert.equal(linkKey("#section", base, null), null);
  assert.equal(linkKey("mailto:someone@example.com", base, null), null);
  assert.equal(linkKey("javascript:alert(1)", base, null), null);
  assert.equal(linkKey("https://x.com/a|b", base, "s"), "x.com/a%7Cb|s");
  assert.equal(linkKey(`https://x.com/${"p".repeat(400)}`, base, "").split("|")[0].length, 200);
});

test("utm: the three fields, trimmed to 100", () => {
  assert.deepEqual(utmFrom("?utm_source=news&utm_medium=email&utm_campaign=oct&x=1"), { source: "news", medium: "email", campaign: "oct" });
  assert.equal(utmFrom("?ref=x"), null);
  assert.equal(utmFrom(`?utm_source=${"s".repeat(150)}`).source.length, 100);
});

test("scroll-spy pick", () => {
  assert.equal(spyIndex([], 300, false), -1);
  assert.equal(spyIndex([500, 900], 300, false), 0); // none crossed: the first
  assert.equal(spyIndex([-200, 100, 600], 300, false), 1);
  assert.equal(spyIndex([-200, 100, 600], 300, true), 2); // at the end: the last
});

test("media error vocabulary", () => {
  assert.equal(mediaErr(2, 200), "network");
  assert.equal(mediaErr(3, 206), "decode");
  assert.equal(mediaErr(4, 206), "src");
  assert.equal(mediaErr(4, 403), "expired");
  assert.equal(mediaErr(1, 0), "other");
});

const msg = (e, t, extra = {}) => ({ md: 1, ev: "media", e, t, dur: 100, rate: 1, muted: false, fs: false, pip: false, ...extra });

test("continuous playback is one segment, reported in pieces", () => {
  const a = new MediaAgg();
  a.handle(msg("play", 0), 0);
  a.handle(msg("playing", 0), 400);
  for (let s = 1; s <= 10; s++) a.handle(msg("timeupdate", s), 400 + s * 1000);
  const first = a.drain(11_000);
  assert.deepEqual(first.segs, [[0, 10]]);
  assert.equal(first.plays, 1);
  assert.equal(first.startup_ms, 400);
  assert.equal(first.dur, 100);
  assert.deepEqual(first.speed, { 1: 10 });
  for (let s = 11; s <= 15; s++) a.handle(msg("timeupdate", s), 400 + s * 1000);
  const second = a.drain(16_000);
  assert.deepEqual(second.segs, [[10, 15]]);
  assert.equal(second.startup_ms, undefined); // once
  assert.equal(second.dur, undefined); // once
});

test("a seek or a jump starts a new segment; a scrub is one seek", () => {
  const a = new MediaAgg();
  a.handle(msg("playing", 0), 0);
  a.handle(msg("timeupdate", 1), 1000);
  a.handle(msg("timeupdate", 2), 2000);
  a.handle(msg("seeking", 50), 2100);
  a.handle(msg("seeking", 55), 2200);
  a.handle(msg("seeking", 60), 2300);
  a.handle(msg("seeked", 60), 2400);
  a.handle(msg("timeupdate", 60), 2500);
  a.handle(msg("timeupdate", 61), 3500);
  a.handle(msg("timeupdate", 75), 4500); // 14 s ahead of where 1 s of playback lands: a jump
  a.handle(msg("timeupdate", 76), 5500);
  const d = a.drain(6000);
  assert.deepEqual(d.segs, [[0, 2], [60, 61], [75, 76]]);
  assert.equal(d.seeks, 1);
});

test("faster playback is still continuous", () => {
  const a = new MediaAgg();
  a.handle(msg("playing", 0, { rate: 2 }), 0);
  for (let s = 1; s <= 5; s++) a.handle(msg("timeupdate", s * 2.4, { rate: 2 }), s * 1200);
  const d = a.drain(7000);
  assert.deepEqual(d.segs, [[0, 12]]);
  assert.deepEqual(d.speed, { 2: 12 });
});

test("pause and resume in place keep one segment; going back starts another", () => {
  const a = new MediaAgg();
  a.handle(msg("playing", 0), 0);
  a.handle(msg("timeupdate", 5), 5000);
  a.handle(msg("pause", 5.2), 5200);
  a.handle(msg("play", 5.2), 60_000);
  a.handle(msg("playing", 5.2), 60_050);
  a.handle(msg("timeupdate", 6.2), 61_050);
  a.handle(msg("timeupdate", 1), 62_050); // went back (a loop, a replay without a seek event)
  a.handle(msg("timeupdate", 2), 63_050);
  const d = a.drain(64_000);
  assert.deepEqual(d.segs, [[0, 6.2], [1, 2]]);
  assert.equal(d.plays, 1);
});

test("full screen, muted and picture-in-picture seconds follow the state before each report", () => {
  const a = new MediaAgg();
  a.handle(msg("playing", 0), 0);
  a.handle(msg("fullscreen", 1, { fs: true }), 1000);
  a.handle(msg("timeupdate", 4, { fs: true, muted: true }), 4000);
  a.handle(msg("timeupdate", 6, { fs: true, muted: true }), 6000);
  const d = a.drain(7000);
  assert.equal(d.fs_s, 5);
  assert.equal(d.muted_s, 2);
  assert.equal(d.pip_s, undefined);
});

test("stalls: waits after the first playing, not those a seek explains", () => {
  const a = new MediaAgg();
  a.handle(msg("play", 0), 0);
  a.handle(msg("waiting", 0), 100); // startup, not a stall
  a.handle(msg("playing", 0), 1000);
  a.handle(msg("waiting", 3), 3000);
  a.handle(msg("playing", 3), 5300);
  a.handle(msg("seeking", 40), 6000);
  a.handle(msg("waiting", 40), 6100); // the seek's cost
  a.handle(msg("playing", 40), 7000);
  a.handle(msg("waiting", 42), 9000);
  const d = a.drain(9500); // still stalled: counted up to now
  assert.equal(d.startup_ms, 1000);
  assert.equal(d.rebuf_n, 2);
  assert.equal(d.rebuf_ms, 2300 + 500);
  a.handle(msg("playing", 42), 10_000);
  assert.equal(a.drain(10_500).rebuf_ms, 500);
});

test("ended, errors once, and frame-quality deltas", () => {
  const a = new MediaAgg();
  a.handle(msg("playing", 98, { q: { dropped: 1, frames: 100 } }), 0);
  a.handle(msg("timeupdate", 99, { q: { dropped: 3, frames: 130 } }), 1000);
  a.handle(msg("pause", 100), 2000);
  a.handle(msg("ended", 100), 2001);
  a.handle({ ...msg("error", 100), code: 2, http: 200 }, 3000);
  a.handle({ ...msg("error", 100), code: 3, http: 200 }, 3100);
  const d = a.drain(4000);
  assert.deepEqual(d.segs, [[98, 100]]);
  assert.equal(d.ended, 1);
  assert.equal(d.err, "network");
  assert.equal(d.frames, 130);
  assert.equal(d.dropped, 3);
  a.handle(msg("timeupdate", 100, { q: { dropped: 0, frames: 10 } }), 5000); // a new <video>
  const e = a.drain(6000);
  assert.equal(e.err, undefined);
  assert.equal(e.frames, 10);
});

test("pdf: seconds per current page, furthest page, returns", () => {
  const p = new PdfAgg();
  p.handle({ md: 1, ev: "pdf", n: 12 });
  p.handle({ md: 1, ev: "page", p: 1 });
  p.second();
  p.second();
  p.handle({ md: 1, ev: "page", p: 2 });
  p.second();
  p.handle({ md: 1, ev: "page", p: 1 });
  p.second();
  p.handle({ md: 1, ev: "page", p: 7 });
  const d = {};
  p.drain(d);
  assert.deepEqual(d, { pages: { 1: 3, 2: 1 }, npages: 12, pmax: 7, rv: { 1: 1 } });
  const e = {};
  p.drain(e);
  assert.deepEqual(e, {}); // nothing new
  p.handle({ md: 1, ev: "pdf", n: 12 }); // the frame reloaded: back on page 1 isn't a return
  p.handle({ md: 1, ev: "page", p: 1 });
  const f = {};
  p.drain(f);
  assert.deepEqual(f, {});
});
