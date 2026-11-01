import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_COPIES, MAX_VIDEOS, brokenBeacon, cleanId, deepestReached, markPlayed, maskHex, optedOut, readBeacon, sampleRate,
  sampled, sectionAt, sliceOf, weightOf,
} from "./signals.mjs";

const view = (over = {}) => ({
  path: "/start", n: 4, deepest: 1, end: false, ids: ["install", "configure-the-agent", "send-data", "next-steps"],
  seconds: 40, copies: [], videos: new Map(), ...over,
});

test("opt-outs: Do Not Track and Global Privacy Control", () => {
  assert.equal(optedOut({ doNotTrack: "1" }), true);
  assert.equal(optedOut({ doNotTrack: "yes" }), true);
  assert.equal(optedOut({ msDoNotTrack: "1" }), true);
  assert.equal(optedOut({}, { doNotTrack: "1" }), true);
  assert.equal(optedOut({ globalPrivacyControl: true }), true);
  assert.equal(optedOut({ doNotTrack: "0", globalPrivacyControl: false }), false);
  assert.equal(optedOut({ doNotTrack: "unspecified" }), false);
  assert.equal(optedOut(undefined, undefined), false);
});

test("sampling", () => {
  assert.equal(sampleRate(undefined), 1);
  assert.equal(sampleRate(0), 1);
  assert.equal(sampleRate(2), 1);
  assert.equal(sampleRate("0.25"), 0.25);
  assert.equal(sampled(0.25, 0.1), true);
  assert.equal(sampled(0.25, 0.3), false);
  assert.equal(sampled(undefined, 0.999), true);
  assert.equal(weightOf(0.25), 4);
  assert.equal(weightOf(0.01), 20);
  assert.equal(weightOf(1), 1);
});

test("deepest section reached and the section of a point", () => {
  assert.equal(deepestReached([900, 1500], 800), -1); // still in the introduction
  assert.equal(deepestReached([100, 590, 700], 800), 1); // 600 is the reach line
  assert.equal(deepestReached([-2000, -1000, 300], 800), 2);
  assert.equal(deepestReached([], 800), -1);
  assert.equal(sectionAt([500, 1200, 2000], 100), -1);
  assert.equal(sectionAt([500, 1200, 2000], 1300), 1);
  assert.equal(sectionAt([500, 1200, 2000], 9000), 2);
});

test("video slices", () => {
  assert.equal(sliceOf(0, 100), 0);
  assert.equal(sliceOf(99.9, 100), 39);
  assert.equal(sliceOf(100, 100), 39);
  assert.equal(sliceOf(5, 0), -1);
  let m = markPlayed(0, 0, 7.4, 100); // slices 0..2
  assert.equal(maskHex(m), "0000000007");
  m = markPlayed(m, 97.6, 100, 100); // the last slice
  assert.equal(maskHex(m), "8000000007");
  assert.equal(markPlayed(m, 5, 4, 0), m);
  assert.equal(maskHex(2 ** 40 - 1), "ffffffffff");
});

test("ids are the author's slugs only", () => {
  assert.equal(cleanId("configure-the-agent"), "configure-the-agent");
  assert.equal(cleanId("café-setup"), "café-setup");
  assert.equal(cleanId("has space"), null);
  assert.equal(cleanId("<script>"), null);
  assert.equal(cleanId("x".repeat(121)), null);
  assert.equal(cleanId(5), null);
});

test("the read beacon: one per view, nothing a reader typed", () => {
  const b = readBeacon(view({ copies: [[1, 0]], videos: new Map([["tour", { length: 90.4, mask: 7 }]]) }));
  assert.deepEqual(b, { k: "read", p: "/start", n: 4, d: 1, t: 40, w: 1, h: "configure-the-agent", c: [[1, 0]],
    v: [{ i: "tour", l: 90, b: "0000000007" }] });
  assert.equal(Object.keys(b).some((k) => !["k", "p", "n", "d", "t", "w", "h", "c", "v"].includes(k)), false);
  // The end of the page.
  assert.deepEqual(readBeacon(view({ end: true })), { k: "read", p: "/start", n: 4, d: 4, t: 40, w: 1 });
  // The introduction: no heading id.
  assert.equal(readBeacon(view({ deepest: -1 })).h, undefined);
  // Bounces send nothing, unless a video was played.
  assert.equal(readBeacon(view({ seconds: 2 })), null);
  assert.notEqual(readBeacon(view({ seconds: 1, videos: new Map([["tour", { length: 10, mask: 1 }]]) })), null);
  // Paths lose their query and hash; weights follow the sampling rate; lists are capped.
  const many = readBeacon(view({ path: "/start?token=abc#x", copies: Array.from({ length: 50 }, (_, i) => [0, i]),
    videos: new Map(Array.from({ length: 10 }, (_, i) => [`v${i}`, { length: 10, mask: 1 }])) }), 0.5);
  assert.equal(many.p, "/start");
  assert.equal(many.w, 2);
  assert.equal(many.c.length, MAX_COPIES);
  assert.equal(many.v.length, MAX_VIDEOS);
  assert.equal(readBeacon(view({ path: "start" })), null);
  assert.equal(readBeacon(null), null);
  // Videos with an id that isn't a slug, or never played, are left out.
  assert.equal(readBeacon(view({ videos: new Map([["a b", { length: 9, mask: 1 }], ["x", { length: 9, mask: 0 }]]) })).v, undefined);
});

test("the 404 beacon", () => {
  assert.deepEqual(brokenBeacon("/guides/postgres?x=1", "https://docs.acme.com/start?y=2", "https://docs.acme.com"),
    { k: "broken", p: "/guides/postgres", f: "/start" });
  assert.deepEqual(brokenBeacon("/old", "https://www.google.com/search?q=private", "https://docs.acme.com"), { k: "broken", p: "/old" });
  assert.deepEqual(brokenBeacon("/old", "", "https://docs.acme.com"), { k: "broken", p: "/old" });
  assert.deepEqual(brokenBeacon("/old", "not a url", "https://docs.acme.com"), { k: "broken", p: "/old" });
  assert.equal(brokenBeacon("/", null, "https://docs.acme.com"), null);
});
