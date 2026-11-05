import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CITE, historyOf, linkCitations, numberCitations, plainAnswer, revealStep } from "./chatCore.mjs";

test("citations are numbered in first-cited order, uncited ones last", () => {
  const n = numberCitations("Ship Friday [s7], QA done [s3] and again [s7]. [M2]", ["s3", "s7", "M2", "n1"]);
  assert.deepEqual([...n.entries()], [["s7", 1], ["s3", 2], ["M2", 3], ["n1", 4]]);
});

test("meeting and Ask Markdrop tokens all match the default pattern", () => {
  const all = [..."[s12] [n3] [M2] [M2-s14] [3] [3-s9] [x1] [s]".matchAll(new RegExp(DEFAULT_CITE.source, "g"))].map((m) => m[1]);
  assert.deepEqual(all, ["s12", "n3", "M2", "M2-s14", "3", "3-s9"]);
});

test("linkCitations makes chips, collapses repeats, drops unknown tokens unless streaming", () => {
  assert.equal(linkCitations("A [s1][s1] b [s9].", ["s1"]), "A [s1](#cite-s1) b .");
  assert.equal(linkCitations("A [s9]", ["s1"], undefined, true), "A [?](#cite-%3F)");
  assert.equal(linkCitations("[s1][s2]", ["s1", "s2"]), "[s1](#cite-s1)[s2](#cite-s2)");
});

test("plainAnswer numbers the text and lists the sources", () => {
  const out = plainAnswer("Friday [s7], per [n1].", [
    { token: "n1", title: "Meeting notes", href: "https://markdrop.in/x" },
    { token: "s7", title: "Sprint planning", subtitle: "Nov 2, 2026", meta: "Ben, 0:53", href: "https://markdrop.in/t#b-t0007" },
  ]);
  assert.equal(out, "Friday [1], per [2].\n\nSources\n[1] Sprint planning · Nov 2, 2026 · Ben, 0:53 — https://markdrop.in/t#b-t0007\n[2] Meeting notes — https://markdrop.in/x");
});

test("reveal catches up faster when far behind", () => {
  assert.equal(revealStep(10, 10), 0);
  assert.equal(revealStep(0, 5), 2);
  assert.equal(revealStep(0, 1200), 100);
});

test("history keeps the last finished turns", () => {
  const turns = [{ state: "done", question: "a", answer: "1" }, { state: "error", question: "b", answer: "" }, { state: "done", question: "c", answer: "3" }];
  assert.deepEqual(historyOf(turns, 1), [{ question: "c", answer: "3" }]);
  assert.equal(historyOf(turns).length, 2);
});
