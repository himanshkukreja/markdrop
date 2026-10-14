// Machine tests for "Can they open it?". Run: node --test src/components/landing/toys/CanTheyOpen/model.test.mjs
// (Node 22.18+ strips the types from model.ts on import.)
import test from "node:test";
import assert from "node:assert/strict";
import { ATTRACT, DEVICES, THINGS, att, deriveView, initialState, link, reducer, tally } from "./model.ts";

const run = (s, ...actions) => actions.reduce(reducer, s);

test("initial state matches the board: work laptop, q3-budget.xlsx, one send tried", () => {
  const v = deriveView(initialState);
  assert.equal(v.D.id, "laptop");
  assert.equal(v.T.id, "xlsx");
  assert.equal(v.parity, "", "no animation class on the static first frame");
  assert.equal(v.score.lText, "Links worked 1 of 1");
  assert.equal(v.score.aText, "Attachments 0 of 1");
  assert.equal(v.score.goal, "5 more to see the whole picture.");
  assert.equal(v.playing, true);
});

test("every device x thing pair has an outcome on both lanes", () => {
  for (const d of DEVICES) for (const t of THINGS) {
    const a = att(d.id, t.id);
    const l = link(d.id, t.id);
    assert.ok(a.title && a.text && a.chrome, `${d.id}/${t.id} attachment`);
    assert.ok(l.title && l.text && l.path, `${d.id}/${t.id} link`);
  }
});

test("honesty: artifacts need a free account to send, documents and device-to-device sends do not", () => {
  for (const t of THINGS) {
    const l = link("laptop", t.id);
    assert.equal(l.acct, t.kind === "Artifact" && t.id !== "mp4", t.id);
  }
  assert.match(link("phone", "mp4").text, /encrypted device to device/);
  assert.doesNotMatch(link("phone", "mp4").text, /end-to-end|end to end/i);
});

test("the only link that fails is a device-to-device send to a TV", () => {
  for (const d of DEVICES) for (const t of THINGS) {
    const v = link(d.id, t.id).v;
    assert.equal(v, d.id === "tv" && t.id === "mp4" ? "fail" : "ok", `${d.id}/${t.id}`);
  }
});

test("a 1.2 GB video never arrives as an attachment, on any device", () => {
  for (const d of DEVICES) assert.equal(att(d.id, "mp4").k, "big");
});

test("picking stops the demo for good and is announced", () => {
  const s = run(initialState, { type: "pickDev", id: "tv" });
  assert.equal(s.attract, false);
  assert.equal(s.dev, "tv");
  assert.match(s.live, /^TV browser, q3-budget\.xlsx\. As an attachment: Nowhere to open it\./);
  const s2 = run(s, { type: "demoStep" });
  assert.equal(s2, s, "demoStep is a no-op once the demo is off");
});

test("demo steps walk ATTRACT without touching the score", () => {
  let s = initialState;
  for (let i = 0; i < ATTRACT.length + 1; i++) s = reducer(s, { type: "demoStep" });
  const [d, t] = ATTRACT[ATTRACT.length % ATTRACT.length];
  assert.equal(s.dev, d);
  assert.equal(s.thing, t);
  assert.equal(s.demo, true);
  assert.deepEqual(s.tried, initialState.tried);
  assert.equal(deriveView(s).demoOn, true);
});

test("pause and play", () => {
  const p = run(initialState, { type: "togglePause" });
  assert.equal(p.attract, false);
  assert.equal(p.live, "Demo paused.");
  const q = run(p, { type: "togglePause" });
  assert.equal(q.attract, true);
  assert.equal(q.live, "Demo playing.");
});

test("drag: first move takes over, a drop on the lanes sends, a drop elsewhere does not", () => {
  const ghost = { id: "zip", x: 10, y: 20 };
  const moved = run(initialState, { type: "dragMove", ghost, hot: true, first: true });
  assert.equal(moved.attract, false);
  assert.deepEqual(moved.ghost, ghost);
  const dropped = run(moved, { type: "drop", id: "zip" });
  assert.equal(dropped.thing, "zip");
  assert.equal(dropped.ghost, null);
  assert.equal(tally(dropped.tried, "laptop").n, 2);

  const away = run(initialState, { type: "dragMove", ghost, hot: false, first: true }, { type: "drop", id: "zip" });
  assert.equal(away.thing, "xlsx");
  assert.equal(away.ghost, null);
});

test("all six on one device completes the score and says so once", () => {
  let s = run(initialState, { type: "pickDev", id: "phone" });
  for (const t of THINGS) s = reducer(s, { type: "pickThing", id: t.id });
  const v = deriveView(s);
  assert.equal(v.score.fin, true);
  assert.equal(v.score.goal, "All six sent. Try another device.");
  assert.equal(v.score.lText, "Links worked 6 of 6");
  assert.equal(v.score.aText, "Attachments 1 of 6");
  assert.match(s.live, /All six sent to a phone\.$/);
  const again = reducer(s, { type: "pickThing", id: "md" });
  assert.doesNotMatch(again.live, /All six/);
});

test("animation parity flips on every send", () => {
  const a = run(initialState, { type: "pickThing", id: "md" });
  const b = run(a, { type: "pickThing", id: "md" });
  assert.notEqual(deriveView(a).parity, deriveView(b).parity);
  assert.notEqual(deriveView(a).parity, "");
});
