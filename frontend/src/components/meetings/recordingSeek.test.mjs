import test from "node:test";
import assert from "node:assert/strict";
import { citeSeconds, clockSeconds, lineSeconds } from "./recordingSeek.mjs";

test("times on meeting notes as seconds", () => {
  assert.equal(clockSeconds("12:34"), 754);
  assert.equal(clockSeconds("0:05 · Ada"), 5);
  assert.equal(clockSeconds("1:02:03 · Bo"), 3723);
  assert.equal(clockSeconds("Ada"), null);
  assert.equal(clockSeconds("12:345"), null);
  assert.equal(clockSeconds("1:75"), null);
  assert.equal(clockSeconds(null), null);
});

test("a summary's transcript citation plays the recording; other links don't", () => {
  assert.equal(citeSeconds("/sync-transcript#b-t0012", "12:34", "sync-transcript"), 754);
  assert.equal(citeSeconds("https://markdrop.in/sync-transcript#b-t0012", "1:00", "sync-transcript"), 60);
  assert.equal(citeSeconds("/other#b-t0012", "12:34", "sync-transcript"), null);
  assert.equal(citeSeconds("/sync-transcript#vendors", "12:34", "sync-transcript"), null);
  assert.equal(citeSeconds("/sync-transcript#b-t0012", "#12", "sync-transcript"), null);
  assert.equal(citeSeconds("https://evil.example/sync-transcript#b-t0012", "12:34", "sync-transcript"), null);
  assert.equal(citeSeconds("/sync-transcript#b-t0012", "12:34", null), null);
});

test("a transcript line's lead", () => {
  assert.equal(lineSeconds("b-t0003", "2:10 · Ada Lovelace"), 130);
  assert.equal(lineSeconds("b-abcd1234", "2:10 · Ada"), null);
  assert.equal(lineSeconds("b-t0003", "Ada Lovelace"), null);
});
