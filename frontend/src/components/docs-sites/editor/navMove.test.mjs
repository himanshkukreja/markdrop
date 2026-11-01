/**
 * The page tree's reordering (navMove.ts): the nav a drag or a row menu saves, and the slot a
 * dragged row lands in (pointer and keyboard alike).
 * Runs on node's TypeScript type stripping (node ≥ 22.18); skipped without it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

let mod = null;
try {
  mod = await import("./navMove.ts");
} catch (e) {
  if (!/Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|strip/i.test(String(e?.message ?? e))) throw e;
}
const t = mod ? test : test.skip;

const NAV = [
  { group: "Start", pages: ["a", "b", "c"] },
  { group: "Guides", pages: ["d", "e"] },
  { group: "Empty", pages: [] },
];

t("a page moves inside its group; the index counts the group before the move", () => {
  const { movePage } = mod;
  assert.deepEqual(movePage(NAV, "a", "Start", 3)[0].pages, ["b", "c", "a"]);
  assert.deepEqual(movePage(NAV, "a", "Start", 2)[0].pages, ["b", "a", "c"]);
  assert.deepEqual(movePage(NAV, "c", "Start", 0)[0].pages, ["c", "a", "b"]);
  // Its own place (before itself, or before the next page) changes nothing.
  assert.equal(movePage(NAV, "b", "Start", 1), NAV);
  assert.equal(movePage(NAV, "b", "Start", 2), NAV);
});

t("a page moves to another group, an empty one too, and only the two groups change", () => {
  const { movePage } = mod;
  const n = movePage(NAV, "b", "Guides", 1);
  assert.deepEqual(n.map((g) => g.pages), [["a", "c"], ["d", "b", "e"], []]);
  assert.equal(n[2], NAV[2]);
  assert.deepEqual(movePage(NAV, "e", "Empty", 0).map((g) => g.pages), [["a", "b", "c"], ["d"], ["e"]]);
  // Out-of-range indexes clamp; an unknown group is no change.
  assert.deepEqual(movePage(NAV, "a", "Guides", 99)[1].pages, ["d", "e", "a"]);
  assert.equal(movePage(NAV, "a", "Nope", 0), NAV);
  // The input is never mutated.
  assert.deepEqual(NAV[0].pages, ["a", "b", "c"]);
});

t("an unlisted page dragged into a group is added to the nav", () => {
  const { movePage } = mod;
  assert.deepEqual(movePage(NAV, "z", "Guides", 0).map((g) => g.pages), [["a", "b", "c"], ["z", "d", "e"], []]);
});

t("groups reorder, and the menu's steps and Move to … use the same moves", () => {
  const { moveGroup, stepPage, pageToGroup } = mod;
  assert.deepEqual(moveGroup(NAV, 0, 3).map((g) => g.group), ["Guides", "Empty", "Start"]);
  assert.deepEqual(moveGroup(NAV, 2, 0).map((g) => g.group), ["Empty", "Start", "Guides"]);
  assert.equal(moveGroup(NAV, 1, 1), NAV);
  assert.equal(moveGroup(NAV, 1, 2), NAV);
  assert.deepEqual(stepPage(NAV, "b", -1)[0].pages, ["b", "a", "c"]);
  assert.deepEqual(stepPage(NAV, "b", 1)[0].pages, ["a", "c", "b"]);
  assert.equal(stepPage(NAV, "a", -1), NAV);
  assert.equal(stepPage(NAV, "c", 1), NAV);
  assert.deepEqual(pageToGroup(NAV, "a", "Guides")[1].pages, ["d", "e", "a"]);
});

/** Rows 30px tall under a 28px header, groups 10px apart; "Guides" collapsed, "Empty" empty. */
const MEASURED = [
  { group: "Start", count: 3, head: { top: 0, bottom: 28 }, rows: [{ top: 28, bottom: 58 }, { top: 58, bottom: 88 }, { top: 88, bottom: 118 }] },
  { group: "Guides", count: 2, head: { top: 128, bottom: 156 }, rows: [] },
  { group: "Empty", count: 0, head: { top: 166, bottom: 194 }, rows: [] },
];

t("slots: each row's top, each open group's end, one slot on a collapsed or empty group's header", () => {
  const { pageSlots } = mod;
  assert.deepEqual(pageSlots(MEASURED), [
    { group: "Start", index: 0, y: 28 },
    { group: "Start", index: 1, y: 58 },
    { group: "Start", index: 2, y: 88 },
    { group: "Start", index: 3, y: 118 },
    { group: "Guides", index: 2, y: 142, into: true },
    { group: "Empty", index: 0, y: 180, into: true },
  ]);
});

t("the pointer picks the nearest slot; the page's own two slots are no move", () => {
  const { pageSlots, nearestSlot, isNoop } = mod;
  const slots = pageSlots(MEASURED);
  assert.deepEqual(nearestSlot(slots, 100), slots[2]);
  assert.deepEqual(nearestSlot(slots, 150), slots[4]);
  assert.equal(isNoop(NAV, "b", slots[1]), true);
  assert.equal(isNoop(NAV, "b", slots[2]), true);
  assert.equal(isNoop(NAV, "b", slots[3]), false);
  assert.equal(isNoop(NAV, "b", slots[4]), false);
});

t("arrow keys step through slots that mean a different drop, and stop at the ends", () => {
  const { pageSlots, stepSlot, movePage } = mod;
  const slots = pageSlots(MEASURED);
  // "b" starts on its own slot (index 1); slot 2 is the same drop, so ↓ goes to the end of Start.
  let s = stepSlot(NAV, "b", slots, slots[1], 1);
  assert.deepEqual(s, slots[3]);
  s = stepSlot(NAV, "b", slots, s, 1);
  assert.deepEqual(s, slots[4]);
  assert.deepEqual(movePage(NAV, "b", s.group, s.index).map((g) => g.pages), [["a", "c"], ["d", "e", "b"], []]);
  s = stepSlot(NAV, "b", slots, s, 1);
  assert.deepEqual(s, slots[5]);
  assert.deepEqual(stepSlot(NAV, "b", slots, s, 1), slots[5]);
  // ↑ from its own place goes before "a"; then stays.
  s = stepSlot(NAV, "b", slots, slots[1], -1);
  assert.deepEqual(s, slots[0]);
  assert.deepEqual(stepSlot(NAV, "b", slots, s, -1), slots[0]);
});

t("group slots sit between groups; a group's own two slots are the same drop", () => {
  const { groupSlots, stepKeyed, groupKey, moveGroup } = mod;
  const slots = groupSlots([{ top: 0, bottom: 118 }, { top: 128, bottom: 156 }, { top: 166, bottom: 194 }], 10);
  assert.deepEqual(slots, [{ index: 0, y: -5 }, { index: 1, y: 123 }, { index: 2, y: 161 }, { index: 3, y: 199 }]);
  const key = (s) => groupKey(1, s);
  assert.deepEqual(stepKeyed(slots, slots[1], 1, key), slots[3]);
  assert.deepEqual(stepKeyed(slots, slots[1], -1, key), slots[0]);
  assert.deepEqual(moveGroup(NAV, 1, slots[3].index).map((g) => g.group), ["Start", "Empty", "Guides"]);
});
