/**
 * Send Sim: the machine. A pure port of `design/revamp-canvas/PlaySendSim.dc.html`
 * (`class Component extends DCLogic`, board line 525). No React, no DOM: data, types, the reducer
 * and `derive()` (the board's `renderVals()` without closures). Strip-only TypeScript (no enums, no
 * parameter properties; the one import is the honesty flag, which the test resolves with a tiny hook)
 * so `node --test` can load it directly.
 *
 * DCLogic method               → here
 *   constructor, demoState()   → initialState, resetDemo()
 *   componentDidMount (reduce) → REDUCED (Game reads prefers-reduced-motion)
 *   tick()                     → TICK (Game runs it every TICK_MS while `needsTick(state)`)
 *   runAttract()               → runAttract() inside TICK; the queue is data (`state.q`), not closures
 *   freshPeople, addPersonRaw,
 *   startSend, takeOver,
 *   noteSay                    → helpers below
 *   onAddFile                  → ADD_FILE
 *   onRemoveFile(id)           → REMOVE_FILE
 *   onPickNet(id)              → PICK_NET
 *   onAddPerson                → ADD_PERSON
 *   onRemovePerson             → REMOVE_PERSON
 *   onSendBtn                  → SEND
 *   onKeep / onEnd             → KEEP / END
 *   onConfirmKey(e)            → Game (Escape → KEEP; Tab cycles between the two dialog buttons)
 *   onTab(v)                   → TAB
 *   onPause                    → TOGGLE_DEMO
 *   this.focusId               → state.focus ({ id, n }); Game moves focus after the render
 *   renderVals()               → derive(state)
 * Added for the page: AWAKE (in view and tab visible), HOLD (keyboard focus inside the toy holds the
 * demo so controls never vanish under the cursor), COPIED (CLI copy feedback).
 *
 * Honesty (REVAMP_BUILD O5/D6, package notes): P2P is "encrypted device to device", never
 * "end to end". The relay is shown only as what happens when a network blocks the direct path.
 * `SHOW_RELAY = false` removes the firewall network, the relay node, the relayed route row and every
 * relay sentence (REVAMP_BUILD §5.H.6) if the TURN relay is not live when this ships.
 */

import { P2P_RELAY_LIVE } from "@/lib/marketingFlags";

/** The relay network, node, route row and sentences follow the shared honesty flag. */
export const SHOW_RELAY: boolean = P2P_RELAY_LIVE;

/* ── Files the tray can hold (max 5 in this demo) ── */
export type FileId = "img1" | "img2" | "pdf" | "mp4" | "xlsx" | "zip" | "md";
export type FileKind = "image" | "pdf" | "video" | "sheet" | "archive" | "doc";
export interface FileDef { id: FileId; name: string; kind: FileKind; bytes: number }
export const FILES: FileDef[] = [
  { id: "img1", name: "IMG_2041.jpg", kind: "image", bytes: 3400000 },
  { id: "img2", name: "IMG_2042.jpg", kind: "image", bytes: 2900000 },
  { id: "pdf", name: "site-plan.pdf", kind: "pdf", bytes: 1800000 },
  { id: "mp4", name: "demo.mp4", kind: "video", bytes: 48000000 },
  { id: "xlsx", name: "budget.xlsx", kind: "sheet", bytes: 240000 },
  { id: "zip", name: "site.zip", kind: "archive", bytes: 12600000 },
  { id: "md", name: "notes.md", kind: "doc", bytes: 12000 },
];
const FBY = {} as Record<FileId, FileDef>;
FILES.forEach((f) => { FBY[f.id] = f; });
export const MAX_FILES = 5;
export const MAX_PEOPLE = 10;

/* ── Networks and the route each one gets ── */
export type NetId = "wifi" | "office" | "mobile";
export type Route = "direct" | "relay";
export interface Net { id: NetId; name: string; route: Route; rate: number }
export const NETS: Record<NetId, Net> = {
  wifi: { id: "wifi", name: "Same Wi-Fi", route: "direct", rate: 7.2 },
  office: { id: "office", name: "Office firewall", route: "relay", rate: 3.8 },
  mobile: { id: "mobile", name: "Mobile data", route: "direct", rate: 4.8 },
};
export const NET_ORDER: NetId[] = SHOW_RELAY ? ["wifi", "office", "mobile"] : ["wifi", "mobile"];
export const POOL = ["Priya Shah", "Daniel Okafor", "Mei Lin", "Arjun Mehta", "Ana Ruiz", "Sam Lee", "Noah Kim", "Lena Park", "Omar Haddad", "Zoe Brown"];
/** Share ids shown in the mock. Display text only: none of these links exist. */
export const LINKS = ["7f3a9c", "b21e4d", "c9d07a", "4e8f12", "a63b70"];
export type Tab = "browser" | "cli";
export const TABS: Array<{ value: Tab; label: string }> = [{ value: "browser", label: "Browser" }, { value: "cli", label: "CLI" }];

export const LOCKED = "These files are on the live link. End sharing to start a new send.";
export const DEMO_CAP = "Demo running. Pick a network or add a person to play.";
export const REDUCED_CAP = "Reduced motion is on, so the demo stays still. Pick a network or add a person to play.";
export const YOUR_TURN = SHOW_RELAY ? "Your turn. Try a firewall, then add a person." : "Your turn. Pick a network, then add a person.";
/** The relay sentence (owner wording): what happens when a network blocks the direct path. */
export const RELAY_SENTENCE = "If a network blocks a direct path, an encrypted relay forwards the bytes and can't read them.";
const RELAY_HOW = "Relayed: this network blocks a direct path, so an encrypted relay forwards the bytes and can't read them.";

/* ── Attract loop: each cycle sends again over a different network, then someone joins from another ── */
interface Cycle { net: NetId; files: FileId[]; n: number; then: NetId; cap1: string; cap2: string }
export const CYCLES: Cycle[] = SHOW_RELAY
  ? [
      { net: "mobile", files: ["img1", "img2", "pdf", "mp4"], n: 2, then: "office", cap1: "Demo: four files, two people on mobile data", cap2: "Demo: someone joins from an office firewall" },
      { net: "office", files: ["zip", "md"], n: 2, then: "wifi", cap1: "Demo: a zipped site, two people behind a firewall", cap2: "Demo: someone joins on the same Wi-Fi" },
      { net: "wifi", files: ["img1", "img2", "pdf"], n: 3, then: "mobile", cap1: "Demo: three photos, three people on the same Wi-Fi", cap2: "Demo: someone joins on mobile data" },
    ]
  : [
      { net: "mobile", files: ["img1", "img2", "pdf", "mp4"], n: 2, then: "wifi", cap1: "Demo: four files, two people on mobile data", cap2: "Demo: someone joins on the same Wi-Fi" },
      { net: "wifi", files: ["zip", "md"], n: 2, then: "mobile", cap1: "Demo: a zipped site, two people on the same Wi-Fi", cap2: "Demo: someone joins on mobile data" },
    ];
const CYCLE_GAP = 2400; // rest between attract cycles once everyone has the files
export const TICK_MS = 150;

/* ── Stage geometry, desktop (the board's 584 x 620 stage) ── */
export const STAGE_W = 584;
export const STAGE_H = 620;
const SX = 112;
const SY = 350;
const RX = 200;
const RY = 496;
function cyOf(i: number, k: number) { const sp = Math.min(80, 380 / Math.max(k, 1)); return Math.round(350 + (i - (k - 1) / 2) * sp); }
function slots(n: number) {
  const out: Array<{ x: number; y: number }> = [];
  if (n <= 5) { for (let i = 0; i < n; i++) out.push({ x: 388, y: cyOf(i, n) }); return out; }
  const a = Math.ceil(n / 2);
  const b = n - a;
  for (let i = 0; i < a; i++) out.push({ x: 272, y: cyOf(i, a) });
  for (let i = 0; i < b; i++) out.push({ x: 428, y: cyOf(i, b) });
  return out;
}
function pathFor(route: Route, x: number, y: number) {
  if (route === "relay") return "M" + SX + " " + (SY + 18) + " C" + (SX + 40) + " " + (SY + 70) + " " + (RX - 50) + " " + RY + " " + RX + " " + RY + " C" + (RX + 60) + " " + RY + " " + (x - 70) + " " + y + " " + x + " " + y;
  return "M" + SX + " " + SY + " C" + (SX + 70) + " " + SY + " " + (x - 70) + " " + y + " " + x + " " + y;
}

/* ── Stage geometry, narrow (no board: a one-column world, everything anchored to the left edge so
 *    the wires and packets need no width). Pills start at N_PILL_X and stretch to the right edge. ── */
export const N_PILL_X = 128;
const N_ROW = 58; // 52px pill + 6px gap
const N_COL_H = SHOW_RELAY ? 200 : 100; // sender block (labels on top, screen below), then the relay
function narrowGeo(n: number) {
  const listH = Math.max(0, n * N_ROW - 6);
  const h = Math.max(listH, N_COL_H);
  const top0 = Math.round((h - N_COL_H) / 2);
  const listTop = Math.round((h - listH) / 2);
  return { h, top0, sy: top0 + 71, sBottom: top0 + 100, ry: top0 + 148, ys: Array.from({ length: n }, (_, i) => listTop + i * N_ROW + 26) };
}
function narrowPath(route: Route, g: ReturnType<typeof narrowGeo>, y: number) {
  const x = N_PILL_X;
  if (route === "relay") return "M44 " + g.sBottom + " L44 " + g.ry + " C92 " + g.ry + " " + (x - 28) + " " + y + " " + x + " " + y;
  return "M80 " + g.sy + " C104 " + g.sy + " " + (x - 24) + " " + y + " " + x + " " + y;
}

/* ── Formatting ── */
export function fmt(b: number) {
  if (b < 1000000) return Math.max(1, Math.round(b / 1000)) + " KB";
  const mb = b / 1000000;
  return (mb >= 100 ? String(Math.round(mb)) : mb.toFixed(1)) + " MB";
}
function total(ids: FileId[]) { return ids.reduce((a, id) => a + FBY[id].bytes, 0); }
function sizeFactor(ids: FileId[]) { const mb = total(ids) / 1000000; return 0.35 + 25 / (25 + mb); }
function filesWord(n: number) { return n === 1 ? "1 file" : n + " files"; }
function peopleWord(n: number) { return n === 1 ? "1 person" : n + " people"; }

/* ── Decorative QR glyphs: seeded, deterministic (identical on server and client), not scannable ── */
function qrPath(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  const rnd = () => { h = (h ^ (h << 13)) >>> 0; h = (h ^ (h >>> 17)) >>> 0; h = (h ^ (h << 5)) >>> 0; return h / 4294967296; };
  const N = 21;
  const finder = (x: number, y: number) => x >= 0 && x < 7 && y >= 0 && y < 7 && (x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4));
  let d = "";
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let on = false;
      const inF = (x < 8 && y < 8) || (x >= N - 8 && y < 8) || (x < 8 && y >= N - 8);
      if (inF) on = finder(x >= N - 8 ? x - (N - 7) : x, y >= N - 8 ? y - (N - 7) : y);
      else if (x === 6) on = y % 2 === 0;
      else if (y === 6) on = x % 2 === 0;
      else on = rnd() < 0.47;
      if (on) d += "M" + x + " " + y + "h1v1h-1z";
    }
  }
  return d;
}
const QRS = LINKS.map(qrPath);

/* ── State ── */
export type Phase = "setup" | "sharing";
export type PStatus = "waiting" | "joining" | "receiving" | "done";
/** `fx`: the pill plays its join animation (false for the first frame's people, so the server poster
 *  and the game's first render are identical and nothing replays when the island swaps in).
 *  `rip`: it turned done while you watched, so its ripple plays once. */
export interface Person { id: number; name: string; st: PStatus; p: number; net: NetId | null; joinAt: number; connAt: number; fx: boolean; rip: boolean }
export interface Note { where: "files" | "people"; text: string }
export interface Step { at: number; step: 0 | 1 | 2; c: number }
export type CopyTarget = "send" | "get";

export interface State {
  phase: Phase;
  files: FileId[];
  net: NetId;
  link: number;
  people: Person[];
  tab: Tab;
  confirm: boolean;
  note: Note | null;
  live: string;
  attract: boolean;
  paused: boolean;
  seen: Partial<Record<NetId, boolean>>;
  delivered: number;
  goalDone: boolean;
  caption: string;
  /* timers (the board's instance fields) */
  t: number;
  q: Step[];
  doneAt: number;
  cyc: number;
  pid: number;
  /* animation identity: file rows are keyed by `fkeys[id]` (0 = first frame, no entrance), the link
   * card by `lcGen` (0 = first frame). A new key mounts a new element, which plays its entrance once. */
  fkeys: Partial<Record<FileId, number>>;
  seq: number;
  lcGen: number;
  /* page plumbing */
  awake: boolean;
  hold: boolean;
  reduced: boolean;
  copied: CopyTarget | null;
  focus: { id: string; n: number } | null;
}

const DEMO_FILES: FileId[] = ["img1", "img2", "pdf"];
function demoPeople(id0: number, fx: boolean): Person[] {
  return [
    { id: id0, name: "Priya Shah", st: "done", p: 100, net: "wifi", joinAt: 0, connAt: 0, fx, rip: false },
    { id: id0 + 1, name: "Daniel Okafor", st: "receiving", p: 58, net: "wifi", joinAt: 0, connAt: 0, fx, rip: false },
    { id: id0 + 2, name: "Mei Lin", st: "receiving", p: 22, net: SHOW_RELAY ? "office" : "mobile", joinAt: 0, connAt: 0, fx, rip: false },
  ];
}
/** The board's demoState() applied to a running state (Play demo / Reset demo): fresh keys, so the
 *  tray, the link card and the pills enter again. */
function resetDemo(s: State): State {
  return {
    ...withFreshKeys(s, DEMO_FILES), phase: "sharing", files: DEMO_FILES.slice(), net: "wifi", link: 0,
    people: demoPeople(s.pid, true), pid: s.pid + 3, lcGen: s.lcGen + 1,
  };
}

export const initialState: State = {
  phase: "sharing", files: DEMO_FILES.slice(), net: "wifi", link: 0, people: demoPeople(0, false),
  tab: "browser", confirm: false, note: null, live: "",
  attract: true, paused: false, seen: {}, delivered: 0, goalDone: false, caption: DEMO_CAP,
  t: 0, q: [], doneAt: 0, cyc: 0, pid: 3,
  fkeys: {}, seq: 0, lcGen: 0,
  awake: false, hold: false, reduced: false, copied: null, focus: null,
};

export type Action =
  | { type: "TICK" }
  | { type: "AWAKE"; on: boolean }
  | { type: "HOLD"; on: boolean }
  | { type: "REDUCED" }
  | { type: "ADD_FILE" }
  | { type: "REMOVE_FILE"; id: FileId }
  | { type: "PICK_NET"; id: NetId }
  | { type: "ADD_PERSON" }
  | { type: "REMOVE_PERSON" }
  | { type: "SEND" }
  | { type: "KEEP" }
  | { type: "END" }
  | { type: "TAB"; tab: Tab; focus?: boolean }
  | { type: "COPIED"; which: CopyTarget | null }
  | { type: "TOGGLE_DEMO" };

/** Whether the clock has anything to do. Game runs the interval only while this is true. */
export function needsTick(s: State): boolean {
  if (!s.awake) return false;
  if (s.attract) return !(s.paused || s.hold || s.reduced);
  return s.phase === "sharing" && s.people.some((p) => p.st !== "done");
}

/* ── Helpers (the board's private methods) ── */
function focusOn(s: State, id: string): State["focus"] { return { id, n: (s.focus ? s.focus.n : 0) + 1 }; }

function takeOver(s: State): State {
  if (s.attract || s.paused) return { ...s, q: [], doneAt: 0, attract: false, paused: false, caption: "" };
  return s;
}

function noteSay(s: State, where: Note["where"], text: string): State { return { ...s, note: { where, text }, live: text }; }

function withFreshKeys(s: State, ids: FileId[]): State {
  const fkeys = { ...s.fkeys };
  let seq = s.seq;
  ids.forEach((id) => { seq += 1; fkeys[id] = seq; });
  return { ...s, fkeys, seq };
}

function freshPeople(s: State, n: number): State {
  const people = POOL.slice(0, n).map((name, i): Person => ({ id: s.pid + i, name, st: "waiting", p: 0, net: null, joinAt: 0, connAt: 0, fx: true, rip: false }));
  return { ...s, people, pid: s.pid + n };
}

function startSend(s: State, demo: boolean): State {
  const link = (s.link + 1) % LINKS.length;
  const people = s.people.map((p, i): Person => ({ ...p, st: "waiting", p: 0, net: s.net, joinAt: s.t + 450 + i * 500, rip: false }));
  const next: State = { ...s, phase: "sharing", link, people, confirm: false, note: null, lcGen: s.lcGen + 1 };
  if (!demo) next.live = "Link ready: markdrop.in/share/" + LINKS[link] + ". " + (people.length === 1 ? "1 person is" : people.length + " people are") + " opening it.";
  return next;
}

function addPersonRaw(s: State): { s: State; p: Person | null } {
  if (s.people.length >= MAX_PEOPLE) return { s, p: null };
  const used = s.people.map((p) => p.name);
  const name = POOL.find((n) => used.indexOf(n) < 0) || "Guest";
  const p: Person = { id: s.pid, name, st: "waiting", p: 0, net: s.phase === "sharing" ? s.net : null, joinAt: s.t + 300, connAt: 0, fx: true, rip: false };
  return { s: { ...s, people: s.people.concat([p]), pid: s.pid + 1 }, p };
}

function runStep(s: State, step: Step): State {
  const c = CYCLES[step.c % CYCLES.length];
  if (step.step === 0) return freshPeople({ ...withFreshKeys(s, c.files), phase: "setup", confirm: false, files: c.files.slice(), net: c.net, caption: c.cap1, lcGen: s.lcGen + 1 }, c.n);
  if (step.step === 1) return startSend(s, true);
  return addPersonRaw({ ...s, net: c.then, caption: c.cap2 }).s;
}

function runAttract(s: State): State {
  let st = s;
  while (st.q.length && st.q[0].at <= st.t) {
    const head = st.q[0];
    st = runStep({ ...st, q: st.q.slice(1) }, head);
  }
  if (st.q.length) return st;
  const busy = st.phase !== "sharing" || st.people.some((p) => p.st !== "done");
  if (busy) return st.doneAt ? { ...st, doneAt: 0 } : st;
  if (!st.doneAt) return { ...st, doneAt: st.t };
  if (st.t - st.doneAt < CYCLE_GAP) return st;
  const c = st.cyc % CYCLES.length;
  const t0 = st.t;
  return { ...st, doneAt: 0, cyc: st.cyc + 1, q: [{ at: t0, step: 0, c }, { at: t0 + 1200, step: 1, c }, { at: t0 + 2900, step: 2, c }] };
}

function tick(s: State): State {
  if (s.attract && (s.paused || s.hold || s.reduced)) return s;
  let st: State = { ...s, t: s.t + TICK_MS };
  if (st.attract) st = runAttract(st);
  if (st.phase !== "sharing") return st;
  const factor = sizeFactor(st.files);
  let changed = false;
  const doneNow: Array<{ name: string; net: NetId }> = [];
  const people = st.people.map((p): Person => {
    if (p.st === "waiting" && st.t >= p.joinAt) { changed = true; return { ...p, st: "joining", connAt: st.t + 600 }; }
    if (p.st === "joining" && st.t >= p.connAt) { changed = true; return { ...p, st: "receiving", net: p.net || st.net }; }
    if (p.st === "receiving") {
      changed = true;
      const net = p.net || st.net;
      const np = Math.min(100, p.p + NETS[net].rate * factor * (0.86 + (p.id % 4) * 0.07));
      if (np >= 100) { doneNow.push({ name: p.name, net }); return { ...p, st: "done", p: 100, rip: true }; }
      return { ...p, p: np };
    }
    return p;
  });
  if (!changed) return st;
  const next: State = { ...st, people };
  if (doneNow.length && !st.attract) {
    const seen = { ...st.seen };
    doneNow.forEach((p) => { seen[p.net] = true; });
    const what = st.files.length === 1 ? "the file" : st.files.length + " files";
    let msg = doneNow.map((p) => p.name + " got " + what + " over " + NETS[p.net].name + ", " + (NETS[p.net].route === "relay" ? "relayed." : "direct.")).join(" ");
    next.seen = seen;
    next.delivered = st.delivered + doneNow.length;
    if (NET_ORDER.every((id) => seen[id]) && !st.goalDone) { next.goalDone = true; msg += " You delivered over every network."; }
    next.live = msg;
  }
  return next;
}

/* ── The reducer ── */
export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "TICK": return tick(s);
    case "AWAKE": return s.awake === a.on ? s : { ...s, awake: a.on };
    case "HOLD": return s.hold === a.on ? s : { ...s, hold: a.on };
    case "REDUCED":
      if (s.reduced) return s;
      return s.attract ? { ...s, reduced: true, paused: true, q: [], doneAt: 0, caption: REDUCED_CAP } : { ...s, reduced: true };

    case "ADD_FILE": {
      const st = takeOver(s);
      if (st.phase === "sharing") return noteSay(st, "files", LOCKED);
      if (st.files.length >= MAX_FILES) return noteSay(st, "files", "This demo tray holds 5 files. A real send takes many files, or a whole folder.");
      const f = FILES.find((x) => st.files.indexOf(x.id) < 0);
      if (!f) return st;
      const files = st.files.concat([f.id]);
      return { ...withFreshKeys(st, [f.id]), files, note: null, live: "Added " + f.name + ", " + fmt(f.bytes) + ". " + filesWord(files.length) + ", " + fmt(total(files)) + "." };
    }
    case "REMOVE_FILE": {
      const st = takeOver(s);
      if (st.phase === "sharing") return noteSay(st, "files", LOCKED);
      if (st.files.length <= 1) return noteSay(st, "files", "Keep at least one file to send.");
      const i = st.files.indexOf(a.id);
      if (i < 0) return st;
      const files = st.files.filter((x) => x !== a.id);
      const id = files[i] ? "ss-rm-" + files[i] : files[i - 1] ? "ss-rm-" + files[i - 1] : "ss-addfile";
      return { ...st, files, note: null, focus: focusOn(st, id), live: "Removed " + FBY[a.id].name + ". " + filesWord(files.length) + ", " + fmt(total(files)) + "." };
    }
    case "PICK_NET": {
      const st = takeOver(s);
      const n = NETS[a.id];
      const how = n.route === "relay" ? RELAY_HOW : "Direct: bytes go straight across.";
      const lead = st.phase === "sharing" ? "People who join next connect from " + n.name + ". " : "Everyone joins from " + n.name + ". ";
      return { ...st, net: a.id, note: null, live: lead + how };
    }
    case "ADD_PERSON": {
      const st = takeOver(s);
      if (st.people.length >= MAX_PEOPLE) return noteSay(st, "people", "A link takes up to 10 people. Send another link for more.");
      const r = addPersonRaw(st);
      if (!r.p) return st;
      const n = NETS[st.net];
      const msg = st.phase === "sharing"
        ? r.p.name + " opened the link from " + n.name + ". " + (n.route === "relay" ? "That network blocks a direct path, so their bytes go through the encrypted relay." : "Their bytes go direct.")
        : r.p.name + " added. " + (st.people.length + 1) + " of 10 people.";
      return { ...r.s, note: null, live: msg };
    }
    case "REMOVE_PERSON": {
      const st = takeOver(s);
      if (st.phase === "sharing") return noteSay(st, "people", "Anyone with the link can join while you share. End sharing to stop it.");
      if (st.people.length <= 1) return noteSay(st, "people", "Keep at least one person.");
      const last = st.people[st.people.length - 1];
      const people = st.people.slice(0, -1);
      return { ...st, people, note: null, live: "Removed " + last.name + ". " + people.length + " of 10 people." };
    }
    case "SEND": {
      const st = takeOver(s);
      if (st.phase !== "sharing") return startSend(st, false);
      return { ...st, confirm: true, note: null, focus: focusOn(st, "ss-keep") };
    }
    case "KEEP":
      return { ...s, confirm: false, live: "Still sharing.", focus: focusOn(s, "ss-send") };
    case "END": {
      const people = s.people.map((p): Person => ({ ...p, st: "waiting", p: 0, net: null, rip: false }));
      return { ...s, phase: "setup", confirm: false, people, note: null, lcGen: s.lcGen + 1, focus: focusOn(s, "ss-send"), live: "Sharing ended. markdrop.in/share/" + LINKS[s.link] + " stopped working. Change the files or the network, then send again." };
    }
    case "TAB": {
      const st = takeOver(s);
      return { ...st, tab: a.tab, focus: a.focus ? focusOn(st, "ss-tab-" + a.tab) : st.focus };
    }
    case "COPIED":
      if (!a.which) return s.copied ? { ...s, copied: null } : s;
      return { ...takeOver(s), copied: a.which, live: "Command copied." };
    case "TOGGLE_DEMO": {
      if (s.reduced) {
        // The demo never plays under reduced motion: the control puts the still demo frame back.
        return { ...resetDemo(s), q: [], doneAt: 0, cyc: 0, attract: true, paused: true, confirm: false, note: null, caption: REDUCED_CAP, live: "Demo reset." };
      }
      if (s.attract) {
        const paused = !s.paused;
        return { ...s, paused, caption: paused ? "Demo paused." : DEMO_CAP, live: paused ? "Demo paused." : "Demo playing." };
      }
      return { ...resetDemo(s), q: [], doneAt: 0, cyc: 0, attract: true, paused: false, confirm: false, note: null, caption: DEMO_CAP, live: "Demo playing." };
    }
  }
  return s;
}

/* ── derive(): renderVals() as data ── */
export interface FileRowVM { id: FileId; key: string; fx: boolean; name: string; kind: FileKind; size: string; domId: string; aria: string; locked: boolean }
export interface NetVM { id: NetId; name: string; route: string; relay: boolean; on: boolean; aria: string }
export interface PersonVM {
  id: number; name: string; first: string; initials: string; status: string; st: PStatus; neutral: boolean; fx: boolean; rip: boolean;
  relay: boolean; routeName: string; sr: string; pv: number; done: boolean;
  x: number; y: number; ny: number; d: string; dn: string;
}
export interface PacketVM { key: string; d: string; dn: string; dur: number; delay: number; rest: number }
export interface VM {
  filesMeta: string;
  fileRows: FileRowVM[];
  addFile: { dis: boolean; aria: string };
  note: Note | null;
  nets: NetVM[];
  netHint: string;
  send: { end: boolean; text: string };
  sharing: boolean;
  linkId: string;
  linkKey: string;
  linkFx: boolean;
  qrD: string;
  shareStatus: string;
  setupStatus: string;
  senderFiles: FileId[];
  sizeLine: { count: string; size: string };
  relay: { show: boolean; used: boolean; on: boolean; text: string };
  people: PersonVM[];
  packets: PacketVM[];
  narrow: { h: number; top0: number };
  peopleCount: string;
  addPerson: { dis: boolean };
  rmPerson: { dis: boolean };
  confirm: { open: boolean; body: string; who: string[] };
  tab: Tab;
  linkShort: string;
  recvFiles: Array<{ id: FileId; name: string; kind: FileKind; size: string }>;
  recvMore: string | null;
  sendCmd: string;
  getCmd: string;
  copied: CopyTarget | null;
  keeps: { names: string; size: string; count: string };
  routes: { direct: { dim: boolean; count: string }; relay: { show: boolean; dim: boolean; count: string } };
  goal: { label: string; chips: Array<{ id: NetId; name: string; on: boolean }>; count: string; all: boolean };
  caption: string;
  captionReduced: string | null;
  pp: { show: boolean; text: string; glyph: "pause" | "play" | "reset"; motionOnly: boolean };
  frozen: boolean;
  live: string;
}

export function derive(s: State): VM {
  const sharing = s.phase === "sharing";
  const nFiles = s.files.length;
  const tot = total(s.files);
  const linkId = LINKS[s.link];
  const files = s.files.map((id) => FBY[id]);

  const fileRows = files.map((f): FileRowVM => ({ id: f.id, key: f.id + ":" + (s.fkeys[f.id] || 0), fx: !!s.fkeys[f.id], name: f.name, kind: f.kind, size: fmt(f.bytes), domId: "ss-rm-" + f.id, aria: "Remove " + f.name, locked: sharing || nFiles <= 1 }));
  const nextFile = FILES.find((x) => s.files.indexOf(x.id) < 0);
  const addDis = sharing || nFiles >= MAX_FILES;

  const nets = NET_ORDER.map((id): NetVM => {
    const n = NETS[id];
    const route = n.route === "relay" ? "Relayed" : "Direct";
    return { id, name: n.name, route, relay: n.route === "relay", on: s.net === id, aria: n.name + ", " + route.toLowerCase() };
  });
  const netName = NETS[s.net].name;
  const netHint = sharing
    ? "People who join next connect from " + netName + "." + (s.people.length > 0 ? " People already on the link keep their route." : "")
    : "Everyone joins from " + netName + ". Press Send, then add people to mix networks.";

  /* People on the stage */
  const pos = slots(s.people.length);
  const g = narrowGeo(s.people.length);
  const what = nFiles === 1 ? "Got the file" : "Got " + nFiles + " files";
  let directN = 0;
  let relayN = 0;
  let relayLive = false;
  const packets: PacketVM[] = [];
  const people = s.people.map((p, i): PersonVM => {
    const net = p.net || s.net;
    const route = NETS[net].route;
    if (route === "relay") relayN += 1; else directN += 1;
    const st = sharing ? p.st : "waiting";
    const xy = pos[i];
    const ny = g.ys[i];
    const d = pathFor(route, xy.x, xy.y);
    const dn = narrowPath(route, g, ny);
    if (route === "relay" && (st === "joining" || st === "receiving")) relayLive = true;
    if (st === "receiving") {
      const dur = route === "relay" ? 1.9 : net === "wifi" ? 1.05 : 1.4;
      [0, 1].forEach((k) => {
        const delay = k * dur / 2 + (p.id % 3) * 0.17;
        packets.push({ key: p.id + "-" + k, d, dn, dur, delay: Number(delay.toFixed(2)), rest: Math.round(((delay % dur) / dur) * 100) });
      });
    }
    let status = "Not joined yet";
    if (sharing && st === "waiting") status = "Joining";
    if (st === "joining") status = "Connecting";
    if (st === "receiving") status = Math.round(p.p) + "%";
    if (st === "done") status = what;
    const routeName = NETS[net].name + ", " + (route === "relay" ? "relayed" : "direct");
    const parts = p.name.split(" ");
    return {
      id: p.id, name: p.name, first: parts[0], initials: parts.slice(0, 2).map((w) => w[0].toUpperCase()).join(""),
      status, st, neutral: st === "waiting", fx: p.fx, rip: p.rip && st === "done", relay: route === "relay", routeName, sr: routeName + ". " + status + ".",
      pv: Math.round(p.p), done: st === "done", x: xy.x, y: xy.y, ny, d, dn,
    };
  });

  const downloading = s.people.filter((p) => p.st === "joining" || p.st === "receiving");
  let body = "Everyone has the files. The link stops working.";
  if (downloading.length === 1) body = downloading[0].name + " is still downloading. Their download stops, and the link stops working.";
  if (downloading.length > 1) body = downloading.length + " people are still downloading. Their downloads stop, and the link stops working.";

  const nPeople = s.people.length;
  const doneN = s.people.filter((p) => p.st === "done").length;
  const seen = s.seen || {};

  const motionPoster = !s.reduced && s.attract && !s.paused;
  const pp: VM["pp"] = s.reduced
    ? { show: !s.attract, text: "Reset demo", glyph: "reset", motionOnly: false }
    : { show: true, text: s.attract && !s.paused ? "Pause demo" : "Play demo", glyph: s.attract && !s.paused ? "pause" : "play", motionOnly: motionPoster };

  return {
    filesMeta: filesWord(nFiles) + " · " + fmt(tot),
    fileRows,
    addFile: { dis: addDis, aria: "Add a file" + (nextFile && !addDis ? ": " + nextFile.name : "") },
    note: s.note,
    nets,
    netHint,
    send: { end: sharing, text: sharing ? "End sharing" : "Send" },
    sharing,
    linkId,
    linkKey: (sharing ? "on-" : "off-") + s.lcGen,
    linkFx: s.lcGen > 0,
    qrD: QRS[s.link],
    shareStatus: doneN === nPeople ? "Everyone has the files. You can end sharing." : "Keep this tab open until everyone has them.",
    setupStatus: filesWord(nFiles) + " ready for " + peopleWord(nPeople),
    senderFiles: s.files.slice(),
    sizeLine: { count: filesWord(nFiles), size: fmt(tot) },
    relay: { show: SHOW_RELAY, used: relayN > 0, on: relayLive && sharing, text: relayN > 0 ? "Forwards bytes it can't read" : "Used only if a network blocks a direct path" },
    people,
    packets,
    narrow: { h: g.h, top0: g.top0 },
    peopleCount: nPeople + " of 10 people",
    addPerson: { dis: nPeople >= MAX_PEOPLE },
    rmPerson: { dis: sharing || nPeople <= 1 },
    confirm: { open: s.confirm, body, who: downloading.map((p) => p.name + " · " + Math.round(p.p) + "%") },
    tab: s.tab,
    linkShort: sharing ? "markdrop.in/share/" + linkId : "markdrop.in/share/…",
    recvFiles: files.slice(0, 3).map((f) => ({ id: f.id, name: f.name, kind: f.kind, size: fmt(f.bytes) })),
    recvMore: nFiles > 3 ? "+" + (nFiles - 3) + " more" : null,
    sendCmd: "markdrop send ./photos",
    getCmd: "markdrop get markdrop.in/share/" + linkId,
    copied: s.copied,
    keeps: { names: files[0].name + (nFiles > 1 ? " +" + (nFiles - 1) : ""), size: fmt(tot), count: filesWord(nFiles) },
    routes: {
      direct: { dim: !directN, count: directN ? peopleWord(directN) : "Nobody right now" },
      relay: { show: SHOW_RELAY, dim: !relayN, count: relayN ? peopleWord(relayN) : "Nobody right now" },
    },
    goal: {
      label: "Deliver over each network",
      chips: NET_ORDER.map((id) => ({ id, name: NETS[id].name, on: !!seen[id] })),
      count: s.delivered + (s.delivered === 1 ? " delivery" : " deliveries"),
      all: s.goalDone,
    },
    caption: s.attract ? s.caption : YOUR_TURN,
    captionReduced: motionPoster ? REDUCED_CAP : null,
    pp,
    frozen: !s.awake || (s.attract && (s.paused || s.hold)),
    live: s.live,
  };
}
