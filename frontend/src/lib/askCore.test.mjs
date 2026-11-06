import { test } from "node:test";
import assert from "node:assert/strict";
import { askSegments, blocksOf, chipOf, sourcesOf } from "./askCore.mjs";

const CITES = [
  { label: "3", title: "Release notes", url: "https://x/rel", kind: "doc", slug: "rel" },
  { label: "1-s4", title: "Weekly sync · Nov 4", url: "https://x/t#b-t0004", kind: "page", slug: "t", moment: "Ada, 2:49" },
  { label: "1", title: "Weekly sync · Nov 4", url: "https://x/w", kind: "page", slug: "w" },
  { label: "1-s9", title: "Weekly sync · Nov 4", url: "https://x/t#b-t0009", kind: "page", slug: "t", moment: "Bo, 5:10" },
];

test("segments keep only known labels", () => {
  const segs = askSegments("Ship Friday [3] as said [1-s4]. Not [7] nor [1-s99].", ["3", "1-s4"]);
  assert.deepEqual(segs.map((s) => s.cite ?? null), [null, "3", null, "1-s4", null]);
  assert.equal(segs[4].text, ". Not [7] nor [1-s99].");
  assert.equal(segs[3].n, 1);
});

test("sources are numbered in first-cited order with moments nested", () => {
  const answer = "Ship Friday [3]. Ada said so [1-s4] and Bo agreed [1-s9], see the notes [1].";
  const src = sourcesOf(answer, CITES);
  assert.deepEqual(src.map((s) => [s.n, s.shown, s.title]), [[3, 1, "Release notes"], [1, 2, "Weekly sync · Nov 4"]]);
  assert.deepEqual(src[1].moments.map((m) => m.label), ["1-s4", "1-s9"]);
  assert.equal(src[1].url, "https://x/w");
  assert.equal(chipOf(src, "3"), "1");
  assert.equal(chipOf(src, "1-s9"), "2·2");
  assert.equal(chipOf(src, "1"), "2");
});

test("a moment alone opens its transcript", () => {
  const src = sourcesOf("Said here [1-s4].", CITES);
  assert.equal(src[0].url, "https://x/t#b-t0004");
  assert.equal(src[0].title, "Weekly sync");
});

test("blocks: paragraphs and bullet lists", () => {
  const b = blocksOf("You have 2 items.\n- Email Senseloaf [1]\n- Update docs [2]\n  by Wednesday\n\nThat's all.");
  assert.deepEqual(b, [
    { type: "p", text: "You have 2 items." },
    { type: "ul", items: ["Email Senseloaf [1]", "Update docs [2] by Wednesday"] },
    { type: "p", text: "That's all." },
  ]);
});

test("the Ask page's address round-trips", async () => {
  const { askHref, readAskParams } = await import("./askCore.mjs");
  const ws = "a".repeat(24);
  assert.equal(askHref(), "/ask");
  assert.equal(askHref({ workspace: ws, q: " Sourcing? " }), `/ask?workspace=${ws}&q=Sourcing%3F`);
  assert.equal(askHref({ workspace: "nope", mine: true }), "/ask?scope=mine");
  assert.deepEqual(readAskParams(`?workspace=${ws}&c=${"b".repeat(24)}`), { workspace: ws, mine: false, thread: "b".repeat(24), q: null });
  assert.deepEqual(readAskParams("?ask=bad&workspace=x"), { workspace: null, mine: false, thread: null, q: null });
  assert.equal(readAskParams(`?ask=${"c".repeat(24)}`).thread, "c".repeat(24));   // the old home links
});

test("live suggestions: team first with topics, then yours; Updated … ago", async () => {
  const { homeChips, suggestionsOf, updatedLine } = await import("./askCore.mjs");
  const sug = {
    team: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ topic: `T${i}`, question: `Q${i}?`, label: `T${i}: Q${i}?` })),
    personal: [{ label: "My open action items", question: "What are my open action items?", intent: "my_actions" },
      { label: "Catch me up on Standup", question: "Catch me up on Standup?", intent: "ask", icon: "mic" }],
    updated_at: "2026-11-06T10:00:00Z",
  };
  const s = suggestionsOf(sug, 8);
  assert.equal(s.length, 8);
  assert.deepEqual(s[0], { q: "Q1?", label: "T1", icon: "sparkle" });
  assert.equal(s[7].q, "What are my open action items?");
  assert.equal(suggestionsOf({ team: [], personal: sug.personal }, 8).length, 2);
  assert.deepEqual(homeChips(sug, 3).map((c) => c.label), ["T1: Q1?", "T2: Q2?", "T3: Q3?"]);
  assert.deepEqual(homeChips({ team: [], personal: sug.personal }), []);
  assert.deepEqual(homeChips({ team: sug.team.slice(0, 1), personal: sug.personal }).map((c) => c.label), ["T1: Q1?", "Catch me up on Standup"]);
  assert.equal(updatedLine(sug, Date.parse("2026-11-06T12:30:00Z")), "Updated 2 h ago.");
  assert.equal(updatedLine({ ...sug, team: [] }), "");
});
