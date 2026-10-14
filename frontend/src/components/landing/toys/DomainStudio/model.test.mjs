// Domain Studio machine tests. Run: node --test src/components/landing/toys/DomainStudio/model.test.mjs
// (Node >= 22.18 strips the types from model.ts; model.ts has no imports, so it loads as is.)
import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  reducer,
  deriveView,
  copyTarget,
  checkHost,
  normHost,
  tokenFor,
  rowTarget,
  txtBlocked,
  checkTarget,
  VERIFY_MS,
  ACCENTS,
  LOGOS,
} from "./model.ts";

const run = (s, ...actions) => actions.reduce(reducer, s);
const tick = (n, demo = true) => Array.from({ length: n }, () => ({ type: "TICK", dt: 100, demo }));

test("attract: accent every 2.4s, logo every 4.8s, chrome every 9.6s, only when allowed", () => {
  let s = run(initialState, ...tick(24));
  assert.equal(s.acc, 1);
  assert.equal(s.logo, 0);
  s = run(s, ...tick(24));
  assert.equal(s.acc, 2);
  assert.equal(s.logo, 1);
  assert.equal(s.chrome, "full");
  s = run(s, ...tick(48));
  assert.equal(s.chrome, "none");
  assert.equal(s.live, "", "the demo never announces");
  const still = run(initialState, ...tick(60, false));
  assert.equal(still.acc, 0, "no demo ticks while off screen / hidden / held");
});

test("the first real input stops the demo for good; Play brings it back", () => {
  let s = run(initialState, { type: "PICK_LOGO", i: 2 });
  assert.equal(s.attract, false);
  assert.equal(s.done.logo, true);
  s = run(s, ...tick(48));
  assert.equal(s.acc, 0);
  s = run(s, { type: "TOGGLE_PLAY" });
  assert.equal(s.attract, true);
  assert.match(s.live, /Demo playing/);
  s = run(s, { type: "TOGGLE_PLAY" });
  assert.equal(s.attract, false);
  assert.match(s.live, /Demo paused/);
});

test("host rules match the board", () => {
  assert.equal(normHost(" HTTPS://Docs.Example.com/handbook?x#y "), "docs.example.com");
  assert.equal(checkHost(""), "empty");
  assert.equal(checkHost("team.markdrop.in"), "ours");
  assert.equal(checkHost("markdrop.in"), "ours");
  assert.equal(checkHost("nope"), "bad");
  assert.equal(checkHost("docs.example.com"), "ok");
  assert.equal(tokenFor("docs.example.com"), tokenFor("docs.example.com"));
  assert.equal(tokenFor("docs.example.com").length, 16);
  assert.notEqual(tokenFor("docs.example.com"), tokenFor("help.example.com"));
});

test("DNS: TXT → CNAME → verifying → live, with the 1.8s simulated lookup", () => {
  let s = run(initialState, { type: "ADDED_TXT" });
  assert.equal(s.step, 1);
  assert.equal(s.dnsHost, "docs.example.com");
  assert.match(s.live, /edge\.markdrop\.in/);
  s = run(s, { type: "ADDED_CNAME", reduce: false });
  assert.equal(s.step, 2);
  s = run(s, ...tick(VERIFY_MS / 100 - 1, false));
  assert.equal(s.step, 2);
  assert.equal(deriveView(s).dns.v1.ok, true);
  assert.equal(deriveView(s).dns.v2.ok, true);
  s = run(s, ...tick(1, false));
  assert.equal(s.step, 3);
  assert.equal(s.done.live, true);
  assert.equal(s.dropN, 1);
  assert.equal(deriveView(s).url.st, "Live");
  s = run(s, { type: "RESTART_DNS" });
  assert.equal(s.step, 0);
  assert.equal(s.done.live, false);
});

test("DNS: reduced motion skips the wait; a bad or Markdrop host is refused", () => {
  const s = run(initialState, { type: "ADDED_TXT" }, { type: "ADDED_CNAME", reduce: true });
  assert.equal(s.step, 3);
  let b = run(initialState, { type: "DOMAIN", value: "team.markdrop.in" });
  assert.equal(txtBlocked(b), true);
  b = run(b, { type: "ADDED_TXT" });
  assert.equal(b.step, 0);
  assert.equal(b.dnsBad, true);
  assert.match(b.live, /Markdrop domain/);
  assert.equal(deriveView(b).dns.noteBad, true);
  assert.equal(copyTarget(b, "txtName").ready, false);
  assert.equal(copyTarget(b, "cnVal").ready, true);
});

test("DNS: changing the domain mid-flow restarts at the TXT record", () => {
  let s = run(initialState, { type: "ADDED_TXT" });
  s = run(s, { type: "DOMAIN", value: "help.example.com" });
  assert.equal(s.step, 0);
  assert.match(s.live, /New domain, new records/);
  assert.equal(copyTarget(s, "txtName").text, "_markdrop-verify.help.example.com");
});

test("invites: validation, suggestion, re-invite moves to top, list trims to two", () => {
  let s = run(initialState, { type: "EMAIL", value: "not-an-email" }, { type: "INVITE" });
  assert.equal(s.emErr, "Enter an email address, like sam@example.com.");
  s = run(s, { type: "EMAIL", value: "sam@example.com" }, { type: "INVITE" });
  assert.equal(s.members.length, 1);
  assert.equal(s.email, "ana@example.com", "the next unused suggestion is pre-filled");
  assert.equal(s.done.invited, true);
  s = run(s, { type: "ROLE", value: "admin" }, { type: "INVITE" }, { type: "INVITE" });
  assert.equal(s.members.length, 3);
  s = run(s, { type: "EMAIL", value: "Sam@Example.com" }, { type: "ROLE", value: "viewer" }, { type: "INVITE" });
  assert.equal(s.members[0].email, "sam@example.com");
  assert.equal(s.members[0].role, "viewer");
  assert.match(s.live, /already invited/);
  const v = deriveView(s);
  assert.equal(v.members.length, 3, "you plus the newest two");
  assert.equal(v.peopleN, "4 people");
  assert.match(v.em.hint, /3 invited/);
});

test("checklist: five items, the finale line lands exactly once", () => {
  let s = run(
    initialState,
    { type: "COMPANY", value: "Acme" },
    { type: "PICK_ACC", i: 2 },
    { type: "PICK_LOGO", i: 1 },
    { type: "INVITE" },
  );
  assert.equal(deriveView(s).score, "4 of 5");
  s = run(s, { type: "ADDED_TXT" }, { type: "ADDED_CNAME", reduce: true });
  assert.equal(deriveView(s).score, "Ready");
  assert.equal(deriveView(s).finale, true);
  assert.match(s.live, /All five done/);
  s = run(s, { type: "PICK_ACC", i: 3 });
  assert.doesNotMatch(s.live, /All five done/);
});

test("announcements repeat audibly (parity space) and survive Reset", () => {
  const a = run(initialState, { type: "CHROME", value: "none" });
  const b = run(a, { type: "CHROME", value: "none" });
  assert.notEqual(a.live, b.live);
  assert.equal(a.live.trim(), b.live.trim());
  const r = run(b, { type: "RESET" });
  assert.equal(r.attract, false);
  assert.equal(r.chrome, "full");
  assert.equal(r.sayN, b.sayN + 1);
});

test("view model: monograms, gate, card, keyboard rows, checklist targets", () => {
  let s = run(initialState, { type: "COMPANY", value: "Acme Docs" }, { type: "PICK_LOGO", i: 1 });
  let v = deriveView(s);
  assert.equal(v.brandLogo.txt, "AD");
  s = run(s, { type: "PICK_LOGO", i: 0 });
  assert.equal(deriveView(s).brandLogo.txt, "A");
  s = run(s, { type: "COMPANY", value: "   " });
  assert.equal(deriveView(s).name, "Your company");
  s = run(s, { type: "TOGGLE_SIGNIN" });
  v = deriveView(s);
  assert.equal(v.gate, true);
  assert.equal(v.card.title, "Sign in · Your company");
  s = run(s, { type: "VIEW_AS", value: "member" });
  assert.equal(deriveView(s).gate, false);
  assert.equal(rowTarget("ArrowRight", ACCENTS.length - 1, ACCENTS.length), 0);
  assert.equal(rowTarget("ArrowLeft", 0, LOGOS.length), LOGOS.length - 1);
  assert.equal(rowTarget("End", 0, 6), 5);
  assert.equal(rowTarget("a", 0, 6), -1);
  assert.equal(checkTarget(run(initialState, { type: "PICK_ACC", i: 4 }), "accent"), "ds-sw-4");
  assert.equal(deriveView(initialState).brand.base, "var(--demo-accent)");
});
