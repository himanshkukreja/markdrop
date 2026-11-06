/** lib/initials.mjs: avatar initials from letters only (the meeting bar showed "[I", 2026-11-06). */
import test from "node:test";
import assert from "node:assert/strict";
import { initialsOf } from "./initials.mjs";

test("first letter of the first and last word", () => {
  assert.equal(initialsOf("Ishaan Gupta"), "IG");
  assert.equal(initialsOf("Ada  King Lovelace"), "AL");
  assert.equal(initialsOf("priya"), "P");
  assert.equal(initialsOf("Rahul bhai"), "RB");
  assert.equal(initialsOf("Anne-Marie O'Brien"), "AO");
});

test("brackets, markdown links, quotes and emoji are skipped", () => {
  assert.equal(initialsOf("[Ishaan Gupta](mailto:ishaan@acme.in)"), "IG");
  assert.equal(initialsOf("[Ishaan Gupta](mailto:)"), "IG");
  assert.equal(initialsOf("\\[Chetan Sharma\\]"), "CS");
  assert.equal(initialsOf("[Saurabh]"), "S");
  assert.equal(initialsOf('"Shreya Iyer",'), "SI");
  assert.equal(initialsOf("**Bo Chen**"), "BC");
  assert.equal(initialsOf("🙂 Neha Singh"), "NS");
  assert.equal(initialsOf("Gautam Rao <gautam@acme.in>"), "GR");
});

test("any script; combining marks stay with their letter", () => {
  assert.equal(initialsOf("Ãrav Mehtā"), "ÃM");
  assert.equal(initialsOf("ईशान गुप्ता"), "ईगु");   // गु: the vowel sign stays with its letter
  assert.equal(initialsOf("Łukasz Żak"), "ŁŻ");
  assert.equal(initialsOf("Team 42"), "T4");
});

test("falls back to the email, then ?", () => {
  assert.equal(initialsOf("", "priya.nair@acme.in"), "PN");
  assert.equal(initialsOf(null, "ravi@acme.in"), "R");
  assert.equal(initialsOf("ishaan.gupta@acme.in"), "IG");
  assert.equal(initialsOf("[] 🙂", "x_y@z.in"), "XY");
  assert.equal(initialsOf("", ""), "?");
  assert.equal(initialsOf("—", null), "?");
  assert.equal(initialsOf(undefined), "?");
});
