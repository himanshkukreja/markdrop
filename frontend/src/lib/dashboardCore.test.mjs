// node --test src/lib/dashboardCore.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { add, count, defaultSettings, locate, move, moveAcross, moves, newId, pickable, remove, sameLayout, stacked, toBody, update } from "./dashboardCore.mjs";

const w = (id, type = "recent", settings = {}) => ({ id, type, settings });
const L = () => ({ main: [w("a"), w("b"), w("c")], side: [w("x", "todos"), w("y", "needs_you")] });
const ids = (l) => ({ main: l.main.map((x) => x.id), side: l.side.map((x) => x.id) });
const RECENT = { type: "recent", settings: { count: { kind: "count", default: 8, min: 3, max: 12 } } };
const BACKLOG = { type: "backlog", settings: { team: { kind: "team", required: true }, category: { kind: "enum" }, count: { kind: "count", default: 6 } } };

test("up and down within a column; the ends don't move", () => {
  const l = L();
  assert.deepEqual(ids(move(l, "b", -1)).main, ["b", "a", "c"]);
  assert.deepEqual(ids(move(l, "b", 1)).main, ["a", "c", "b"]);
  assert.equal(move(l, "a", -1), l);
  assert.equal(move(l, "c", 1), l);
  assert.equal(move(l, "nope", 1), l);
  assert.deepEqual(ids(l).main, ["a", "b", "c"]);               // never changes its input
});

test("across keeps the height, or goes to the end of a shorter column", () => {
  assert.deepEqual(ids(moveAcross(L(), "b")), { main: ["a", "c"], side: ["x", "b", "y"] });
  assert.deepEqual(ids(moveAcross(L(), "c")), { main: ["a", "b"], side: ["x", "y", "c"] });
  assert.deepEqual(ids(moveAcross(L(), "y")), { main: ["a", "y", "b", "c"], side: ["x"] });
  assert.deepEqual(locate(moveAcross(L(), "x"), "x"), { col: "main", index: 0 });
});

test("moves: what the buttons may do", () => {
  assert.deepEqual(moves(L(), "a"), { up: false, down: true, across: "side" });
  assert.deepEqual(moves(L(), "y"), { up: true, down: false, across: "main" });
  assert.deepEqual(moves(L(), "zz"), { up: false, down: false, across: null });
});

test("remove", () => {
  assert.deepEqual(ids(remove(L(), "x")), { main: ["a", "b", "c"], side: ["y"] });
  assert.equal(count(remove(L(), "a")), 4);
});

test("add: on top of the column, with the type's defaults, up to the cap", () => {
  const l = add(L(), RECENT, "side", undefined, 16, () => 0.5);
  assert.equal(l.side[0].type, "recent");
  assert.deepEqual(l.side[0].settings, { count: 8 });
  assert.match(l.side[0].id, /^w[0-9a-z]{6}$/);
  const b = add(L(), BACKLOG, "main", { team: "t1" });
  assert.deepEqual(b.main[0].settings, { team: "t1", category: null, count: 6 });
  assert.equal(add(L(), RECENT, "main", undefined, 5), null);       // full
  assert.deepEqual(defaultSettings(null), {});
});

test("newId never repeats one in the layout", () => {
  const seq = [0, 0, 0.5];
  const l = { main: [w("w000000")], side: [] };
  assert.notEqual(newId(l, () => seq.shift()), "w000000");
});

test("update merges settings and clears the server's notes", () => {
  const l = { main: [{ ...w("a", "brief", { team: "old" }), available: false, note: "You can't open this team any more.", setup: "team" }], side: [] };
  const u = update(l, "a", { team: "new" });
  assert.deepEqual(u.main[0], { id: "a", type: "brief", settings: { team: "new" }, available: true });
});

test("toBody: ids, types and set settings only; sameLayout compares that", () => {
  const l = { main: [{ ...w("a", "backlog", { team: "t", category: null, count: 6 }), available: true, title: "x" }], side: [] };
  assert.deepEqual(toBody(l), { main: [{ id: "a", type: "backlog", settings: { team: "t", count: 6 } }], side: [] });
  assert.ok(sameLayout(l, { main: [w("a", "backlog", { team: "t", count: 6 })], side: [] }));
  assert.ok(!sameLayout(L(), move(L(), "b", 1)));
});

test("stacked: main then side, each knowing its column (phones)", () => {
  assert.deepEqual(stacked(L()).map((x) => `${x.col}:${x.id}`), ["main:a", "main:b", "main:c", "side:x", "side:y"]);
});

test("pickable: disabled when unavailable here or the Home is full", () => {
  const cat = [{ ...RECENT, available: true }, { type: "deals", settings: {}, available: false }];
  assert.deepEqual(pickable(cat, L()).map((c) => c.disabled), [false, true]);
  assert.deepEqual(pickable(cat, L(), 5).map((c) => c.disabled), [true, true]);
});
