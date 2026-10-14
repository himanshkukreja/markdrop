// Link Forge machine tests. Run: node --test src/components/landing/toys/LinkForge/model.test.mjs
// (Node 22.18+ strips the types from model.ts on import.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO, LOOP, datesFrom, derive, deriveView, ghostState, initialState, reducer, slugify } from "./model.ts";

const run = (s, ...actions) => actions.reduce(reducer, s);
const ticks = (s, ms) => {
  for (let t = 0; t < ms; t += 100) s = reducer(s, { type: "tick", dt: 100 });
  return s;
};

test("the poster frame is a plain, valid link and the demo is not playing", () => {
  const vm = deriveView(initialState);
  assert.equal(vm.ppText, "Play demo");
  assert.equal(vm.running, false);
  assert.equal(vm.pill.host + vm.pill.path, "markdrop.in/team-handbook");
  assert.equal(vm.copy.disabled, false);
  assert.deepEqual(vm.tags.map((t) => t.text), ["Custom name", "Anyone with the link"]);
  assert.equal(vm.meter.n, 0);
});

test("slugify keeps the /new alphabet and the 50-character limit", () => {
  assert.equal(slugify("Team Handbook v2.0!"), "Team-Handbook-v2-0");
  assert.equal(slugify("--a__b--c"), "a__b-c");
  assert.equal(slugify("x".repeat(80)).length, 50);
  assert.match(slugify("héllo wörld ✓"), /^[A-Za-z0-9_-]*$/);
});

test("name rules: blank is random, short is invalid, demo-taken offers a suggestion", () => {
  let s = run(initialState, { type: "slugInput", raw: "" });
  assert.equal(derive(s).status, "random");
  assert.equal(derive(s).valid, true);
  s = run(s, { type: "slugInput", raw: "ab" });
  assert.equal(derive(s).status, "short");
  assert.equal(deriveView(s).copy.disabled, true);
  assert.equal(deriveView(s).cv.broken, true);
  s = run(s, { type: "slugInput", raw: "readme" });
  assert.equal(derive(s).status, "taken");
  assert.match(deriveView(s).st.text, /in this demo/);
  s = run(s, { type: "slugEnter" });
  assert.equal(s.slug, "readme-k4n");
  assert.equal(derive(s).status, "ok");
  assert.match(deriveView(s).st.text, /Nothing is reserved until you publish/);
});

test("workspace folders never report a taken name and show the custom host", () => {
  const s = run(initialState, { type: "user", patch: { dest: "ws", slug: "readme" } });
  const d = derive(s);
  assert.equal(d.status, "ok");
  assert.equal(d.display, "docs.example.com/handbook/readme");
});

test("the chat unfurl mirrors the real OG cards: content-free when protected", () => {
  let s = run(initialState, { type: "flip", key: "pwOn" }, { type: "user", patch: { pw: "harbor" } });
  let cv = deriveView(s).cv;
  assert.equal(cv.title, "Password-protected document");
  assert.equal(cv.lockIcon, "lock");
  s = run(s, { type: "flip", key: "enc" });
  cv = deriveView(s).cv;
  assert.equal(cv.title, "Encrypted document");
  assert.equal(cv.lockIcon, "key");
  assert.equal(cv.sealed, true);
  assert.match(deriveView(s).summary, /ciphertext it has no key for/);
  // Password and encryption are allowed together on documents: both gates are described.
  assert.match(deriveView(s).pw.hint, /Two gates/);
  assert.match(derive(s).url, /#k=Qx7[A-Za-z0-9_-]{40}$/);
});

test("an open link unfurls with its title; a workspace link says sign-in docs do not", () => {
  assert.equal(deriveView(initialState).cv.title, "Team handbook");
  const s = run(initialState, { type: "user", patch: { dest: "ws" } });
  assert.equal(deriveView(s).cv.wsNote, true);
});

test("custom expiry uses the computed minimum date, not the board's", () => {
  const { minDate, idleDate } = datesFrom(new Date(2027, 0, 30, 15).getTime());
  assert.equal(minDate, "2027-01-31");
  assert.equal(idleDate, "2027-02-17");
  let s = run(initialState, { type: "today", minDate, idleDate });
  assert.equal(s.date, idleDate);
  s = run(s, { type: "user", patch: { exp: "custom", date: "2027-01-30" } });
  assert.equal(derive(s).expOn, false);
  assert.match(derive(s).summary, /Pick a date after today/);
  s = run(s, { type: "user", patch: { date: "2027-03-01" } });
  assert.equal(derive(s).expTag, "Expires Mar 1, 2027");
});

test("the attract loop plays every step, then loops", () => {
  let s = run(initialState, { type: "autostart" });
  assert.equal(s.attract, true);
  s = ticks(s, 100);
  assert.equal(s.say, "Demo: a plain link, ready to share");
  s = ticks(s, 3700);
  assert.equal(s.slug, "readme-k4n");
  s = ticks(s, 9300 - 3800);
  assert.equal(s.enc, true);
  assert.equal(s.pw, "harbor");
  assert.equal(s.exp, "7d");
  s = ticks(s, 13700 - 9300);
  assert.equal(s.dest, "ws");
  assert.equal(s.enc, false);
  s = ticks(s, LOOP - 13700);
  assert.equal(s.aIdx, 0);
  assert.equal(s.aClock, 0);
  s = ticks(s, 100);
  assert.equal(s.dest, "link");
  assert.equal(s.exp, "never");
  // The demo never scores for the visitor.
  assert.equal(s.forged, 0);
  assert.deepEqual(s.found, {});
  assert.ok(s.forgeN > 5);
  assert.equal(DEMO[0].at, 0);
});

test("the first interaction stops the demo for good; autostart never comes back", () => {
  let s = ticks(run(initialState, { type: "autostart" }), 2000);
  s = run(s, { type: "user", patch: { tab: "phone" } });
  assert.equal(s.attract, false);
  assert.equal(s.touched, true);
  assert.equal(s.say, "");
  s = run(s, { type: "autostart" });
  assert.equal(s.attract, false);
  const frozen = ticks(s, 5000);
  assert.equal(frozen, s);
});

test("pause and play", () => {
  let s = run(initialState, { type: "autostart" }, { type: "togglePause" });
  assert.equal(s.paused, true);
  assert.equal(deriveView(s).ppText, "Play demo");
  assert.equal(ticks(s, 3000), s);
  s = run(s, { type: "togglePause" });
  assert.equal(deriveView(s).ppText, "Pause demo");
  // After a takeover, Play restarts the demo from the top.
  s = run(ticks(s, 4000), { type: "stop" }, { type: "togglePause" });
  assert.equal(s.attract, true);
  assert.equal(s.aClock, 0);
});

test("the meter counts distinct valid shapes and all five traits", () => {
  let s = run(
    initialState,
    { type: "user", patch: { exp: "7d" } },
    { type: "flip", key: "pwOn" },
    { type: "user", patch: { pw: "x" } },
    { type: "flip", key: "enc" },
    { type: "user", patch: { dest: "ws" } },
  );
  assert.equal(s.forged, 4);
  assert.equal(deriveView(s).meter.done, true);
  assert.match(s.live, /^All five options tried\./);
  const n = s.forged;
  // A shape already made does not count twice; a new one does.
  s = run(s, { type: "user", patch: { dest: "link" } }, { type: "user", patch: { dest: "ws" } });
  assert.equal(s.forged, n);
  s = run(s, { type: "user", patch: { exp: "30d" } });
  assert.equal(s.forged, n + 1);
});

test("copy: success, failure and reset", () => {
  let s = run(initialState, { type: "copyStart" }, { type: "copied", ok: true, url: "https://markdrop.in/team-handbook" });
  assert.equal(deriveView(s).copy.text, "Copied");
  s = run(s, { type: "copyClear" });
  assert.equal(deriveView(s).copy.text, "Copy");
  s = run(s, { type: "copied", ok: false, url: "" });
  assert.equal(deriveView(s).copy.text, "Select it");
});

test("the ghost card is the demo's tallest settings state", () => {
  const vm = deriveView(ghostState);
  assert.equal(vm.st.tone, "warn");
  assert.ok(vm.st.sug);
  assert.equal(vm.pw.on, true);
  assert.equal(vm.enc, true);
  // The demo never shows a custom date together with the password field or the encryption warning.
  let s = reducer(initialState, { type: "autostart" });
  for (let t = 0; t < LOOP; t += 100) {
    s = reducer(s, { type: "tick", dt: 100 });
    if (s.exp === "custom") assert.ok(!s.pwOn && !s.enc);
  }
});

test("copy on a preview link writes nothing and says why", () => {
  const s = run(initialState, { type: "copyStart" }, { type: "copyDemo" });
  const vm = deriveView(s);
  assert.equal(vm.copy.text, "Preview");
  assert.equal(vm.copy.icon, "info");
  assert.match(vm.live, /Nothing copied/);
  assert.equal(deriveView(run(s, { type: "copyClear" })).copy.text, "Copy");
});
