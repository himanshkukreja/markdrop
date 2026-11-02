/**
 * The docs video player's pure parts (player.mjs).
 *   node --test src/docs/player.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bufferedEnd,
  chapterAt,
  chapterSpans,
  formatTime,
  keyAction,
  parseClock,
  parseVtt,
  positionToSave,
  resumeFrom,
  resumeKey,
  seekValueText,
  spokenTime,
  vttTime,
} from "./player.mjs";

const VIDEOS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public/docs-assets/videos");

test("formatTime: m:ss under an hour, h:mm:ss over; junk is 0:00", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(9.9), "0:09");
  assert.equal(formatTime(72), "1:12");
  assert.equal(formatTime(135.1), "2:15");
  assert.equal(formatTime(3723), "1:02:03");
  assert.equal(formatTime(-4), "0:00");
  assert.equal(formatTime(NaN), "0:00");
  assert.equal(formatTime(Infinity), "0:00");
  assert.equal(formatTime(undefined), "0:00");
});

test("spokenTime and seekValueText", () => {
  assert.equal(spokenTime(72), "1 minute 12 seconds");
  assert.equal(spokenTime(61), "1 minute 1 second");
  assert.equal(spokenTime(0), "0 seconds");
  assert.equal(spokenTime(3600), "1 hour");
  assert.equal(seekValueText(72, 135), "1:12 of 2:15");
  assert.equal(seekValueText(72, NaN), "1:12");
  assert.equal(seekValueText(0, 0), "0:00");
});

test("parseClock reads videos.json durations", () => {
  assert.equal(parseClock("2:15"), 135);
  assert.equal(parseClock("1:02:03"), 3723);
  assert.equal(parseClock("45"), 45);
  assert.equal(parseClock("abc"), undefined);
  assert.equal(parseClock(undefined), undefined);
});

test("vttTime: WebVTT and SRT timestamps", () => {
  assert.equal(vttTime("00:01.500"), 1.5);
  assert.equal(vttTime("01:02:03.250"), 3723.25);
  assert.equal(vttTime("00:00:15,555"), 15.555);
  assert.ok(Number.isNaN(vttTime("nope")));
});

test("parseVtt: cues in order, markup stripped, NOTE blocks skipped, settings after the end time ignored", () => {
  const src = "﻿WEBVTT\r\n\r\nNOTE a comment --> not a cue\r\n\r\n2\r\n00:00:05.000 --> 00:00:09.000 align:start\r\n<v Narrator>Second</v> &amp; more\r\n\r\n1\r\n00:00:00.000 --> 00:00:05.000\r\nFirst <b>line</b>\r\ncontinued\r\n\r\n00:00:10.000 --> 00:00:11.000\r\n\r\n";
  assert.deepEqual(parseVtt(src), [
    { start: 0, end: 5, text: "First line\ncontinued" },
    { start: 5, end: 9, text: "Second & more" },
  ]);
  assert.deepEqual(parseVtt(""), []);
  assert.deepEqual(parseVtt(null), []);
});

test("parseVtt reads the trailer's chapters and captions files", () => {
  const chapters = parseVtt(fs.readFileSync(path.join(VIDEOS, "guides-trailer.vtt"), "utf8"));
  assert.equal(chapters.length, 8);
  assert.equal(chapters[0].text, "Docs go stale");
  assert.equal(chapters[0].start, 0);
  assert.equal(chapters[2].text, "The Fix list");
  assert.equal(chapters[7].text, "Make it yours");
  const captions = parseVtt(fs.readFileSync(path.join(VIDEOS, "guides-trailer.captions.vtt"), "utf8"));
  assert.ok(captions.length > 20);
  assert.equal(captions[0].text, "Your product ships every week. Your docs fall behind.");
  assert.ok(captions.every((c) => c.end > c.start));
});

test("chapterSpans: each chapter runs to the next; the last to the end; bad and late ones dropped", () => {
  const spans = chapterSpans(
    [
      { start: 30, text: "B" },
      { start: 0, text: "A" },
      { start: 30, text: "dup" },
      { start: 200, text: "past the end" },
      { start: NaN, text: "bad" },
      { start: 50, text: "" },
    ],
    135,
  );
  assert.deepEqual(spans, [
    { start: 0, end: 30, text: "A" },
    { start: 30, end: 135, text: "B" },
  ]);
  // Length unknown yet: the last span is empty until it is.
  assert.deepEqual(chapterSpans([{ start: 0, text: "A" }, { start: 10, text: "B" }], NaN), [
    { start: 0, end: 10, text: "A" },
    { start: 10, end: 10, text: "B" },
  ]);
  assert.deepEqual(chapterSpans(undefined, 10), []);
});

test("chapterAt", () => {
  const ch = [{ start: 0 }, { start: 15 }, { start: 32 }];
  assert.equal(chapterAt(ch, 0), 0);
  assert.equal(chapterAt(ch, 14.9), 0);
  assert.equal(chapterAt(ch, 15), 1);
  assert.equal(chapterAt(ch, 999), 2);
  assert.equal(chapterAt([{ start: 5 }], 1), -1);
  assert.equal(chapterAt([], 1), -1);
});

test("bufferedEnd: the range holding the playhead", () => {
  const r = (pairs) => ({ length: pairs.length, start: (i) => pairs[i][0], end: (i) => pairs[i][1] });
  assert.equal(bufferedEnd(r([[0, 12], [40, 60]]), 5), 12);
  assert.equal(bufferedEnd(r([[0, 12], [40, 60]]), 45), 60);
  assert.equal(bufferedEnd(r([[0, 12], [40, 60]]), 20), 0);
  assert.equal(bufferedEnd(null, 3), 0);
});

test("resume: nothing under 5 s or near the end; whole seconds otherwise", () => {
  assert.equal(resumeKey("/docs-assets/videos/a.mp4"), "dx-video-pos:/docs-assets/videos/a.mp4");
  assert.equal(resumeFrom(null, 135), null);
  assert.equal(resumeFrom("junk", 135), null);
  assert.equal(resumeFrom(3, 135), null);
  assert.equal(resumeFrom(72.6, 135), 72);
  assert.equal(resumeFrom("72.6", 135), 72);
  assert.equal(resumeFrom(126, 135), null); // within 10 s of the end
  assert.equal(resumeFrom(72, undefined), 72); // length unknown
  assert.equal(resumeFrom(300, 1000), 300);
  assert.equal(resumeFrom(960, 1000), null); // past 95 %
  assert.equal(positionToSave(72.4, 135), 72);
  assert.equal(positionToSave(72.4, 135, true), null);
  assert.equal(positionToSave(2, 135), null);
});

test("keyAction: YouTube's keys; modified keys are left alone", () => {
  assert.deepEqual(keyAction({ key: " " }), { type: "toggle" });
  assert.deepEqual(keyAction({ key: "k" }), { type: "toggle" });
  assert.deepEqual(keyAction({ key: "ArrowLeft" }), { type: "seekBy", by: -5 });
  assert.deepEqual(keyAction({ key: "ArrowRight" }), { type: "seekBy", by: 5 });
  assert.deepEqual(keyAction({ key: "j" }), { type: "seekBy", by: -10 });
  assert.deepEqual(keyAction({ key: "L" }), { type: "seekBy", by: 10 });
  assert.deepEqual(keyAction({ key: "ArrowUp" }), { type: "volumeBy", by: 0.05 });
  assert.deepEqual(keyAction({ key: "ArrowDown" }), { type: "volumeBy", by: -0.05 });
  assert.deepEqual(keyAction({ key: "m" }), { type: "mute" });
  assert.deepEqual(keyAction({ key: "f" }), { type: "fullscreen" });
  assert.deepEqual(keyAction({ key: "c" }), { type: "captions" });
  assert.deepEqual(keyAction({ key: "0" }), { type: "seekPct", pct: 0 });
  assert.deepEqual(keyAction({ key: "7" }), { type: "seekPct", pct: 70 });
  assert.deepEqual(keyAction({ key: "Home" }), { type: "seekTo", at: 0 });
  assert.equal(keyAction({ key: "f", metaKey: true }), null);
  assert.equal(keyAction({ key: "k", ctrlKey: true }), null);
  assert.equal(keyAction({ key: "x" }), null);
  assert.equal(keyAction({ key: "Escape" }), null);
});
