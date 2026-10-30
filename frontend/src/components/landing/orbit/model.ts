/**
 * Orbit hero state machine: pure state + reducer, ported 1:1 from the boards' DCLogic.
 *
 * Board method                     → action (desktop board PlayFinal / mobile board PlayFinalMobile)
 *   tick, runBeat / beatPatch      → TICK (clock, attract beats, finale timer, optional idle return)
 *   pickMoon                       → PICK_MOON(id, from?)
 *   pickFile                       → PICK_FILE(id, how)
 *   station.pick                   → PICK_STATION
 *   pips / stamps                  → PICK_PIP(id)
 *   padClick / courierTap          → PAD
 *   aimOver / aimClear             → AIM(target | null)
 *   padAimOn / padAimOff / padFocus→ PAD_AIM(on)
 *   padMove / padUp / padCancel    → DRAG_MOVE(p) / DRAG_END / DRAG_MISS (the drop target is resolved by
 *                                    the Game with elementFromPoint, then sent as PICK_* with `from`)
 *   togglePlay                     → TOGGLE_PAUSE
 *   toggleRelay                    → TOGGLE_RELAY (only reachable while P2P_RELAY_LIVE)
 *   resetGame                      → RESET
 *   encryptInstead                 → PICK_MOON('encrypt')
 *   focusMoon                      → FOCUS_MOON(id)
 *   moonKey                        → KEY_MOON(i, dir)   (the Game moves DOM focus with keyMoonTarget)
 *   tileKey / stageFocus / Blur    → HOLD(on)
 *   mobile stepMoon / stepFile     → STEP_MOON(dir) / STEP_FILE(dir)  (swipes and the spin buttons)
 *   mobile closeSheet / openSheet  → SHEET(open)
 *   (new) hero scrolled away       → LEAVE_PLAY
 *
 * The boards keep their clocks (`real`, `clock`, `beatAt`, `lastInput`, `finAt`, `hold`) on the instance;
 * here they live in `state.t`, so the reducer is deterministic. The Game skips re-rendering the view
 * when only `t` changed (see `sameView`). Fields the boards mutate inside renderVals (`lastNext`,
 * `carryN`) are updated here whenever the next feature changes, so the view derivation is pure.
 *
 * Every one-shot animation keys off a counter (cardN, fileN, launchN, dioN, screenN, consN, carryN,
 * heroN). A counter of 0 renders the END state with no animation class: that is the server poster, and
 * the Game mounts with the identical state, so the swap is invisible.
 */
import {
  ACH, BEATS, COPY, FILES, MOONS, TICK, TOTAL,
  geo, mod,
  type AchId, type FeatId, type FileId, type Form, type MoonId, type ScreenId, type ViewId,
} from "./data";
import { IDLE_RETURN } from "./flags";
import { P2P_RELAY_LIVE } from "@/lib/marketingFlags";

export interface Pt { x: number; y: number }
export type Aim = { k: "moon"; id: MoonId } | { k: "file"; id: FileId } | { k: "station" };
/** 'rack' (a tile, the screen, a drop or swipe on them) can meet an armed Encrypt; the rest never do. */
export type How = "rack" | "pad" | "pip" | "courier" | "stamp";

export interface Timers { real: number; clock: number; beatAt: number; lastInput: number; finAt: number; hold: boolean }

export interface State {
  form: Form;
  mode: "attract" | "play";
  beat: number;
  rot: number;
  view: ViewId;
  file: FileId;
  found: Partial<Record<FeatId, true>>;
  seen: Partial<Record<FileId, true>>;
  ach: Partial<Record<AchId, true>>;
  relay: boolean;
  combo: boolean;
  paused: boolean;
  finale: boolean;
  finaleDone: boolean;
  announce: string;
  /** True after the first input that plays the game (not Pause, not keyboard browsing). */
  interacted: boolean;
  launch: boolean;
  flyTo: "front" | "station";
  /* one-shot replay counters */
  cardN: number; fileN: number; launchN: number; consN: number; carryN: number;
  lastNext: FeatId | null;
  /* desktop */
  dock: FeatId | null;
  dioN: number;
  fileDelay: number;
  from: Pt | null;
  aim: boolean;
  aimAt: Aim | null;
  drag: Pt | null;
  /* mobile */
  layout: "hero" | "play";
  sheet: boolean;
  screen: ScreenId;
  screenN: number;
  heroN: number;
  pd: number;
  fd: number;
  fileFly: boolean;
  t: Timers;
}

export type Action =
  | { type: "TICK" }
  | { type: "PICK_MOON"; id: MoonId; from?: Pt | null }
  | { type: "PICK_FILE"; id: FileId; how: How }
  | { type: "PICK_STATION" }
  | { type: "PICK_PIP"; id: FeatId }
  | { type: "PAD" }
  | { type: "AIM"; at: Aim | null }
  | { type: "PAD_AIM"; on: boolean }
  | { type: "DRAG_MOVE"; p: Pt }
  | { type: "DRAG_END" }
  | { type: "DRAG_MISS" }
  | { type: "TOGGLE_PAUSE" }
  | { type: "SET_PAUSED"; paused: boolean }
  | { type: "TOGGLE_RELAY" }
  | { type: "RESET" }
  | { type: "FOCUS_MOON"; id: MoonId }
  | { type: "KEY_MOON"; i: number; dir: 1 | -1 }
  | { type: "HOLD"; on: boolean }
  | { type: "STEP_MOON"; dir: 1 | -1 }
  | { type: "STEP_FILE"; dir: 1 | -1 }
  | { type: "SHEET"; open: boolean }
  | { type: "LEAVE_PLAY" };

/* ── Helpers (pure) ───────────────────────────────────────────────────── */

export const countOf = (s: Pick<State, "form" | "found">, found = s.found) =>
  COPY[s.form].feats.filter((f) => found[f.id]).length;
export const nextFeat = (s: Pick<State, "form" | "found">) =>
  COPY[s.form].feats.find((f) => !s.found[f.id]) ?? null;
/** Encrypt is "on" exactly while its card is showing; the disc band and the rack say so. */
export const armed = (s: Pick<State, "view" | "finale">) => s.view === "encrypt" && !s.finale;
export const fileOf = (id: FileId) => FILES.find((f) => f.id === id) ?? FILES[0];

/** Never the file already on screen, so a click on the screen always changes what it shows. */
export function nextFile(s: Pick<State, "seen" | "file">): FileId {
  const un = FILES.find((f) => !s.seen[f.id] && f.id !== s.file);
  if (un) return un.id;
  const i = FILES.findIndex((f) => f.id === s.file);
  return FILES[mod(i + 1, FILES.length)].id;
}

/** Shortest way round: the chosen moon swings to the front along the near side of the ellipse. */
export function rotTo(s: Pick<State, "form" | "rot">, id: MoonId): { rot?: number } {
  const NS = geo(s.form).NS;
  const k = MOONS.findIndex((m) => m.id === id);
  if (k < 0) return {};
  const rel = mod(k - s.rot, NS);
  if (!rel) return {};
  return { rot: s.rot + (rel <= 3 ? rel : rel - NS) };
}

/** Index of the moon sitting on seat (front + d), skipping the empty seat (mobile spin). */
export function moonAt(s: Pick<State, "form" | "rot">, d: number) {
  const { NS, GAP } = geo(s.form);
  let j = mod(mod(s.rot, NS) + d, NS);
  if (j === GAP) j = mod(j + (d < 0 ? -1 : 1), NS);
  return j;
}

/** Arrow keys on a focused moon: the neighbouring moon (by orbit order), skipping the empty seat. */
export function keyMoonTarget(form: Form, i: number, dir: 1 | -1) {
  const { NS, GAP } = geo(form);
  let j = mod(i + dir, NS);
  if (j === GAP) j = mod(j + dir, NS);
  return j;
}

/** The constellation replays once per action that moves the moons or finds one. */
function withCons(s: State, n: Partial<State>): Partial<State> {
  const moved = n.rot !== undefined && n.rot !== s.rot;
  const grew = !!n.found && countOf(s, n.found) !== countOf(s);
  if (moved || grew) n.consN = s.consN + 1;
  return n;
}

const touch = (t: Timers): Timers => ({ ...t, lastInput: t.clock });

/* ── Initial state ────────────────────────────────────────────────────── */

/**
 * The attract boot frame at its END state: the planet with the HTML page on the screen, Publish in
 * front, the intro card, 0 of 8. Identical on the server (poster) and in the Game's first render.
 */
export function initialState(form: Form, opts: { paused?: boolean } = {}): State {
  return {
    form,
    mode: "attract", beat: 0, rot: 0, view: "intro", file: "html",
    found: {}, seen: {}, ach: {}, relay: false, combo: false,
    paused: !!opts.paused, finale: false, finaleDone: false, announce: "", interacted: false,
    launch: false, flyTo: "front",
    cardN: 0, fileN: 0, launchN: 0, consN: 0, carryN: 0, lastNext: "publish",
    dock: "publish", dioN: 0, fileDelay: 0.1, from: null, aim: false, aimAt: null, drag: null,
    layout: "hero", sheet: false, screen: "html", screenN: 0, heroN: 0, pd: 0.82, fd: 0.2, fileFly: false,
    t: { real: 0, clock: 0, beatAt: 0, lastInput: 0, finAt: 0, hold: false },
  };
}

/* ── Transitions ──────────────────────────────────────────────────────── */

function runBeat(s: State, b: number): State {
  const B = BEATS[b];
  if (s.form === "mobile") {
    const n: Partial<State> = { beat: b, mode: "attract", combo: false, finale: false, cardN: s.cardN + 1, launch: false, fileFly: false };
    if (B.moon) Object.assign(n, rotTo(s, B.moon), { view: B.intro ? "intro" : B.moon, launchN: s.launchN + 1, launch: true, flyTo: "front" });
    if (B.moon && !B.file) Object.assign(n, { screen: B.moon, screenN: s.screenN + 1, pd: 0.85 });
    if (B.file) Object.assign(n, { file: B.file, screen: B.file, screenN: s.screenN + 1, fileN: s.fileN + 1, fileFly: true, fd: 0.2, pd: 0.82 });
    if (B.file && !B.moon) n.view = "render";
    if (B.moon === "send") n.relay = false;
    return { ...s, ...withCons(s, n) };
  }
  const n: Partial<State> = { beat: b, mode: "attract", combo: false, finale: false, aim: false, aimAt: null, cardN: s.cardN + 1 };
  if (B.moon) Object.assign(n, rotTo(s, B.moon), { dock: B.moon, dioN: s.dioN + 1, view: B.intro ? "intro" : B.moon, launchN: s.launchN + 1, launch: true, from: null, flyTo: "front" });
  if (B.file) Object.assign(n, { file: B.file, fileN: s.fileN + 1, fileDelay: B.moon ? 1.0 : 0.1 });
  if (B.file && !B.moon) Object.assign(n, { dock: "render", dioN: s.dioN + 1, view: "render" });
  if (B.moon === "send") n.relay = false;
  return { ...s, ...withCons(s, n) };
}

function finale(s: State, t: Timers): State {
  if (s.form === "mobile") {
    return {
      ...s, t, finale: true, finaleDone: true, view: "finale", mode: "play", layout: "play", sheet: true, combo: false,
      cardN: s.cardN + 1, consN: s.consN + 1, launch: false, fileFly: false,
      announce: "All " + TOTAL + " discovered. The moons frame the Markdrop mark. Start writing at markdrop.in/new, no account needed.",
    };
  }
  return {
    ...s, t, finale: true, finaleDone: true, view: "finale", dock: null, mode: "play", combo: false, aim: false,
    cardN: s.cardN + 1, fileN: s.fileN + 1, fileDelay: 2.0, consN: s.consN + 1,
    announce: "All " + TOTAL + " discovered. The moons form the Markdrop mark. Start writing at markdrop.in/new, no account needed.",
  };
}

function tick(s: State): State {
  const t: Timers = { ...s.t, real: s.t.real + TICK };
  if (s.t.finAt && t.real >= s.t.finAt) {
    t.finAt = 0;
    t.lastInput = t.clock;
    return finale(s, t);
  }
  /* Pause, a drag in progress and keyboard focus inside the stage freeze the attract/idle clock;
     whatever the visitor does still plays. */
  if (s.paused || s.drag || s.t.hold) return { ...s, t };
  t.clock += TICK;
  const G = geo(s.form);
  if (s.mode === "attract") {
    if (t.clock - t.beatAt >= G.BEAT_MS) {
      t.beatAt = t.clock;
      return runBeat({ ...s, t }, mod(s.beat + 1, BEATS.length));
    }
  } else if (IDLE_RETURN && !s.finale && t.clock - t.lastInput >= G.IDLE_MS) {
    t.beatAt = t.clock;
    const n = runBeat({ ...s, t }, mod(s.beat + 1, BEATS.length));
    return s.form === "mobile" ? { ...n, layout: "hero", sheet: false, heroN: s.heroN + 1 } : n;
  }
  return { ...s, t };
}

function pickMoon(s: State, id: MoonId, from?: Pt | null): State {
  const t = touch(s.t);
  const C = COPY[s.form];
  const was = !!s.found[id];
  const found = { ...s.found, [id]: true as const };
  const n = countOf(s, found);
  if (n === TOTAL && !s.finaleDone) t.finAt = t.real + geo(s.form).FIN_MS;
  const lab = C.feats.find((f) => f.id === id)!.label;
  let msg = was ? lab + "." : lab + " discovered. " + n + " of " + TOTAL + ".";
  if (id === "encrypt") msg += C.encryptOn;
  const common: Partial<State> = {
    ...rotTo(s, id), mode: "play", view: id, cardN: s.cardN + 1, launchN: s.launchN + 1, launch: true, flyTo: "front",
    found, combo: false, finale: false, relay: id === "send" ? false : s.relay, announce: msg, interacted: true,
  };
  if (s.form === "mobile") {
    Object.assign(common, { layout: "play", sheet: true, screen: id, screenN: s.screenN + 1, pd: 0.85, fileFly: false });
  } else {
    Object.assign(common, { dock: id, dioN: s.dioN + 1, from: from ?? null, aimAt: null });
  }
  return { ...s, t, ...withCons(s, common) };
}

function pickFile(s: State, fid: FileId, how: How): State {
  const t = touch(s.t);
  const f = fileOf(fid);
  const was = !!s.found.render;
  const found = { ...s.found, render: true as const };
  const seen = { ...s.seen, [f.id]: true as const };
  const combo = how === "rack" && armed(s);
  const ach = { ...s.ach };
  let extra = "";
  if (combo && !ach.encFile) { ach.encFile = true; extra += " Achievement: read the fine print."; }
  if (FILES.every((x) => seen[x.id]) && !ach.files) { ach.files = true; extra += " Achievement: all five file types rendered."; }
  const n = countOf(s, found);
  if (n === TOTAL && !s.finaleDone) t.finAt = t.real + geo(s.form).FIN_MS;
  const announce = (combo ? "Honest answer: encryption is for documents. Files get a password or access level instead. " : "")
    + f.name + " opens at markdrop.in/" + f.slug + "." + (was ? "" : " Render any file discovered. " + n + " of " + TOTAL + ".") + extra;
  const common: Partial<State> = {
    mode: "play", file: f.id, fileN: s.fileN + 1, view: "render", cardN: s.cardN + 1,
    found, seen, combo, ach, finale: false, announce, interacted: true,
  };
  if (s.form === "mobile") {
    const fly = how === "courier" ? { launchN: s.launchN + 1, launch: true, flyTo: "station" as const } : { launch: false };
    Object.assign(common, fly, { layout: "play", sheet: true, screen: f.id, screenN: s.screenN + 1, fileFly: true, fd: 0.1, pd: 0.72 });
  } else {
    const fly = how === "pad" ? { launchN: s.launchN + 1, launch: true, from: null, flyTo: "station" as const } : {};
    Object.assign(common, fly, { fileDelay: 0.1, dock: "render", dioN: s.dioN + 1, aimAt: null });
  }
  return { ...s, t, ...withCons(s, common) };
}

/** padClick (desktop) and courierTap (mobile): fly to the next feature, or replay the finale. */
function pad(s: State): State {
  const next = nextFeat(s);
  if (!next) {
    const t = touch(s.t);
    t.finAt = t.real + 150;
    if (s.form === "mobile") return { ...s, t, finale: false, view: "finale", mode: "play", layout: "play", sheet: true, interacted: true };
    return { ...s, t, finale: false, dock: null, view: "finale", mode: "play", aim: false, interacted: true };
  }
  if (next.id === "render") return pickFile(s, nextFile(s), s.form === "mobile" ? "courier" : "pad");
  return pickMoon(s, next.id as MoonId);
}

function resetGame(s: State): State {
  const t = { ...touch(s.t), finAt: 0 };
  const base: Partial<State> = {
    ...rotTo(s, "publish"),
    found: {}, seen: {}, ach: {}, finale: false, finaleDone: false, relay: false, combo: false,
    mode: "play", view: "intro", launchN: s.launchN + 1, launch: true, flyTo: "front",
    cardN: s.cardN + 1, consN: s.consN + 1, announce: "New game. 0 of " + TOTAL + " discovered.", interacted: true,
  };
  if (s.form === "mobile") {
    Object.assign(base, { layout: "play", sheet: true, screen: "html", file: "html", screenN: s.screenN + 1, pd: 0.85, fileFly: false });
  } else {
    Object.assign(base, { aim: false, dock: "publish", dioN: s.dioN + 1, from: null, aimAt: null });
  }
  return { ...s, t, ...withCons(s, base) };
}

function step(s: State, a: Action): State {
  switch (a.type) {
    case "TICK": return tick(s);
    case "PICK_MOON": return pickMoon(s, a.id, a.from);
    case "PICK_FILE": return pickFile(s, a.id, a.how);
    case "PICK_STATION": return pickFile(s, nextFile(s), "rack");
    case "PICK_PIP":
      return a.id === "render" ? pickFile(s, nextFile(s), s.form === "mobile" ? "stamp" : "pip") : pickMoon(s, a.id);
    case "PAD": return pad(s);
    case "AIM":
      if (a.at && s.drag) return s;
      if (!a.at && !s.aimAt) return s;
      return { ...s, aimAt: a.at };
    case "PAD_AIM": return s.aim === a.on ? s : { ...s, aim: a.on };
    case "DRAG_MOVE": return { ...s, drag: a.p, aim: false };
    case "DRAG_END": return s.drag ? { ...s, drag: null } : s;
    case "DRAG_MISS": return { ...s, drag: null, announce: "Drop it on a moon, a file or the screen." };
    case "TOGGLE_PAUSE": {
      const p = !s.paused;
      const t = p ? s.t : { ...s.t, lastInput: s.t.clock, beatAt: s.t.clock };
      return { ...s, t, paused: p, announce: p ? "Paused." : "Playing." };
    }
    case "SET_PAUSED": return s.paused === a.paused ? s : { ...s, paused: a.paused };
    case "TOGGLE_RELAY": {
      if (!P2P_RELAY_LIVE) return s;
      const on = !s.relay;
      const ach = { ...s.ach };
      let extra = "";
      if (on && !ach.relay) { ach.relay = true; extra = " Achievement: found the relay."; }
      return {
        ...s, t: touch(s.t), relay: on, ach, mode: "play", interacted: true,
        announce: (on ? "Relay path. When a network blocks a direct path, an encrypted relay forwards bytes it cannot read." : "Direct path, device to device.") + extra,
      };
    }
    case "RESET": return resetGame(s);
    case "FOCUS_MOON": {
      const t = { ...s.t, hold: true };
      if (s.finale) return { ...s, t };
      const r = rotTo(s, a.id);
      if (r.rot === undefined) return { ...s, t };
      return { ...s, t: touch(t), ...withCons(s, r) };
    }
    case "KEY_MOON": {
      const m = MOONS[keyMoonTarget(s.form, a.i, a.dir)];
      const t = touch({ ...s.t, hold: true });
      if (s.finale) return { ...s, t };
      return { ...s, t, ...withCons(s, { announce: m.label + " is in front. Press Enter to open it.", ...rotTo(s, m.id) }) };
    }
    case "HOLD":
      if (a.on) return s.t.hold ? s : { ...s, t: { ...s.t, hold: true } };
      return s.t.hold ? { ...s, t: { ...s.t, hold: false, beatAt: s.t.clock } } : s;
    case "STEP_MOON": return pickMoon(s, MOONS[moonAt(s, a.dir)].id);
    case "STEP_FILE": {
      const i = FILES.findIndex((f) => f.id === s.file);
      return pickFile(s, FILES[mod(i + a.dir, FILES.length)].id, "rack");
    }
    case "SHEET":
      return a.open
        ? { ...s, t: touch(s.t), sheet: true, cardN: s.cardN + 1 }
        : { ...s, t: touch(s.t), sheet: false, announce: "Details closed." };
    case "LEAVE_PLAY":
      return s.layout === "play" ? { ...s, layout: "hero", sheet: false, heroN: s.heroN + 1 } : s;
  }
}

export function reducer(s: State, a: Action): State {
  const n = step(s, a);
  if (n === s) return n;
  /* The courier's tag: what the drop carries next. It pops in again whenever the next feature changes. */
  const nx = nextFeat(n)?.id ?? null;
  if (nx !== n.lastNext) return { ...n, lastNext: nx, carryN: n.carryN + 1 };
  return n;
}

/** True when two states draw the same picture (they differ at most in the clocks). */
export function sameView(a: State, b: State): boolean {
  if (a === b) return true;
  for (const k of Object.keys(a) as Array<keyof State>) {
    if (k === "t") continue;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

export { ACH };
