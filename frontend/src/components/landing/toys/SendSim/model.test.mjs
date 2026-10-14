// Send Sim machine tests. Run: node --test src/components/landing/toys/SendSim/model.test.mjs
// (Node >= 22.18 strips the types from model.ts; its one "@/" import is mapped by the resolve hook below.)
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// model.ts imports the honesty flag as "@/lib/marketingFlags"; map the "@/" alias to src/*.ts.
const SRC = new URL("../../../../", import.meta.url).href;
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { return s.startsWith("@/") ? next(${JSON.stringify(SRC)} + s.slice(2) + ".ts", c) : next(s, c); }`,
));
const { initialState, reducer, derive, needsTick, MAX_PEOPLE, MAX_FILES, RELAY_SENTENCE, SHOW_RELAY, DEMO_CAP, YOUR_TURN, REDUCED_CAP, LOCKED } = await import("./model.ts");

const run = (s, ...actions) => actions.reduce((acc, a) => reducer(acc, a), s);
const ticks = (s, n) => run(s, ...Array.from({ length: n }, () => ({ type: "TICK" })));
const awake = (s) => reducer(s, { type: "AWAKE", on: true });

test("the first frame is frozen until the toy is awake (in view, tab visible)", () => {
  assert.equal(needsTick(initialState), false);
  assert.equal(derive(initialState).frozen, true);
  const s = awake(initialState);
  assert.equal(needsTick(s), true);
  assert.equal(derive(s).frozen, false);
  assert.equal(derive(s).caption, DEMO_CAP);
});

test("the attract demo advances people while awake and stops for good on the first input", () => {
  let s = ticks(awake(initialState), 20);
  assert.notDeepEqual(s.people.map((p) => p.p), initialState.people.map((p) => p.p));
  s = reducer(s, { type: "PICK_NET", id: "mobile" });
  assert.equal(s.attract, false);
  assert.equal(s.net, "mobile");
  assert.equal(derive(s).caption, YOUR_TURN);
  assert.equal(derive(s).pp.text, "Play demo");
  // Nothing brings the demo back except Play demo.
  s = ticks(s, 200);
  assert.equal(s.attract, false);
  s = reducer(s, { type: "TOGGLE_DEMO" });
  assert.equal(s.attract, true);
  assert.equal(s.paused, false);
});

test("Pause demo freezes the clock and Play resumes it", () => {
  let s = reducer(awake(initialState), { type: "TOGGLE_DEMO" });
  assert.equal(s.paused, true);
  assert.equal(needsTick(s), false);
  assert.equal(ticks(s, 10), ticks(s, 10)); // TICK returns the same object while paused
  assert.equal(reducer(s, { type: "TICK" }), s);
  s = reducer(s, { type: "TOGGLE_DEMO" });
  assert.equal(s.paused, false);
  assert.equal(needsTick(s), true);
});

test("reduced motion never plays the demo; its control resets the still frame", () => {
  let s = reducer(awake(initialState), { type: "REDUCED" });
  assert.equal(needsTick(s), false);
  assert.equal(derive(s).pp.show, false);
  assert.equal(derive(s).caption, REDUCED_CAP);
  s = reducer(s, { type: "ADD_PERSON" });
  assert.equal(s.attract, false);
  assert.equal(derive(s).pp.text, "Reset demo");
  s = reducer(s, { type: "TOGGLE_DEMO" });
  assert.equal(s.attract, true);
  assert.equal(s.paused, true);
  assert.equal(needsTick(s), false);
});

test("while sharing, files are locked and removing a person explains the link", () => {
  let s = reducer(initialState, { type: "ADD_FILE" });
  assert.equal(s.note.text, LOCKED);
  s = reducer(s, { type: "REMOVE_PERSON" });
  assert.match(s.note.text, /Anyone with the link can join/);
});

test("End sharing asks first; Keep returns focus to the button; End goes back to setup", () => {
  let s = reducer(initialState, { type: "SEND" });
  assert.equal(s.confirm, true);
  assert.equal(s.focus.id, "ss-keep");
  s = reducer(s, { type: "KEEP" });
  assert.equal(s.confirm, false);
  assert.equal(s.focus.id, "ss-send");
  s = run(s, { type: "SEND" }, { type: "END" });
  assert.equal(s.phase, "setup");
  assert.match(s.live, /^Sharing ended\./);
  assert.equal(derive(s).send.text, "Send");
});

test("setup caps files at 5 and people at 10, and keeps at least one of each", () => {
  let s = run(initialState, { type: "SEND" }, { type: "END" });
  for (let i = 0; i < 8; i++) s = reducer(s, { type: "ADD_FILE" });
  assert.equal(s.files.length, MAX_FILES);
  assert.match(s.note.text, /holds 5 files/);
  for (let i = 0; i < 12; i++) s = reducer(s, { type: "ADD_PERSON" });
  assert.equal(s.people.length, MAX_PEOPLE);
  assert.match(s.note.text, /up to 10 people/);
  for (let i = 0; i < 12; i++) s = reducer(s, { type: "REMOVE_PERSON" });
  assert.equal(s.people.length, 1);
  for (const id of s.files.slice()) s = reducer(s, { type: "REMOVE_FILE", id });
  assert.equal(s.files.length, 1);
  assert.match(s.note.text, /at least one file/);
});

test("a delivery over each network completes the goal", () => {
  let s = awake(run(initialState, { type: "SEND" }, { type: "END" }));
  const nets = SHOW_RELAY ? ["wifi", "office", "mobile"] : ["wifi", "mobile"];
  s = reducer(s, { type: "SEND" });
  for (const id of nets) s = run(s, { type: "PICK_NET", id }, { type: "ADD_PERSON" });
  s = ticks(s, 400);
  assert.equal(s.goalDone, true);
  assert.equal(derive(s).goal.all, true);
  assert.ok(s.delivered >= nets.length);
});

test("honesty: the relay sentence is the owner wording, and nothing says end-to-end", () => {
  assert.equal(RELAY_SENTENCE, "If a network blocks a direct path, an encrypted relay forwards the bytes and can't read them.");
  let s = awake(initialState);
  const texts = [];
  for (let i = 0; i < 300; i++) {
    s = reducer(s, { type: "TICK" });
    texts.push(s.live, derive(s).caption);
  }
  s = run(s, { type: "PICK_NET", id: SHOW_RELAY ? "office" : "wifi" }, { type: "ADD_PERSON" });
  texts.push(s.live);
  assert.ok(!texts.some((t) => /end[- ]to[- ]end/i.test(t)));
  if (SHOW_RELAY) assert.match(s.live, /encrypted relay/);
});
