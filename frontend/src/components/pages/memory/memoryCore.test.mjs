import { test } from "node:test";
import assert from "node:assert/strict";
import { sectionAround, contentWords, sectionKey, isMemoryQuestion, shouldCheck, textHash } from "./memoryCore.mjs";

const PAGE = [
  { level: null, text: "Intro paragraph" },
  { level: 2, text: "Payments" },
  { level: null, text: "We use a hosted page." },
  { level: 3, text: "Refunds" },
  { level: null, text: "Within 30 days." },
  { level: 2, text: "Pricing" },
  { level: null, text: "Annual plans." },
];

test("the section around the caret", () => {
  assert.deepEqual(sectionAround(PAGE, 0), { heading: null, level: null, start: 0, end: 1, text: "Intro paragraph" });
  assert.deepEqual(sectionAround(PAGE, 2), { heading: "Payments", level: 2, start: 1, end: 5, text: "We use a hosted page.\nRefunds\nWithin 30 days." });
  assert.equal(sectionAround(PAGE, 4).heading, "Refunds");
  assert.equal(sectionAround(PAGE, 4).end, 5);
  assert.equal(sectionAround(PAGE, 6).heading, "Pricing");
  assert.equal(sectionAround(PAGE, 99).heading, "Pricing");
  assert.equal(sectionAround([], 0).heading, null);
});

test("content words and keys", () => {
  assert.deepEqual(contentWords("When did we decide on the Stripe checkout? Stripe!"), ["decide", "stripe", "checkout"]);
  assert.equal(sectionKey({ title: "PRD", heading: " Payments " }), sectionKey({ title: "prd", heading: "payments" }));
  assert.notEqual(sectionKey({ title: "PRD", heading: "Payments" }), sectionKey({ title: "PRD", heading: "Pricing" }));
  assert.equal(textHash("abc"), textHash("abc"));
  assert.notEqual(textHash("abc"), textHash("abd"));
});

test("questions about meetings", () => {
  for (const q of ["When did we decide on Stripe?", "why did we choose annual pricing", "Who agreed to the launch date?",
    "What was decided about refunds?", "which feature were we working on in the standup", "What are the action items?",
    "what did the meeting say about SSO"]) assert.ok(isMemoryQuestion(q), q);
  for (const q of ["Summarize this page", "What's still open?", "How long is the refund window?"]) assert.ok(!isMemoryQuestion(q), q);
});

test("when the AI check runs", () => {
  const base = { words: 40, decisions: 1, key: "k", checked: new Set(), budget: 3 };
  assert.ok(shouldCheck(base));
  assert.ok(!shouldCheck({ ...base, words: 10 }));
  assert.ok(!shouldCheck({ ...base, decisions: 0 }));
  assert.ok(!shouldCheck({ ...base, checked: new Set(["k"]) }));
  assert.ok(!shouldCheck({ ...base, budget: 0 }));
});
