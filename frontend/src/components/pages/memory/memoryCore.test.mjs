import { test } from "node:test";
import assert from "node:assert/strict";
import { sectionAround, contentWords, sectionKey, isMemoryQuestion, shouldCheck, textHash, citedMarkdown, localHref } from "./memoryCore.mjs";

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

test("same-origin links become paths; others stay or drop", () => {
  assert.equal(localHref("https://markdrop.in/abc#b-t0004", "https://markdrop.in"), "/abc#b-t0004");
  assert.equal(localHref("https://acme.example/x", "https://markdrop.in"), "https://acme.example/x");
  assert.equal(localHref("/p/x", "https://markdrop.in"), "/p/x");
  assert.equal(localHref("javascript:alert(1)", "https://markdrop.in"), null);
  assert.equal(localHref("//evil.example", "https://markdrop.in"), null);
  assert.equal(localHref(null, "https://markdrop.in"), null);
});

test("an answer's citations become numbered links (first-cited order, moments nested)", () => {
  const citations = [
    { label: "2", title: "Daily Standup", url: "https://markdrop.in/standup", kind: "page" },
    { label: "2-s4", title: "Daily Standup · 12:34", url: "https://markdrop.in/standup-t#b-t0004", moment: "12:34" },
    { label: "1", title: "Checkout PRD", url: "https://markdrop.in/prd", kind: "this page" },
  ];
  const { markdown, sources } = citedMarkdown("On Oct 28, 2026 (Daily Standup) we decided to ship [2-s4]. The page agrees [1]. Unknown [7].", citations, "https://markdrop.in");
  assert.equal(markdown, "On Oct 28, 2026 (Daily Standup) we decided to ship [\\[1·1\\]](/standup-t#b-t0004). The page agrees [\\[2\\]](/prd). Unknown [7].");
  assert.deepEqual(sources.map((s) => [s.n, s.shown, s.href]), [[2, 1, "/standup-t#b-t0004"], [1, 2, "/prd"]]);
});

test("View mode: the page's Markdown as blocks, and the heading in view", async () => {
  const { markdownBlocks, headingIndex } = await import("./memoryCore.mjs");
  const md = "Intro line one\nline two\n\n## Payments **now**\n\nWe use a hosted page.\n\n```sh\n# not a heading\n```\n\n### [Refunds](/r)\n\nWithin 30 days.\n\n## Pricing ##\nAnnual plans.\n";
  const blocks = markdownBlocks(md);
  assert.deepEqual(blocks.map((b) => b.level), [null, 2, null, null, 3, null, 2, null]);
  assert.equal(blocks[0].text, "Intro line one\nline two");
  assert.equal(blocks[3].text, "```sh\n# not a heading\n```");
  assert.equal(blocks[6].text, "Pricing");
  assert.equal(headingIndex(blocks, "Payments now"), 1);
  assert.equal(headingIndex(blocks, "Refunds"), 4);
  assert.equal(headingIndex(blocks, null), 0);
  assert.equal(headingIndex(blocks, "Nowhere"), 0);
  const s = sectionAround(blocks, headingIndex(blocks, "Payments now"));
  assert.equal(s.heading, "Payments **now**");
  assert.match(s.text, /hosted page/);
  assert.match(s.text, /Within 30 days/);
  assert.doesNotMatch(s.text, /Annual/);
  assert.deepEqual(markdownBlocks(""), []);
});
