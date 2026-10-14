// Sync Desk machine tests. Run: node --test src/components/landing/toys/SyncDesk/model.test.mjs
// (Node >= 22.18 strips the types from model.ts; model.ts has no imports, so it loads as is.)
import test from "node:test";
import assert from "node:assert/strict";
import { initialState, reducer, deriveView, needsTick, SEED, FLY, SAVE_AFTER, TICK_MS, LOOP } from "./model.ts";

const run = (s, ...actions) => actions.reduce((acc, a) => reducer(acc, a), s);
const ticks = (s, n, demo = false) => run(s, ...Array.from({ length: n }, () => ({ type: "TICK", demo })));
const FLY_T = Math.ceil(FLY / TICK_MS);
const SAVE_T = Math.ceil(SAVE_AFTER / TICK_MS);

test("the poster frame: synced at rev 12, demo off, 0 of 3", () => {
  const v = deriveView(initialState);
  assert.equal(v.sb.text, "Synced · rev 12");
  assert.equal(v.demo.label, "Play demo");
  assert.equal(v.goal.count, "0 of 3");
  assert.equal(needsTick(initialState), false);
});

test("typing autosaves after 800 ms and the page follows (goal: save)", () => {
  let s = run(initialState, { type: "TYPE", value: SEED + "\n- New line" });
  assert.equal(deriveView(s).sb.text, "Unsaved changes");
  s = ticks(s, SAVE_T);
  assert.equal(s.mode, "up");
  assert.equal(deriveView(s).hub.moving, true);
  s = ticks(s, FLY_T);
  assert.equal(s.mode, "idle");
  assert.equal(s.rev, 13);
  assert.ok(s.page.includes("- New line"));
  assert.equal(s.goals.save, true);
  assert.match(s.live, /Now at rev 13\. 1 of 3 ways synced\./);
});

test("⌘S saves at once; when nothing changed it says so", () => {
  let s = run(initialState, { type: "TYPE", value: SEED + "\nx" }, { type: "SAVE_KEY" });
  assert.equal(s.mode, "up");
  s = ticks(s, FLY_T);
  s = run(s, { type: "SAVE_KEY" });
  assert.match(s.live, /Already in sync at rev 13/);
});

test("a web edit reaches roadmap.md (goal: web) and busy actions are refused", () => {
  let s = run(initialState, { type: "WEB_EDIT" });
  assert.equal(s.mode, "down");
  s = run(s, { type: "EDIT_BOTH" });
  assert.match(s.live, /Wait for the sync to land/);
  s = ticks(s, FLY_T);
  assert.ok(s.ed.includes("- Book the launch review"));
  assert.equal(s.goals.web, true);
  assert.equal(deriveView(s).edNote, "Updated from the web");
});

test("a web edit over unsaved changes opens a conflict; Use web resolves it", () => {
  let s = run(initialState, { type: "TYPE", value: SEED + "\nx" }, { type: "WEB_EDIT" });
  s = ticks(s, FLY_T);
  assert.equal(s.mode, "conflict");
  assert.match(s.live, /unsaved changes when the web edit arrived/);
  s = ticks(run(s, { type: "USE_WEB" }), FLY_T);
  assert.equal(s.mode, "idle");
  assert.equal(s.ed, s.page);
  assert.equal(s.goals.fix, true);
});

test("both at once: diff, focus on Keep mine, merge round trip, all three ways", () => {
  let s = ticks(run(initialState, { type: "EDIT_BOTH" }), FLY_T);
  assert.equal(s.mode, "conflict");
  assert.equal(s.focus.id, "sd-keep");
  const v = deriveView(s);
  assert.equal(v.showDiff, true);
  assert.match(v.df.sub, /^2 lines differ/);
  s = run(s, { type: "SAVE_KEY" });
  assert.match(s.live, /Choose Keep mine, Use web or Merge manually first/);
  s = run(s, { type: "MERGE_MANUAL" });
  assert.equal(s.mode, "merge");
  assert.ok(s.ed.includes("Friday") && s.ed.includes("Thursday"));
  s = run(s, { type: "BACK_TO_DIFF" });
  assert.equal(s.mode, "conflict");
  s = run(s, { type: "MERGE_MANUAL" }, { type: "SAVE_MERGE" });
  s = ticks(s, FLY_T);
  assert.equal(s.mode, "idle");
  assert.equal(s.goals.fix, true);
});

test("the demo loops through every mode, never ticks a goal, and resets the file", () => {
  let s = run(initialState, { type: "AUTOPLAY" });
  assert.equal(s.attract, true);
  const seen = new Set();
  for (let i = 0; i < LOOP / TICK_MS + 5; i++) {
    s = reducer(s, { type: "TICK", demo: true });
    seen.add(s.mode);
  }
  for (const m of ["up", "down", "clash", "conflict"]) assert.ok(seen.has(m), "missing " + m);
  assert.deepEqual(s.goals, { save: false, web: false, fix: false });
  assert.equal(s.loopN, 1);
  assert.equal(s.ed, SEED);
});

test("the demo only advances on screen, and stops for good on the first input", () => {
  let s = ticks(run(initialState, { type: "AUTOPLAY" }), 40, false);
  assert.equal(s.aClock, 0);
  s = ticks(s, 15, true);
  assert.ok(s.typeQ || s.ed !== s.saved);
  s = run(s, { type: "ED_FOCUS" });
  assert.equal(s.attract, false);
  assert.equal(s.ed, s.saved, "half-typed demo text is dropped");
  s = run(s, { type: "AUTOPLAY" });
  assert.equal(s.attract, false);
});

test("Pause demo drops half-typed text; Play demo restarts on request", () => {
  let s = ticks(run(initialState, { type: "AUTOPLAY" }), 15, true);
  s = run(s, { type: "TOGGLE_DEMO" });
  assert.equal(s.attract, false);
  assert.equal(s.ed, s.saved);
  assert.match(s.live, /Demo paused/);
  s = run(s, { type: "TOGGLE_DEMO" });
  assert.equal(s.attract, true);
  assert.equal(deriveView(s).demo.label, "Pause demo");
});

test("reduced motion: no autoplay, and syncs land at once", () => {
  let s = run(initialState, { type: "REDUCE", on: true }, { type: "AUTOPLAY" });
  assert.equal(s.attract, false);
  s = run(s, { type: "WEB_EDIT" });
  assert.equal(s.mode, "idle");
  assert.equal(s.rev, 13);
});
