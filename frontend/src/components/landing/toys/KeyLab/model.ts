/**
 * Key Lab: the pure model (no React, no DOM). Ported from design/revamp-canvas/PlayKeyLab.dc.html.
 *
 * One key chip is the whole game. It sits after the # in the link; take it out and the browser view
 * honestly reports "This link is missing its key", put it back and the note decrypts again. The
 * ciphertext is a deterministic illustration derived from the text, labelled as such on screen.
 *
 * DCLogic method → reducer action
 *   constructor state ............. initialState
 *   componentDidMount (reduce) .... REDUCED_MOTION
 *   tick .......................... TICK { dt }  (Game only ticks in view, tab visible, no pointer down)
 *   interact ...................... applied inside every user action: stops the demo for good
 *   toggleDemo .................... TOGGLE_DEMO  (also pauses/plays the ambient loops, WCAG 2.2.2)
 *   stageDown ..................... INTERACT
 *   onNote ........................ NOTE { value }
 *   showServer / showBrowser ...... SHOW_SERVER / SHOW_BROWSER
 *   toggleKey (takeOut / putBack) . TOGGLE_KEY
 *   chipKey ....................... KEY_OUT (ArrowDown) / KEY_IN (ArrowUp)
 *   rotate ........................ ROTATE
 *   toggleSignin / closeSignin .... TOGGLE_SIGNIN / CLOSE_SIGNIN  (focus return lives in Game)
 *   chipClick ..................... TOGGLE_KEY  (Game drops the click that ends a drag: ref timestamp)
 *   chipDown / chipMove ........... DRAG_MOVE { dx, dy }  (pointer bookkeeping lives in Game refs)
 *   chipUp ........................ DRAG_END { dy }
 *   chipCancel .................... DRAG_CANCEL
 *   renderVals .................... deriveView(state)
 *
 * The board's aClock/aIdx timer fields live in state, so the reducer is deterministic.
 */

/* ── Copy and constants (claims kept to the product facts) ── */

export const NOTE0 = "Plan v2\nLaunch moves to March 4.\nKeep spend under the Q2 line.\n- Tell the team on Monday\n- Share the deck after review";
export const NOTE_MAX = 600;
const URLB = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
const STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const KEY0 = "Qx7mT2vLp9aR4sKdW1nEe0bZrN3cYh6uJq0FxV5gMt8";
export const TICK_MS = 200;
export const BEAT = 3200;
/** How far (px) the chip must travel before a release counts as a move. */
export const DROP_AT = 70;
const LINE = 40;

/** Display text only: the sample doc is not published, so this is never a link. */
export const HOST = "markdrop.in";
export const PATH = "/plan-v2";

export type Side = "browser" | "server";
export type StepId = "view" | "out" | "rot" | "sign";

const DEMO: ReadonlyArray<{ view: Side; hint: boolean }> = [
  { view: "browser", hint: false },
  { view: "server", hint: false },
  { view: "browser", hint: true },
];

export const STEPS: ReadonlyArray<{ id: StepId; n: string; t: string }> = [
  { id: "view", n: "1", t: "See what the server sees" },
  { id: "out", n: "2", t: "Take the key out of the link" },
  { id: "rot", n: "3", t: "Rotate the key" },
  { id: "sign", n: "4", t: "Try signing in instead" },
];

export const MSG = {
  idle: "Drag the key out of the link, rotate it, or switch what you see.",
  idleOut: "This link is missing its key. Drag it back up, or press Put the key back.",
  server: "Markdrop gets a request without the #k= part, and stores ciphertext it has no key for.",
  browser: "Your browser reads the key from the link and decrypts the note on your device.",
  out: "Key out. This link is missing its key, so the page cannot be decrypted.",
  back: "Key back in the link. Your browser decrypts the note again.",
  rotate: "New key, so the note is re-encrypted. The old link stops working.",
  rotateOut: "Put the key back first. Rotating re-encrypts the note, and that takes the current key.",
  sign: "Signing in does not unlock it. Only the link with its key does.",
  dragIn: "Drag the key down into the tray to take it out of the link.",
  dragOut: "Drag the key up into the link to put it back.",
  all: " That is all four: the key is the link.",
} as const;

/* ── Deterministic pseudo-ciphertext (an illustration, not real crypto) ── */

function fnv(str: string, seed: number): number {
  let h = (2166136261 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function stream(seed: number): () => number {
  let x = seed >>> 0 || 2654435769;
  return function next() {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

function chars(seed: number, n: number, alpha: string): string {
  const r = stream(seed);
  let s = "";
  for (let i = 0; i < n; i += 1) s += alpha.charAt(r() & 63);
  return s;
}

export function keyFor(i: number): string {
  return i === 0 ? KEY0 : chars(fnv("key-" + i, 1376312589), 43, URLB);
}

function sealed(text: string, keyIdx: number): string[] {
  const n = Math.min(4 * Math.ceil((text.length + 28) / 3), 640);
  const s = chars(fnv(text, 2246822519 + keyIdx * 7919), n, STD);
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += LINE) lines.push(s.slice(i, i + LINE));
  return lines;
}

export interface DocBlock {
  id: string;
  t: string;
  li: boolean;
}

export function parseNote(text: string): { title: string; blocks: DocBlock[] } {
  const rows = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let title = rows.length ? rows[0].replace(/^#+\s*/, "") : "";
  if (!title) title = "Untitled";
  if (title.length > 60) title = title.slice(0, 60) + "…";
  const blocks = rows.slice(1, 8).map((l, i) => {
    const li = /^[-*]\s+/.test(l);
    const t = li ? l.replace(/^[-*]\s+/, "") : l.replace(/^#+\s*/, "");
    return { id: "b" + i, t, li };
  });
  return { title, blocks };
}

/* ── State ── */

export interface State {
  note: string;
  keyIdx: number;
  oldKey: number;
  keyOut: boolean;
  view: Side;
  signin: boolean;
  done: Readonly<Record<StepId, boolean>>;
  complete: boolean;
  msg: string;
  /** The attract demo is running. */
  attract: boolean;
  /** Ambient loops are frozen (the Pause control, or reduced motion). */
  paused: boolean;
  hint: boolean;
  drag: { dx: number; dy: number } | null;
  moveN: number;
  snapN: number;
  outN: number;
  aClock: number;
  aIdx: number;
  /** Counts panel swaps (server / browser / missing key). The first frame doesn't animate in, so the
   *  poster-to-game swap is invisible; every later swap does. */
  swapN: number;
}

export const initialState: State = {
  note: NOTE0,
  keyIdx: 0,
  oldKey: -1,
  keyOut: false,
  view: "browser",
  signin: false,
  done: { view: false, out: false, rot: false, sign: false },
  complete: false,
  msg: "",
  attract: true,
  paused: false,
  hint: false,
  drag: null,
  moveN: 0,
  snapN: 0,
  outN: 0,
  aClock: 0,
  aIdx: 0,
  swapN: 0,
};

export type Action =
  | { type: "TICK"; dt: number }
  | { type: "REDUCED_MOTION" }
  | { type: "TOGGLE_DEMO" }
  | { type: "INTERACT" }
  | { type: "NOTE"; value: string }
  | { type: "SHOW_SERVER" }
  | { type: "SHOW_BROWSER" }
  | { type: "TOGGLE_KEY" }
  | { type: "KEY_OUT" }
  | { type: "KEY_IN" }
  | { type: "ROTATE" }
  | { type: "TOGGLE_SIGNIN" }
  | { type: "CLOSE_SIGNIN" }
  | { type: "DRAG_MOVE"; dx: number; dy: number }
  | { type: "DRAG_END"; dy: number }
  | { type: "DRAG_CANCEL" };

/* ── Machine ── */

/** The first user input stops the demo for good (Play demo can restart it on purpose). */
function interact(s: State): State {
  return s.attract ? { ...s, attract: false, hint: false, aClock: 0 } : s;
}

/** Tick a step, and on the fourth one say so once. */
function mark(s: State, id: StepId, patch: Partial<State>, msg: string): State {
  const fresh = !s.done[id];
  const done = fresh ? { ...s.done, [id]: true } : s.done;
  const n = STEPS.filter((st) => done[st.id]).length;
  let m = msg;
  let complete = s.complete;
  if (fresh && n === STEPS.length && !complete) {
    complete = true;
    m = msg + MSG.all;
  }
  return { ...s, ...patch, done, msg: m, complete };
}

function takeOut(s: State): State {
  if (s.keyOut) return s;
  return mark(s, "out", { keyOut: true, view: "browser", signin: false, hint: false, moveN: s.moveN + 1, outN: s.outN + 1 }, MSG.out);
}

function putBack(s: State): State {
  if (!s.keyOut) return s;
  return { ...s, keyOut: false, view: "browser", signin: false, hint: false, moveN: s.moveN + 1, snapN: s.snapN + 1, msg: MSG.back };
}

type PanelMode = "server" | "browser" | "missing";
const panelMode = (s: State): PanelMode => (s.view === "server" ? "server" : s.keyOut ? "missing" : "browser");

export function reducer(s: State, a: Action): State {
  const n = step(s, a);
  return n !== s && panelMode(n) !== panelMode(s) ? { ...n, swapN: s.swapN + 1 } : n;
}

function step(s: State, a: Action): State {
  switch (a.type) {
    case "TICK": {
      /* Gentle attract loop: only swaps the right-hand view and nudges the key. Never ticks the checklist. */
      if (!s.attract || s.drag) return s;
      const c = s.aClock + a.dt;
      if (c < BEAT) return { ...s, aClock: c };
      const i = (s.aIdx + 1) % DEMO.length;
      const d = DEMO[i];
      return { ...s, aClock: 0, aIdx: i, view: d.view, hint: d.hint && !s.keyOut };
    }
    case "REDUCED_MOTION":
      return s.attract || !s.paused ? { ...s, attract: false, paused: true, hint: false, aClock: 0 } : s;
    case "TOGGLE_DEMO": {
      const on = !s.attract;
      return { ...s, attract: on, paused: !on, hint: false, aClock: 0 };
    }
    case "INTERACT":
      return interact(s);
    case "NOTE":
      return { ...interact(s), note: a.value.slice(0, NOTE_MAX) };
    case "SHOW_SERVER":
      return mark(interact(s), "view", { view: "server", signin: false, hint: false }, MSG.server);
    case "SHOW_BROWSER": {
      const n = interact(s);
      return { ...n, view: "browser", signin: false, hint: false, msg: n.keyOut ? MSG.idleOut : MSG.browser };
    }
    case "TOGGLE_KEY": {
      const n = interact(s);
      return n.keyOut ? putBack(n) : takeOut(n);
    }
    case "KEY_OUT":
      return takeOut(interact(s));
    case "KEY_IN":
      return putBack(interact(s));
    case "ROTATE": {
      const n = interact(s);
      if (n.keyOut) return { ...n, msg: MSG.rotateOut, hint: false };
      return mark(n, "rot", { keyIdx: n.keyIdx + 1, oldKey: n.keyIdx, signin: false, hint: false }, MSG.rotate);
    }
    case "TOGGLE_SIGNIN": {
      const n = interact(s);
      if (n.signin) return { ...n, signin: false, msg: "" };
      return mark(n, "sign", { signin: true, hint: false }, MSG.sign);
    }
    case "CLOSE_SIGNIN":
      return s.signin ? { ...s, signin: false } : s;
    case "DRAG_MOVE":
      return { ...interact(s), drag: { dx: a.dx, dy: a.dy }, hint: false };
    case "DRAG_END": {
      const out = s.keyOut;
      const n: State = { ...s, drag: null };
      if (!out && a.dy > DROP_AT) return takeOut(n);
      if (out && a.dy < -DROP_AT) return putBack(n);
      return { ...n, msg: out ? MSG.dragOut : MSG.dragIn, moveN: s.moveN + 1 };
    }
    case "DRAG_CANCEL":
      return s.drag ? { ...s, drag: null } : s;
    default:
      return s;
  }
}

/* ── View model (renderVals without the closures; handlers are attached by Game) ── */

const par = (n: number, a: string, b: string) => (n > 0 ? (n % 2 ? a : b) : "");

export interface Vm {
  keyIn: boolean;
  keyOut: boolean;
  drag: State["drag"];
  tilt: number;
  /** Chip text split so narrow layouts can drop the middle of the key. */
  chipHead: string;
  chipMid: string;
  chipAria: string;
  /** Parity classes ("" | "A" | "B") that replay one-shot animations without a remount. */
  squash: "" | "A" | "B";
  roll: "" | "A" | "B";
  ripple: "" | "A" | "B";
  trayFlash: "" | "A" | "B";
  strike: "" | "A" | "B";
  ctFlash: "" | "A" | "B";
  wiggle: boolean;
  hintOn: boolean;
  trayHot: boolean;
  slotHot: boolean;
  trayText: string;
  old: string | null;
  keyBtnLabel: string;
  status: string;
  isServer: boolean;
  browserOk: boolean;
  browserMissing: boolean;
  signin: boolean;
  scroll: string[];
  still: string[];
  scrollSecs: number;
  title: string;
  blocks: DocBlock[];
  titleSealed: string;
  serverFoot: string;
  fragShort: string;
  steps: Array<{ id: StepId; n: string; t: string; done: boolean }>;
  doneN: number;
  complete: boolean;
  demoOn: boolean;
  paused: boolean;
  swapped: boolean;
}

export function deriveView(s: State): Vm {
  const key = keyFor(s.keyIdx);
  const keyOut = s.keyOut;
  const dr = s.drag;
  const lines = sealed(s.note, s.keyIdx);
  let pool = lines.slice();
  while (pool.length < 12) pool = pool.concat(lines);
  const doc = parseNote(s.note);
  const toAB = (v: string) => (v === "" ? "" : (v as "A" | "B"));
  return {
    keyIn: !keyOut,
    keyOut,
    drag: dr,
    tilt: dr ? Math.max(-6, Math.min(6, dr.dx / 24)) : 0,
    chipHead: "#k=" + key.slice(0, 3),
    chipMid: key.slice(3, 6),
    chipAria: keyOut
      ? "Key, out of the link. Press to put it back in, or press Up arrow."
      : "Key in the link: #k= and the start of the key. Press to take it out, or press Down arrow.",
    squash: s.hint && !keyOut && !dr ? "" : toAB(par(s.moveN, "A", "B")),
    roll: toAB(par(s.keyIdx, "A", "B")),
    ripple: toAB(par(s.snapN, "A", "B")),
    trayFlash: keyOut ? toAB(par(s.outN, "A", "B")) : "",
    strike: toAB(par(s.keyIdx, "A", "B")),
    ctFlash: toAB(par(s.keyIdx, "A", "B")),
    wiggle: s.hint && !keyOut && !dr,
    hintOn: s.hint && !keyOut && !dr,
    trayHot: !!dr && !keyOut && dr.dy > DROP_AT,
    slotHot: !!dr && keyOut && dr.dy < -DROP_AT,
    trayText: keyOut ? "Out of the link. Drag it back up, or press Put the key back." : "Drag the key down here to take it out of the link.",
    old: s.oldKey >= 0 ? HOST + PATH + "#k=" + keyFor(s.oldKey).slice(0, 6) + "…" : null,
    keyBtnLabel: keyOut ? "Put the key back" : "Take the key out",
    status: s.msg || (keyOut ? MSG.idleOut : MSG.idle),
    isServer: s.view === "server",
    browserOk: s.view !== "server" && !keyOut,
    browserMissing: s.view !== "server" && keyOut,
    signin: s.signin,
    scroll: pool.concat(pool),
    still: pool.slice(0, 16),
    scrollSecs: Math.round(pool.length * 2.2),
    title: doc.title,
    blocks: doc.blocks,
    titleSealed: chars(fnv(doc.title, 3266489917 + s.keyIdx * 131), 28, STD) + "…",
    serverFoot: keyOut
      ? "Same as before: the server never had the key. Markdrop stores ciphertext it has no key for."
      : "Key: none. Markdrop stores ciphertext it has no key for.",
    fragShort: "#k=" + key.slice(0, 10) + "…",
    steps: STEPS.map((st) => ({ id: st.id, n: st.n, t: st.t, done: s.done[st.id] })),
    doneN: STEPS.filter((st) => s.done[st.id]).length,
    complete: s.complete,
    demoOn: s.attract,
    paused: s.paused,
    swapped: s.swapN > 0,
  };
}
