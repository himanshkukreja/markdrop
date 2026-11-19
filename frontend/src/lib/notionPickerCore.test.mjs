import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, emptySelection, importBody, isMixed, isOn, leavesOutRows, summary, toggle } from "./notionPickerCore.mjs";

const items = [
  { id: "hb", kind: "page", title: "Handbook", parent_id: null, parent_kind: null },
  { id: "onb", kind: "page", title: "Onboarding", parent_id: "hb", parent_kind: "page" },
  { id: "week", kind: "page", title: "First week", parent_id: "onb", parent_kind: "page" },
  { id: "docs", kind: "database", title: "Docs", parent_id: "hb", parent_kind: "page", row_count: 3 },
  { id: "notes", kind: "page", title: "Row notes", parent_id: "r1", parent_kind: "row" },
  { id: "other", kind: "page", title: "Another space", parent_id: null, parent_kind: null },
];
const rows = new Map([["docs", [
  { id: "r1", kind: "row", title: "Zeta guide", parent_id: "docs" },
  { id: "r2", kind: "row", title: "Alpha guide", parent_id: "docs" },
  { id: "r3", kind: "row", title: "Mid guide", parent_id: "docs" },
]]]);
const rowParents = { r1: "docs" };
const titles = (ns) => ns.map((n) => n.title);

test("tree: real parents, rows only once opened, nothing twice", () => {
  const closed = buildTree(items, new Map(), rowParents);
  assert.deepEqual(titles(closed.roots), ["Another space", "Handbook"]);
  const hb = closed.byId.get("hb");
  assert.deepEqual(titles(hb.children), ["Docs", "Onboarding"]);
  assert.deepEqual(closed.byId.get("docs").children, []);            // rows not loaded: nothing yet
  assert.equal(closed.byId.get("docs").rowsLoaded, false);
  assert.equal(closed.roots.some((n) => n.id === "notes"), false);   // under a row: never loose at the top
  assert.equal(closed.parentOf.get("r1"), "docs");                   // but where it is is known
  const open = buildTree(items, rows, rowParents);
  const docs = open.byId.get("docs");
  assert.deepEqual(titles(docs.children), ["Zeta guide", "Alpha guide", "Mid guide"]);   // Notion's row order
  assert.deepEqual(titles(open.byId.get("r1").children), ["Row notes"]);
  const seen = [];
  const walk = (ns) => ns.forEach((n) => { seen.push(n.id); walk(n.children); });
  walk(open.roots);
  assert.equal(seen.length, new Set(seen).size);
  assert.equal(seen.length, items.length + 3);
});

test("ticking a parent ticks everything under it; each child can be unticked (tri-state)", () => {
  const t = buildTree(items, rows, rowParents);
  let sel = toggle("hb", emptySelection(), t.parentOf);
  for (const id of ["hb", "onb", "week", "docs", "r1", "r2", "notes"]) assert.equal(isOn(id, sel, t.parentOf), true, id);
  assert.equal(isOn("other", sel, t.parentOf), false);
  assert.equal(isMixed("hb", sel, t.parentOf), false);
  sel = toggle("r2", sel, t.parentOf);
  sel = toggle("onb", sel, t.parentOf);
  assert.equal(isOn("r2", sel, t.parentOf), false);
  assert.equal(isOn("week", sel, t.parentOf), false);                // with what's under it
  assert.equal(isMixed("hb", sel, t.parentOf), true);
  assert.equal(isMixed("docs", sel, t.parentOf), true);
  assert.deepEqual(importBody(sel, t.byId), { pages: [{ id: "hb", kind: "page", title: "Handbook" }], exclude: ["r2", "onb"] });
  assert.equal(summary(sel, t).text, "4 pages, 1 database · 2 left out");   // hb, r1, notes, r3
  assert.equal(leavesOutRows(sel, t.byId), true);
  // Ticking a left-out item again brings it back; ticking the parent again resets what's inside.
  sel = toggle("onb", sel, t.parentOf);
  assert.equal(isOn("week", sel, t.parentOf), true);
  assert.deepEqual([...sel.excluded], ["r2"]);
  sel = toggle("hb", sel, t.parentOf);                               // untick all
  assert.deepEqual([sel.roots.size, sel.excluded.size], [0, 0]);
});

test("a child ticked on its own is a root; a row on its own imports as a page", () => {
  const t = buildTree(items, rows, rowParents);
  let sel = toggle("r3", emptySelection(), t.parentOf);
  sel = toggle("week", sel, t.parentOf);
  assert.equal(isMixed("hb", sel, t.parentOf), true);
  assert.equal(isOn("hb", sel, t.parentOf), false);
  const body = importBody(sel, t.byId);
  assert.deepEqual(body.pages.map((p) => [p.id, p.kind]), [["r3", "page"], ["week", "page"]]);
  assert.deepEqual(body.exclude, []);
  // Ticking the parent afterwards takes them in (no roots inside roots).
  sel = toggle("hb", sel, t.parentOf);
  assert.deepEqual(importBody(sel, t.byId).pages.map((p) => p.id), ["hb"]);
});

test("summary counts a database's rows before it is opened", () => {
  const t = buildTree(items, new Map(), rowParents);
  const sel = toggle("docs", emptySelection(), t.parentOf);
  assert.equal(summary(sel, t).text, "4 pages, 1 database");          // 3 rows + the row's sub-page
  assert.equal(summary(emptySelection(), t).text, "0 pages");
});
