/**
 * Sync Desk: pure data, state and reducer (no React, no DOM). Ported from
 * design/revamp-canvas/PlaySyncDesk.dc.html (`class Component extends DCLogic`).
 *
 * Board method → reducer port (every instance field the board kept on `this` is a state field here,
 * so the reducer is deterministic and the server can render `initialState`):
 *   tick()          → TICK { demo }   (clock += 100; land flights, autosave after 800 ms, expire
 *                                       the fresh highlight and the editor note, advance the demo)
 *   attractTick()   → attractTick()   (called from TICK while the demo plays and the stage is in view)
 *   demoStep(act)   → demoStep()      (type / web / both / resolve / reset)
 *   interact()      → interact()      (first user input stops the demo for good)
 *   toggleDemo()    → TOGGLE_DEMO     (pausing also drops half-typed demo text, as interact() does,
 *                                       so a paused demo never autosaves a broken line)
 *   onType(e)       → TYPE { value }
 *   onEdKey(e)      → SAVE_KEY        (the Game checks ⌘S / Ctrl+S and calls preventDefault)
 *   onEdFocus       → ED_FOCUS
 *   onEdScroll      → ED_SCROLL { top }
 *   save()          → save()
 *   fly() / land()  → fly() / land()  (flight end time is a state field; reduced motion lands at once)
 *   openConflict()  → openConflict()
 *   goalNote()      → goalNote()
 *   webEdit(true)   → WEB_EDIT        editBoth(true) → EDIT_BOTH
 *   keepMine(true)  → KEEP_MINE       useWeb(true)   → USE_WEB      mergeManual(true) → MERGE_MANUAL
 *   backToDiff()    → BACK_TO_DIFF    saveMerge(true) → SAVE_MERGE
 *   focusOn(id)     → `focus` request ({ id, n }); the Game focuses the element after the commit
 *   resetScroll()   → `scrollReset` counter; the Game scrolls the textarea to the top
 *   componentDidMount reduce check → REDUCE { on }
 *   (new) AUTOPLAY  → starts the demo once, when the stage first comes into view, unless the visitor
 *                     already interacted or prefers reduced motion
 *   (new) SEEN      → whether the stage is on screen (the demo only advances while it is)
 *   renderVals()    → deriveView()    (theme toggle dropped: the toy follows the site theme)
 */

export const SEED = ["# Q4 roadmap", "", "## Now", "- Ship the **beta** to the team", "- Write the `install` guide", "", "## Next", "- Collect feedback"].join("\n");
export const WEB_EDITS = ["- Book the launch review", "- Draft the **release notes**", "- Update the `changelog`", "- Plan the next sprint"];
export const CLASHES: ReadonlyArray<readonly [string, string]> = [
  ["- Launch on **Friday**", "- Launch on **Thursday**"],
  ["- Owner: Sam", "- Owner: Priya"],
  ["- Demo in `#general`", "- Demo in `#launch`"],
];
export const DEMO_TYPE = ["\n- Invite the **team**", "\n- Record a `demo` video", "\n- Share the link"];
export const FLY = 900;
export const LOOP = 17000;
export const TICK_MS = 100;
export const SAVE_AFTER = 800;
export const ATTRACT: ReadonlyArray<{ at: number; act: DemoAct }> = [
  { at: 1200, act: "type" },
  { at: 7000, act: "web" },
  { at: 10500, act: "both" },
  { at: 13600, act: "resolve" },
  { at: 16200, act: "reset" },
];

/** Display text only (the sample doc is not published), never a link. */
export const DOC_HOST = "markdrop.in";
export const DOC_PATH = "/q4-roadmap";
export const EXTENSION_URL = "https://marketplace.visualstudio.com/items?itemName=HimanshuKukreja.markdrop";

export type DemoAct = "type" | "web" | "both" | "resolve" | "reset";
export type Mode = "idle" | "up" | "down" | "clash" | "conflict" | "merge";
export type FlyDir = "up" | "down" | "clash";
export type GoalKey = "save" | "web" | "fix";

export interface FlightOpt {
  goal?: GoalKey | "";
  src?: string;
  msg?: string;
  note?: string;
  force?: boolean;
  user?: boolean;
}

export interface Flight {
  dir: FlyDir;
  payload: string;
  end: number;
  opt: FlightOpt;
}

export interface State {
  ed: string;
  saved: string;
  page: string;
  rev: number;
  revTo: number;
  mode: Mode;
  upN: number;
  dnN: number;
  clN: number;
  hitEd: number;
  hitPg: number;
  hubFx: { k: "bump" | "shake"; n: number } | null;
  conflict: { mine: string; web: string } | null;
  goals: Record<GoalKey, boolean>;
  fresh: string[];
  pageSrc: string;
  edNote: string;
  scrollTop: number;
  attract: boolean;
  live: string;
  /* Former instance fields of the board's component. */
  clock: number;
  aClock: number;
  aIdx: number;
  loopN: number;
  typedAt: number;
  flight: Flight | null;
  typeQ: string;
  demoDirty: boolean;
  webN: number;
  clashN: number;
  freshUntil: number;
  noteUntil: number;
  /* Side-effect requests the Game carries out after the commit. */
  focus: { id: string; n: number } | null;
  scrollReset: number;
  /* Environment and motion policy. */
  reduce: boolean;
  touched: boolean;
  autoDone: boolean;
  onScreen: boolean;
}

/**
 * The static first frame (server poster) and the Game's first render. The demo is off here; the Game
 * starts it once the stage is on screen (never under reduced motion), so the poster never claims a
 * demo is playing when it can't.
 */
export const initialState: State = {
  ed: SEED,
  saved: SEED,
  page: SEED,
  rev: 12,
  revTo: 0,
  mode: "idle",
  upN: 0,
  dnN: 0,
  clN: 0,
  hitEd: 0,
  hitPg: 0,
  hubFx: null,
  conflict: null,
  goals: { save: false, web: false, fix: false },
  fresh: [],
  pageSrc: "Published from VS Code",
  edNote: "",
  scrollTop: 0,
  attract: false,
  live: "",
  clock: 0,
  aClock: 0,
  aIdx: 0,
  loopN: 0,
  typedAt: 0,
  flight: null,
  typeQ: "",
  demoDirty: false,
  webN: 0,
  clashN: 0,
  freshUntil: 0,
  noteUntil: 0,
  focus: null,
  scrollReset: 0,
  reduce: false,
  touched: false,
  autoDone: false,
  onScreen: false,
};

export type Action =
  | { type: "TICK"; demo: boolean }
  | { type: "TYPE"; value: string }
  | { type: "SAVE_KEY" }
  | { type: "ED_FOCUS" }
  | { type: "ED_SCROLL"; top: number }
  | { type: "WEB_EDIT" }
  | { type: "EDIT_BOTH" }
  | { type: "KEEP_MINE" }
  | { type: "USE_WEB" }
  | { type: "MERGE_MANUAL" }
  | { type: "BACK_TO_DIFF" }
  | { type: "SAVE_MERGE" }
  | { type: "TOGGLE_DEMO" }
  | { type: "AUTOPLAY" }
  | { type: "REDUCE"; on: boolean }
  | { type: "SEEN"; on: boolean };

/* ── Small helpers ──────────────────────────────────────────────────────── */

const trimEnd = (t: string) => t.replace(/\s+$/, "");

function say(s: State, msg: string): State {
  return { ...s, live: msg };
}

function focusOn(s: State, id: string): State {
  return { ...s, focus: { id, n: (s.focus ? s.focus.n : 0) + 1 } };
}

function bump(s: State, k: "bump" | "shake"): { k: "bump" | "shake"; n: number } {
  return { k, n: s.hubFx ? s.hubFx.n + 1 : 1 };
}

function goalNote(before: Record<GoalKey, boolean>, after: Record<GoalKey, boolean>): string {
  const keys: GoalKey[] = ["save", "web", "fix"];
  const n = keys.filter((k) => after[k]).length;
  const was = keys.filter((k) => before[k]).length;
  if (n === was) return "";
  return n === 3 ? " All three ways synced." : " " + n + " of 3 ways synced.";
}

/** True while something time-based is still pending, so the Game keeps the clock running. */
export function needsTick(s: State): boolean {
  return !!s.flight || !!s.typeQ || (s.mode === "idle" && s.ed !== s.saved) || s.fresh.length > 0 || !!s.edNote;
}

/* ── Board methods, ported ──────────────────────────────────────────────── */

/** First real input: stop the demo for good and drop its half-typed text. */
function interact(s: State): State {
  if (!s.attract) return s.touched ? s : { ...s, touched: true };
  let n: State = { ...s, typeQ: "", attract: false, touched: true };
  if (n.demoDirty && n.mode === "idle" && n.ed !== n.saved) n = { ...n, ed: n.saved, demoDirty: false };
  return n;
}

function fly(s: State, dir: FlyDir, payload: string, opt: FlightOpt): State {
  let n: State = { ...s, flight: { dir, payload, end: s.clock + (s.reduce ? 0 : FLY), opt }, mode: dir, revTo: s.rev + 1 };
  if (dir === "up") n.upN = s.upN + 1;
  else if (dir === "down") n.dnN = s.dnN + 1;
  else n.clN = s.clN + 1;
  if (s.reduce) n = land(n);
  return n;
}

function openConflict(s: State, mine: string, web: string, rev: number, user: boolean, unsaved: boolean): State {
  let n: State = {
    ...s,
    mode: "conflict",
    conflict: { mine, web },
    rev,
    revTo: 0,
    hubFx: bump(s, "shake"),
    pageSrc: "Edited on the web",
    hitEd: s.hitEd + 1,
    scrollTop: 0,
  };
  n = say(
    n,
    (unsaved
      ? "roadmap.md had unsaved changes when the web edit arrived, so this is a conflict. "
      : "Conflict. roadmap.md changed in VS Code and on the web. ") + "Choose Keep mine, Use web or Merge manually.",
  );
  if (user) n = focusOn(n, "sd-keep");
  return n;
}

function land(s0: State): State {
  const f = s0.flight;
  if (!f) return s0;
  const s: State = { ...s0, flight: null };
  const o = f.opt;
  const rev = s.rev + 1;
  const goals = { ...s.goals };
  if (f.dir === "up") {
    const old = s.page.split("\n");
    const fresh = f.payload.split("\n").filter((l) => l.trim() && old.indexOf(l) < 0);
    if (o.goal) goals[o.goal] = true;
    const n: State = {
      ...s,
      freshUntil: s.clock + 1600,
      page: f.payload,
      rev,
      revTo: 0,
      mode: "idle",
      conflict: null,
      fresh,
      hitPg: s.hitPg + 1,
      hubFx: bump(s, "bump"),
      pageSrc: o.src || "Saved from VS Code",
      goals,
    };
    return say(n, (o.msg || "Page updated.") + " Now at rev " + rev + "." + goalNote(s.goals, goals));
  }
  if (f.dir === "down") {
    if (!o.force && s.ed !== s.saved && s.ed !== f.payload) return openConflict(s, s.ed, f.payload, rev, !!o.user, true);
    if (o.goal) goals[o.goal] = true;
    const n: State = {
      ...s,
      noteUntil: s.clock + 1800,
      ed: f.payload,
      saved: f.payload,
      rev,
      revTo: 0,
      mode: "idle",
      conflict: null,
      hitEd: s.hitEd + 1,
      hubFx: bump(s, "bump"),
      edNote: o.note || "Updated from the web",
      goals,
    };
    return say(n, (o.msg || "roadmap.md updated from the web.") + " Now at rev " + rev + "." + goalNote(s.goals, goals));
  }
  return openConflict(s, s.ed, s.page, rev, !!o.user, false);
}

/** Save the file: the change travels editor → page. */
function save(s: State, user: boolean, explicit: boolean): State {
  if (s.mode === "merge") return saveMerge(s, user);
  if (s.mode !== "idle" || s.flight) {
    if (explicit) return say(s, s.mode === "conflict" ? "Choose Keep mine, Use web or Merge manually first." : "Hold on, a sync is still landing.");
    return s;
  }
  if (s.ed === s.saved) return explicit ? say(s, "Already in sync at rev " + s.rev + ".") : s;
  const wasDemo = s.demoDirty;
  let n: State = { ...s, demoDirty: false, saved: s.ed };
  n = say(n, "Saved in VS Code. Sending the change to the page.");
  return fly(n, "up", s.ed, { goal: user && !wasDemo ? "save" : "", src: "Saved from VS Code", msg: "Page updated from VS Code." });
}

/** The page changes on the web: the change travels page → editor. */
function webEdit(s0: State, user: boolean): State {
  const s = user ? interact(s0) : s0;
  if (s.mode === "conflict" || s.mode === "merge") return user ? say(s, "Resolve the conflict in VS Code first.") : s;
  if (s.mode !== "idle" || s.flight) return user ? say(s, "Wait for the sync to land.") : s;
  const have = s.page.split("\n");
  let line = "";
  let webN = s.webN;
  for (let k = 0; k < WEB_EDITS.length; k++) {
    const c = WEB_EDITS[(webN + k) % WEB_EDITS.length];
    if (have.indexOf(c) < 0) {
      line = c;
      webN += k + 1;
      break;
    }
  }
  if (!line) {
    webN += 1;
    line = "- Web note " + webN;
  }
  const page = trimEnd(s.page) + "\n" + line;
  const dirty = s.ed !== s.saved;
  let n: State = { ...s, webN, freshUntil: s.clock + 1600, page, fresh: [line], pageSrc: "Edited on the web", hitPg: s.hitPg + 1 };
  n = say(n, dirty ? "Edited on the web while roadmap.md has unsaved changes." : "Edited on the web. Sending the change to roadmap.md.");
  return fly(n, "down", page, { goal: user ? "web" : "", user, note: "Updated from the web", msg: "roadmap.md updated from the web." });
}

/** Both sides change at once: the two drops meet and open a diff. */
function editBoth(s0: State, user: boolean): State {
  const s = user ? interact(s0) : s0;
  if (s.mode !== "idle" || s.flight) {
    if (!user) return s;
    return say(s, s.mode === "conflict" || s.mode === "merge" ? "There is already a conflict to resolve in VS Code." : "Wait for the sync to land.");
  }
  const pair = CLASHES[s.clashN % CLASHES.length];
  const mine = trimEnd(s.ed) + "\n" + pair[0];
  const web = trimEnd(s.page) + "\n" + pair[1];
  let n: State = {
    ...s,
    clashN: s.clashN + 1,
    freshUntil: s.clock + 1600,
    typedAt: s.clock,
    ed: mine,
    page: web,
    fresh: [pair[1]],
    pageSrc: "Edited on the web",
    hitPg: s.hitPg + 1,
    hitEd: s.hitEd + 1,
  };
  n = say(n, "Edited in VS Code and on the web at the same time.");
  return fly(n, "clash", web, { user });
}

function keepMine(s0: State, user: boolean): State {
  const s = user ? interact(s0) : s0;
  if (s.mode !== "conflict" || !s.conflict) return s;
  const t = s.conflict.mine;
  let n: State = { ...s, demoDirty: false, ed: t, saved: t, conflict: null };
  n = say(n, "Keeping your version. Sending it to the page.");
  n = fly(n, "up", t, { goal: user ? "fix" : "", src: "Kept the VS Code version", msg: "Conflict resolved with your version." });
  return user ? focusOn(n, "sd-editor") : n;
}

function useWeb(s0: State, user: boolean): State {
  const s = user ? interact(s0) : s0;
  if (s.mode !== "conflict" || !s.conflict) return s;
  const t = s.conflict.web;
  let n: State = { ...s, conflict: null };
  n = say(n, "Using the web version. Sending it to roadmap.md.");
  n = fly(n, "down", t, { force: true, goal: user ? "fix" : "", note: "Replaced with the web version", msg: "Conflict resolved with the web version." });
  return user ? focusOn(n, "sd-editor") : n;
}

function mergeManual(s0: State, user: boolean): State {
  const s = user ? interact(s0) : s0;
  if (s.mode !== "conflict" || !s.conflict) return s;
  const merged = diffLines(s.conflict.mine, s.conflict.web)
    .map((x) => x.t)
    .join("\n");
  let n: State = { ...s, mode: "merge", ed: merged, scrollTop: 0 };
  n = say(n, "Both versions are now in roadmap.md. Edit what you want to keep, then press Save merge.");
  return user ? focusOn(n, "sd-editor") : n;
}

function backToDiff(s0: State): State {
  const s = interact(s0);
  if (s.mode !== "merge" || !s.conflict) return s;
  let n: State = { ...s, mode: "conflict", ed: s.conflict.mine, scrollTop: 0 };
  n = say(n, "Back to the diff. Choose Keep mine, Use web or Merge manually.");
  return focusOn(n, "sd-keep");
}

function saveMerge(s0: State, user: boolean): State {
  const s = user ? interact(s0) : s0;
  if (s.mode !== "merge") return s;
  const t = s.ed;
  let n: State = { ...s, demoDirty: false, saved: t, conflict: null };
  n = say(n, "Merge saved. Sending it to the page.");
  n = fly(n, "up", t, { goal: user ? "fix" : "", src: "Merged in VS Code", msg: "Conflict resolved with your merge." });
  return user ? focusOn(n, "sd-editor") : n;
}

function demoStep(s: State, act: DemoAct): State {
  if (act === "type") return s.mode === "idle" && !s.flight ? { ...s, typeQ: DEMO_TYPE[s.loopN % DEMO_TYPE.length] } : s;
  if (act === "web") return webEdit(s, false);
  if (act === "both") return editBoth(s, false);
  if (act === "resolve") {
    if (s.mode === "conflict") return s.loopN % 2 ? useWeb(s, false) : keepMine(s, false);
    if (s.mode === "merge") return saveMerge(s, false);
    return s;
  }
  if (s.mode === "idle" && !s.flight) {
    return { ...s, demoDirty: false, ed: SEED, saved: SEED, page: SEED, fresh: [], pageSrc: "Published from VS Code", scrollTop: 0, scrollReset: s.scrollReset + 1 };
  }
  return s;
}

function attractTick(s0: State): State {
  let s = s0;
  if (s.typeQ) {
    const ch = s.typeQ.charAt(0);
    s = { ...s, typeQ: s.typeQ.slice(1), demoDirty: true, typedAt: s.clock, ed: s.ed + ch };
  }
  s = { ...s, aClock: s.aClock + TICK_MS };
  while (s.aIdx < ATTRACT.length && s.aClock >= ATTRACT[s.aIdx].at) {
    s = demoStep(s, ATTRACT[s.aIdx].act);
    s = { ...s, aIdx: s.aIdx + 1 };
  }
  if (s.aClock >= LOOP) s = { ...s, aClock: 0, aIdx: 0, loopN: s.loopN + 1 };
  return s;
}

function tick(s0: State, demo: boolean): State {
  let s: State = { ...s0, clock: s0.clock + TICK_MS };
  if (s.flight && s.clock >= s.flight.end) s = land(s);
  if (s.mode === "idle" && !s.flight && !s.typeQ && s.ed !== s.saved && s.clock - s.typedAt >= SAVE_AFTER) s = save(s, !s.demoDirty, false);
  if (s.fresh.length && s.clock >= s.freshUntil) s = { ...s, fresh: [] };
  if (s.edNote && s.clock >= s.noteUntil) s = { ...s, edNote: "" };
  if (s.attract && demo) s = attractTick(s);
  return s;
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "TICK":
      return tick(s, a.demo);
    case "TYPE": {
      const n = interact(s);
      return { ...n, demoDirty: false, typedAt: n.clock, ed: a.value };
    }
    case "SAVE_KEY":
      return save(interact(s), true, true);
    case "ED_FOCUS":
      return interact(s);
    case "ED_SCROLL":
      return a.top === s.scrollTop ? s : { ...s, scrollTop: a.top };
    case "WEB_EDIT":
      return webEdit(s, true);
    case "EDIT_BOTH":
      return editBoth(s, true);
    case "KEEP_MINE":
      return keepMine(s, true);
    case "USE_WEB":
      return useWeb(s, true);
    case "MERGE_MANUAL":
      return mergeManual(s, true);
    case "BACK_TO_DIFF":
      return backToDiff(s);
    case "SAVE_MERGE":
      return saveMerge(s, true);
    case "TOGGLE_DEMO":
      if (s.attract) return say(interact(s), "Demo paused. Your turn.");
      return say({ ...s, aClock: 0, aIdx: 0, attract: true, touched: true, autoDone: true }, "Demo playing. Press Pause demo or edit anything to take over.");
    case "AUTOPLAY":
      if (s.attract || s.touched || s.autoDone || s.reduce) return s;
      return { ...s, attract: true, autoDone: true, aClock: 0, aIdx: 0 };
    case "REDUCE":
      if (a.on === s.reduce) return s;
      /* Reduced motion never autoplays: a demo the page started on its own stops. */
      return a.on && s.attract && !s.touched ? { ...s, reduce: true, attract: false, typeQ: "" } : { ...s, reduce: a.on };
    case "SEEN":
      return a.on === s.onScreen ? s : { ...s, onScreen: a.on };
    default:
      return s;
  }
}

/* ── Markdown and diff, ported verbatim ─────────────────────────────────── */

export type SegKind = "" | "b" | "cd";
export interface Seg {
  t: string;
  k: SegKind;
}
export type BlockKind = "h1" | "h2" | "h3" | "li" | "p" | "gap" | "empty";
export interface Block {
  kind: BlockKind;
  fresh: boolean;
  segs: Seg[];
}

function inline(text: string): Seg[] {
  const out: Seg[] = [];
  text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).forEach((p) => {
    if (!p) return;
    if (p.length > 4 && p.slice(0, 2) === "**" && p.slice(-2) === "**") out.push({ t: p.slice(2, -2), k: "b" });
    else if (p.length > 2 && p.charAt(0) === "`" && p.charAt(p.length - 1) === "`") out.push({ t: p.slice(1, -1), k: "cd" });
    else out.push({ t: p, k: "" });
  });
  return out;
}

/** A tiny renderer: #, ##, ###, - lists, **bold**, `code`. */
export function renderMd(md: string, fresh: string[]): Block[] {
  const out: Block[] = [];
  let lastGap = true;
  md.split("\n").forEach((raw) => {
    const line = trimEnd(raw);
    if (line.trim() === "") {
      if (!lastGap) out.push({ kind: "gap", fresh: false, segs: [] });
      lastGap = true;
      return;
    }
    lastGap = false;
    const f = fresh.some((x) => trimEnd(x) === line);
    let m: RegExpExecArray | null;
    if ((m = /^#\s+(.*)$/.exec(line))) out.push({ kind: "h1", fresh: f, segs: inline(m[1]) });
    else if ((m = /^##\s+(.*)$/.exec(line))) out.push({ kind: "h2", fresh: f, segs: inline(m[1]) });
    else if ((m = /^#{3,6}\s+(.*)$/.exec(line))) out.push({ kind: "h3", fresh: f, segs: inline(m[1]) });
    else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) out.push({ kind: "li", fresh: f, segs: inline(m[1]) });
    else out.push({ kind: "p", fresh: f, segs: inline(line) });
  });
  if (!out.length) out.push({ kind: "empty", fresh: false, segs: [{ t: "This page is empty. Type in roadmap.md to fill it.", k: "" }] });
  return out;
}

export interface DiffEntry {
  t: string;
  s: "both" | "a" | "b";
}

/** Line diff (LCS). s: both | a (yours only) | b (web only). */
export function diffLines(a: string, b: string): DiffEntry[] {
  const A = a.split("\n");
  const B = b.split("\n");
  const n = A.length;
  const m = B.length;
  const dp: number[][] = [];
  for (let i = 0; i <= n; i++) dp.push(new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out: DiffEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ t: A[i], s: "both" });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ t: A[i], s: "a" });
      i++;
    } else {
      out.push({ t: B[j], s: "b" });
      j++;
    }
  }
  while (i < n) out.push({ t: A[i++], s: "a" });
  while (j < m) out.push({ t: B[j++], s: "b" });
  return out;
}

export interface DiffRow {
  l: string;
  r: string;
  lk: "same" | "mine" | "pad";
  rk: "same" | "web" | "pad";
}

export function diffRows(entries: DiffEntry[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < entries.length) {
    const e = entries[i];
    if (e.s === "both") {
      rows.push({ l: e.t, r: e.t, lk: "same", rk: "same" });
      i++;
      continue;
    }
    const as: string[] = [];
    const bs: string[] = [];
    while (i < entries.length && entries[i].s !== "both") {
      (entries[i].s === "a" ? as : bs).push(entries[i].t);
      i++;
    }
    const k = Math.max(as.length, bs.length);
    for (let x = 0; x < k; x++) {
      const hasA = x < as.length;
      const hasB = x < bs.length;
      rows.push({ l: hasA ? as[x] : "", r: hasB ? bs[x] : "", lk: hasA ? "mine" : "pad", rk: hasB ? "web" : "pad" });
    }
  }
  return rows;
}

/* ── View model (renderVals without closures or theme) ──────────────────── */

export type Tone = "ok" | "busy" | "warn" | "idle";
export type Parity = "" | "a" | "b";

export interface ViewModel {
  goal: { done: boolean; count: string; pct: number; items: Array<{ key: GoalKey; label: string; on: boolean }>; caption: string };
  edHit: Parity;
  brHit: Parity;
  tabDirty: boolean;
  edNote: string;
  merge: boolean;
  showEd: boolean;
  showDiff: boolean;
  ed: string;
  gut: number;
  scrollTop: number;
  df: { sub: string; rows: DiffRow[] };
  sb: { tone: Tone; text: string; ln: string };
  arcUp: boolean;
  arcDn: boolean;
  drops: { up: Parity; dn: Parity; cl: Parity };
  hub: { tone: Tone; fx: "" | "bA" | "bB" | "sA" | "sB"; from: string; moving: boolean; to: string; st: string };
  blocks: Block[];
  pgWarn: boolean;
  rev: number;
  pageSrc: string;
  pfSync: string;
  demo: { playing: boolean; label: string };
  busy: boolean;
  liveDot: boolean;
  live: string;
}

const par = (n: number): Parity => (n ? (n % 2 ? "a" : "b") : "");

export function deriveView(s: State): ViewModel {
  const mode = s.mode;
  const dirty = s.ed !== s.saved;
  const merge = mode === "merge";
  const conflictOpen = mode === "conflict" && !!s.conflict;

  let st = "Synced";
  let tone: Tone = "ok";
  let sbText = "Synced · rev " + s.rev;
  if (mode === "conflict") {
    st = "Conflict";
    tone = "warn";
    sbText = "Conflict · choose a version";
  } else if (merge) {
    st = "Merging";
    tone = "warn";
    sbText = "Merging · save when ready";
  } else if (mode === "up") {
    st = "Syncing to the page";
    tone = "busy";
    sbText = "Syncing to the page";
  } else if (mode === "down") {
    st = "Syncing to roadmap.md";
    tone = "busy";
    sbText = "Pulling from the web";
  } else if (mode === "clash") {
    st = "Both sides changed";
    tone = "warn";
    sbText = "Both sides changed";
  } else if (dirty) {
    st = "Unsaved in VS Code";
    tone = "idle";
    sbText = "Unsaved changes";
  }

  const fx = s.hubFx;
  const hubFx: ViewModel["hub"]["fx"] = fx ? (fx.k === "bump" ? (fx.n % 2 ? "bA" : "bB") : fx.n % 2 ? "sA" : "sB") : "";
  const lines = s.ed.split("\n");

  let df: ViewModel["df"] = { sub: "", rows: [] };
  if (s.conflict) {
    const d = diffLines(s.conflict.mine, s.conflict.web);
    const nDiff = d.filter((x) => x.s !== "both").length;
    df = { sub: nDiff + (nDiff === 1 ? " line differs" : " lines differ") + " since the last sync. Choose what stays.", rows: diffRows(d) };
  }

  const g = s.goals;
  const done = [g.save, g.web, g.fix].filter(Boolean).length;
  const busy = mode !== "idle";
  const pgWarn = mode === "conflict" || merge || mode === "clash";

  return {
    goal: {
      done: done === 3,
      count: done + " of 3",
      pct: Math.round((done / 3) * 100),
      items: [
        { key: "save", label: "Save in VS Code", on: g.save },
        { key: "web", label: "Edit on the web", on: g.web },
        { key: "fix", label: "Resolve a conflict", on: g.fix },
      ],
      caption:
        done === 3
          ? "That is the whole loop. Your file and your page stay in step."
          : s.attract
            ? "Watching a demo. Edit anything to take over."
            : "Try each one on the stage below.",
    },
    edHit: par(s.hitEd),
    brHit: par(s.hitPg),
    tabDirty: dirty || merge,
    edNote: s.edNote,
    merge,
    showEd: !conflictOpen,
    showDiff: conflictOpen,
    ed: s.ed,
    gut: Math.min(lines.length, 200),
    scrollTop: s.scrollTop || 0,
    df,
    sb: { tone, text: sbText, ln: lines.length + (lines.length === 1 ? " line" : " lines") },
    arcUp: mode === "up",
    arcDn: mode === "down",
    drops: { up: par(s.upN), dn: par(s.dnN), cl: par(s.clN) },
    hub: { tone, fx: hubFx, from: String(s.rev), moving: !!s.revTo, to: String(s.revTo), st },
    blocks: renderMd(s.page, s.fresh),
    pgWarn,
    rev: s.rev,
    pageSrc: s.pageSrc,
    pfSync: pgWarn ? "Waiting on VS Code" : busy ? "Syncing with VS Code" : "Synced with VS Code",
    demo: s.attract ? { playing: true, label: "Pause demo" } : { playing: false, label: "Play demo" },
    busy,
    liveDot: s.attract && s.onScreen,
    live: s.live,
  };
}
