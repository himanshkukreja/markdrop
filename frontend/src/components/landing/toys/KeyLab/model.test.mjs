// Key Lab machine tests. Run: node --test src/components/landing/toys/KeyLab/model.test.mjs
// (Node >= 22.18 strips the types from model.ts; model.ts has no imports, so it loads as is.)
import test from "node:test";
import assert from "node:assert/strict";
import { initialState, reducer, deriveView, keyFor, parseNote, MSG, BEAT, TICK_MS, DROP_AT } from "./model.ts";

const run = (s, ...actions) => actions.reduce((acc, a) => reducer(acc, a), s);
const ticks = (s, n) => run(s, ...Array.from({ length: n }, () => ({ type: "TICK", dt: TICK_MS })));
const beat = BEAT / TICK_MS;

test("attract cycles browser → server → browser with the hint, and never ticks the checklist", () => {
  let s = ticks(initialState, beat);
  assert.equal(s.view, "server");
  assert.equal(s.hint, false);
  s = ticks(s, beat);
  assert.equal(s.view, "browser");
  assert.equal(s.hint, true);
  assert.equal(deriveView(s).hintOn, true);
  s = ticks(s, beat);
  assert.equal(s.view, "browser");
  assert.equal(s.hint, false);
  assert.deepEqual(s.done, initialState.done);
  assert.equal(s.msg, "");
});

test("the first user input stops the demo for good; ticks do nothing after", () => {
  const s = run(initialState, { type: "INTERACT" });
  assert.equal(s.attract, false);
  assert.equal(s.paused, false, "ambient loops keep running after a plain interaction");
  assert.equal(ticks(s, beat * 3), s);
});

test("Pause demo freezes the demo and the ambient loops; Play demo restarts both", () => {
  const p = run(initialState, { type: "TOGGLE_DEMO" });
  assert.equal(p.attract, false);
  assert.equal(p.paused, true);
  assert.equal(deriveView(p).demoOn, false);
  const q = run(p, { type: "TOGGLE_DEMO" });
  assert.equal(q.attract, true);
  assert.equal(q.paused, false);
});

test("reduced motion turns the demo off at mount", () => {
  const s = run(initialState, { type: "REDUCED_MOTION" });
  assert.equal(s.attract, false);
  assert.equal(s.paused, true);
  assert.equal(ticks(s, beat), s);
});

test("taking the key out reports the missing key; putting it back decrypts again", () => {
  let s = run(initialState, { type: "TOGGLE_KEY" });
  assert.equal(s.keyOut, true);
  assert.equal(s.done.out, true);
  assert.equal(s.msg, MSG.out);
  let v = deriveView(s);
  assert.equal(v.browserMissing, true);
  assert.equal(v.keyBtnLabel, "Put the key back");
  s = run(s, { type: "KEY_IN" });
  v = deriveView(s);
  assert.equal(s.keyOut, false);
  assert.equal(s.msg, MSG.back);
  assert.equal(v.browserOk, true);
  assert.equal(v.ripple, "A");
});

test("keyboard: ArrowDown only takes out, ArrowUp only puts back", () => {
  const out = run(initialState, { type: "KEY_OUT" });
  assert.equal(out.keyOut, true);
  assert.equal(run(out, { type: "KEY_OUT" }).moveN, out.moveN, "no double move");
  assert.equal(run(initialState, { type: "KEY_IN" }).keyOut, false);
});

test("drag: past DROP_AT takes the key out, short drags explain and bounce back", () => {
  let s = run(initialState, { type: "DRAG_MOVE", dx: 4, dy: 40 });
  assert.deepEqual(s.drag, { dx: 4, dy: 40 });
  assert.equal(deriveView(s).trayHot, false);
  s = run(s, { type: "DRAG_END", dy: 40 });
  assert.equal(s.keyOut, false);
  assert.equal(s.msg, MSG.dragIn);
  assert.equal(s.drag, null);
  s = run(s, { type: "DRAG_MOVE", dx: 0, dy: DROP_AT + 10 });
  assert.equal(deriveView(s).trayHot, true);
  s = run(s, { type: "DRAG_END", dy: DROP_AT + 10 });
  assert.equal(s.keyOut, true);
  s = run(s, { type: "DRAG_MOVE", dx: 0, dy: -(DROP_AT + 10) });
  assert.equal(deriveView(s).slotHot, true);
  s = run(s, { type: "DRAG_END", dy: -(DROP_AT + 10) });
  assert.equal(s.keyOut, false);
});

test("rotate needs the key in the link, re-encrypts and strikes the old link", () => {
  const blocked = run(initialState, { type: "KEY_OUT" }, { type: "ROTATE" });
  assert.equal(blocked.msg, MSG.rotateOut);
  assert.equal(blocked.keyIdx, 0);
  assert.equal(blocked.done.rot, false);
  const before = deriveView(initialState);
  const s = run(initialState, { type: "ROTATE" });
  const v = deriveView(s);
  assert.equal(s.keyIdx, 1);
  assert.equal(v.old, "markdrop.in/plan-v2#k=" + keyFor(0).slice(0, 6) + "…");
  assert.notEqual(v.chipHead + v.chipMid, before.chipHead + before.chipMid);
  assert.notDeepEqual(v.scroll, before.scroll, "new key, new ciphertext");
});

test("all four steps complete the lab once, with the closing line", () => {
  const s = run(initialState, { type: "SHOW_SERVER" }, { type: "TOGGLE_KEY" }, { type: "TOGGLE_KEY" }, { type: "ROTATE" }, { type: "TOGGLE_SIGNIN" });
  assert.equal(s.complete, true);
  assert.equal(s.msg, MSG.sign + MSG.all);
  assert.equal(deriveView(s).doneN, 4);
  const again = run(s, { type: "CLOSE_SIGNIN" }, { type: "ROTATE" });
  assert.equal(again.msg, MSG.rotate, "the closing line is said once");
});

test("sign-in toggles and closes; it never unlocks", () => {
  const s = run(initialState, { type: "KEY_OUT" }, { type: "TOGGLE_SIGNIN" });
  assert.equal(s.signin, true);
  assert.equal(s.keyOut, true);
  assert.equal(run(s, { type: "TOGGLE_SIGNIN" }).signin, false);
  assert.equal(run(s, { type: "CLOSE_SIGNIN" }).signin, false);
});

test("the first frame doesn't animate in; later panel swaps do", () => {
  assert.equal(deriveView(initialState).swapped, false);
  assert.equal(deriveView(initialState).roll, "");
  assert.equal(deriveView(run(initialState, { type: "SHOW_SERVER" })).swapped, true);
});

test("the note drives title and body, capped at 600 characters", () => {
  assert.deepEqual(parseNote("# Hello\n- one\ntwo").blocks.map((b) => [b.t, b.li]), [["one", true], ["two", false]]);
  assert.equal(parseNote("").title, "Untitled");
  const s = run(initialState, { type: "NOTE", value: "x".repeat(700) });
  assert.equal(s.note.length, 600);
  assert.equal(s.attract, false);
});

test("ciphertext is deterministic (server and client render the same poster)", () => {
  assert.deepEqual(deriveView(initialState), deriveView({ ...initialState }));
  assert.equal(keyFor(0), "Qx7mT2vLp9aR4sKdW1nEe0bZrN3cYh6uJq0FxV5gMt8");
});
