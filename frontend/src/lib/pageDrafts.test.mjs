import { test } from "node:test";
import assert from "node:assert/strict";
import { clearPageDraft, dropLegacyPageDraft, pageDraftKey, readPageDraft, writePageDraft, restorePageDraft } from "./pageDrafts.mjs";

function memory() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test("a draft is offered back only to the account that typed it", () => {
  const s = memory();
  writePageDraft(s, "plan", "alice", { title: "Plan", content: "secret notes", rev: 3, at: 1 });
  assert.deepEqual(readPageDraft(s, "plan", "alice"), { title: "Plan", content: "secret notes", rev: 3, at: 1, uid: "alice" });
  assert.equal(readPageDraft(s, "plan", "bob"), null);
  assert.equal(readPageDraft(s, "plan", null), null);
  assert.equal(readPageDraft(s, "other", "alice"), null);
});

test("keys name the account; an edit-secret editor has its own", () => {
  assert.equal(pageDraftKey("plan", "u1"), "md_page_draft:u:u1:plan");
  assert.equal(pageDraftKey("plan", null), "md_page_draft:anon:plan");
  const s = memory();
  writePageDraft(s, "plan", null, { title: "", content: "anon text" });
  assert.equal(readPageDraft(s, "plan", null)?.content, "anon text");
  assert.equal(readPageDraft(s, "plan", "u1"), null);
});

test("a draft copied under another account's key is still refused", () => {
  const s = memory();
  s.setItem(pageDraftKey("plan", "bob"), JSON.stringify({ title: "", content: "alice's", uid: "alice", at: 1 }));
  assert.equal(readPageDraft(s, "plan", "bob"), null);
  s.setItem(pageDraftKey("plan", "bob"), JSON.stringify({ title: "", content: "no owner", at: 1 }));
  assert.equal(readPageDraft(s, "plan", "bob"), null);
});

test("clearing, legacy drafts and broken storage", () => {
  const s = memory();
  writePageDraft(s, "plan", "alice", { title: "", content: "x" });
  clearPageDraft(s, "plan", "alice");
  assert.equal(readPageDraft(s, "plan", "alice"), null);
  s.setItem("md_page_draft:plan", JSON.stringify({ title: "", content: "whose?" }));
  dropLegacyPageDraft(s, "plan");
  assert.equal(s.m.size, 0);
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("full"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(readPageDraft(broken, "plan", "alice"), null);
  assert.equal(writePageDraft(broken, "plan", "alice", { content: "x" }), false);
  clearPageDraft(broken, "plan", "alice");
  s.setItem(pageDraftKey("plan", "alice"), "{not json");
  assert.equal(readPageDraft(s, "plan", "alice"), null);
});

test("a draft keeps its base; restoring it after someone else's change merges (fix/collab-audit)", () => {
  const s = memory();
  const base = "Alpha.\n\nBeta.\n\nGamma.\n";
  writePageDraft(s, "plan", "alice", { title: "Plan", content: "Alpha. Mine.\n\nBeta.\n\nGamma.\n", rev: 4, at: 1, base, baseTitle: "Plan" });
  const d = readPageDraft(s, "plan", "alice");
  assert.equal(d.base, base);
  // Nobody changed it since: the draft as it is.
  assert.deepEqual(restorePageDraft(d, { title: "Plan", content: base, rev: 4 }), { title: "Plan", content: d.content, how: "draft" });
  // Someone changed another paragraph: both.
  const r = restorePageDraft(d, { title: "Plan v2", content: "Alpha.\n\nBeta.\n\nGamma by Ben.\n", rev: 6 });
  assert.equal(r.how, "merged");
  assert.equal(r.title, "Plan v2");
  assert.equal(r.content, "Alpha. Mine.\n\nBeta.\n\nGamma by Ben.\n");
  // The same paragraph: both versions kept.
  const b = restorePageDraft(d, { title: "Plan", content: "Alpha by Ben.\n\nBeta.\n\nGamma.\n", rev: 6 });
  assert.equal(b.how, "both");
  assert.match(b.content, /Alpha by Ben\.\n\nAlpha\. Mine\./);
});

test("an old draft without its base never overwrites a newer page", () => {
  const d = { title: "Plan", content: "Old draft.\n", rev: 2, at: 1, uid: "alice" };
  const r = restorePageDraft(d, { title: "Plan", content: "Newer page.\n", rev: 5 });
  assert.equal(r.how, "appended");
  assert.match(r.content, /Newer page\./);
  assert.match(r.content, /Old draft\./);
});
