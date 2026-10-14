/**
 * Builder Blocks: pure data, state and reducer (no React, no DOM).
 * Ported from design/revamp-canvas/PlayBuilderBlocks.dc.html (`class Component` at ~447).
 *
 * Board method -> reducer action
 *   tick()                     -> TICK (100ms, dispatched by Game only while in view, visible, not held)
 *   runStep() / doStep()       -> inside TICK (STEPS, STEP_MS, the 700ms pending beat)
 *   interact()                 -> folded into every user action (ends the demo for good)
 *   commit()                   -> commit() helper below (snap motion, flash, checklist cheer)
 *   toggle(id)                 -> TOGGLE
 *   add() / remove()           -> add() / remove() helpers (TOGGLE, REMOVE, demo steps)
 *   move(id, dir, user, kind)  -> MOVE
 *   gripKey()                  -> MOVE with kind "grip" (Game maps ArrowUp / ArrowDown)
 *   gripDown()                 -> INTERACT (pointer bookkeeping lives in a Game ref)
 *   gripMove()                 -> DRAG_MOVE
 *   gripUp()                   -> DRAG_END
 *   gripCancel()               -> DRAG_CANCEL
 *   setView(v)                 -> SET_VIEW
 *   onSlug(e)                  -> SLUG
 *   publish(user) / onPublish  -> PUBLISH (demo step calls publish(false))
 *   onDownload()               -> DOWNLOAD
 *   reset(user) / startOver()  -> START_OVER (demo step calls reset(false))
 *   togglePause()              -> TOGGLE_PAUSE
 *   componentDidMount reduce   -> REDUCED_MOTION (deviation: the demo is switched off, never just paused)
 *   pendingFocus/pendingScroll -> state.fx, applied by Game in an effect
 *   toggleTheme                -> dropped (toys follow the site theme)
 */

export type BlockId = "title" | "badges" | "install" | "usage" | "mermaid" | "math" | "table" | "license";
export type PreviewMode = "rendered" | "source";
export type Glyph = "" | "flow" | "sum";

export interface Block {
  id: BlockId;
  label: string;
  sub: string;
  icon: string;
  glyph: Glyph;
  tag: string;
}

/** The eight section templates (the real builder has more). */
export const BLOCKS: readonly Block[] = [
  { id: "title", label: "Title", sub: "Name and a one-line pitch", icon: "heading", glyph: "", tag: "" },
  { id: "badges", label: "Badges", sub: "Build, license, version", icon: "checkCircle", glyph: "", tag: "" },
  { id: "install", label: "Install", sub: "One command to get it", icon: "download", glyph: "", tag: "" },
  { id: "usage", label: "Usage", sub: "How to run it", icon: "code", glyph: "", tag: "" },
  { id: "mermaid", label: "Mermaid diagram", sub: "A flowchart written as text", icon: "", glyph: "flow", tag: "Mermaid" },
  { id: "math", label: "Math", sub: "A formula in LaTeX", icon: "", glyph: "sum", tag: "KaTeX" },
  { id: "table", label: "Table", sub: "Options at a glance", icon: "table", glyph: "", tag: "" },
  { id: "license", label: "License", sub: "Who can use it", icon: "doc", glyph: "", tag: "" },
];

export const BY = Object.fromEntries(BLOCKS.map((b) => [b.id, b])) as Record<BlockId, Block>;
export const IDLE: readonly BlockId[] = ["title", "badges", "install", "mermaid"];
/** Row height (52) + gap (6). Rows keep this pitch at every width, so drag maths never changes. */
export const PITCH = 58;
export const DEFAULT_SLUG = "my-project";
export const TOTAL = BLOCKS.length;
/** id of the View root (the Game observes it; no wrapper, so the first render matches the server frame). */
export const ROOT_ID = "bb-toy";

/** The Markdown each block writes: [text, token]. Tokens: h heading, f fence, c code, m math, d diagram, l link, t table. */
export const SRC: Record<BlockId, ReadonlyArray<readonly [string, string]>> = {
  title: [["# my-project", "h"], ["", ""], ["Turn a folder of notes into a site you can share.", ""]],
  badges: [
    ["![build](https://img.shields.io/badge/build-passing-green)", "l"],
    ["![license](https://img.shields.io/badge/license-MIT-blue)", "l"],
    ["![version](https://img.shields.io/badge/version-1.2.0-gray)", "l"],
  ],
  install: [["## Install", "h"], ["", ""], ["```bash", "f"], ["npm install my-project", "c"], ["```", "f"]],
  usage: [
    ["## Usage", "h"], ["", ""], ["Build the docs folder into a site:", ""], ["", ""],
    ["```bash", "f"], ["npx my-project build ./docs --out ./site", "c"], ["```", "f"],
  ],
  mermaid: [
    ["## How it works", "h"], ["", ""], ["```mermaid", "f"], ["flowchart LR", "d"],
    ["  A[Notes] --> B[Build] --> C([Site])", "d"], ["  C -. watch .-> A", "d"], ["```", "f"],
  ],
  math: [
    ["## Ranking", "h"], ["", ""], ["Search results are ordered by a weighted score:", ""], ["", ""],
    ["$$", "m"], ["\\text{score} = \\frac{\\sum_i w_i x_i}{\\sum_i w_i}", "m"], ["$$", "m"],
  ],
  table: [
    ["## Options", "h"], ["", ""], ["| Flag | Default | What it does |", "t"], ["| --- | --- | --- |", "t"],
    ["| `--out` | ./site | Where the site goes |", "t"], ["| `--watch` | off | Rebuild when files change |", "t"],
    ["| `--base` | / | Path prefix for links |", "t"],
  ],
  license: [["## License", "h"], ["", ""], ["MIT. See LICENSE for details.", ""]],
};

/** The gentle demo: runs until the first interaction. */
export interface Step {
  add?: BlockId;
  move?: BlockId;
  dir?: -1 | 1;
  view?: PreviewMode;
  publish?: true;
  reset?: true;
  say: string;
}
export const STEPS: readonly Step[] = [
  { add: "usage", say: "Adding a Usage block" },
  { add: "math", say: "Adding a Math block" },
  { move: "usage", dir: -1, say: "Moving Usage up" },
  { view: "source", say: "Showing the Markdown source" },
  { view: "rendered", say: "Back to the rendered page" },
  { add: "license", say: "Adding License at the end" },
  { publish: true, say: "Publishing it" },
  { reset: true, say: "Starting over" },
];
export const STEP_MS = 2300;
export const TICK_MS = 100;
/** Delay between a step being announced (ring + caption) and it happening. */
export const BEAT_MS = 700;
export const FIRST_STEP_AT = 2200;

export const SAY_WATCHING = "Watching a demo. Pick anything to take over.";
export const MOCK_NOTE = "Preview only. The real builder saves the file.";
const DONE_LINE = " Checklist complete: title on top, install and usage, license at the end. Ready to publish.";

export function complete(st: readonly BlockId[]): boolean {
  return st.length > 0 && st[0] === "title" && st.includes("install") && st.includes("usage") && st[st.length - 1] === "license";
}

/** The board's live slug rule: keeps a trailing hyphen while typing, trimmed at publish. */
export function cleanSlug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").replace(/-{2,}/g, "-").slice(0, 40);
}

/* ── State ─────────────────────────────────────────────────────────────── */

export interface Drag { id: BlockId; from: number; to: number; dy: number }
/** Side effects the Game applies after render: focus a control by id, scroll the preview. */
export interface Fx { n: number; focus: string | null; scroll: BlockId | null; top: boolean }

export interface State {
  stack: BlockId[];
  view: PreviewMode;
  slug: string;
  pub: { slug: string; sig: string } | null;
  msg: string;
  mockNote: string;
  anim: { n: number; from: Partial<Record<BlockId, number>>; inId: BlockId | null };
  flash: { id: BlockId | null; n: number };
  drag: Drag | null;
  attract: boolean;
  paused: boolean;
  demoSay: string;
  demoFocus: BlockId | null;
  done: boolean;
  cheer: number;
  ripple: number;
  live: string;
  liveN: number;
  /* demo clock (board: this.clock, nextAt, step, pendingStep, pendingAt) */
  clock: number;
  nextAt: number;
  step: number;
  pending: number | null;
  pendingAt: number;
  fx: Fx;
}

export const initialState: State = {
  stack: [...IDLE],
  view: "rendered",
  slug: DEFAULT_SLUG,
  pub: null,
  msg: "",
  mockNote: MOCK_NOTE,
  anim: { n: 0, from: {}, inId: null },
  flash: { id: null, n: 0 },
  drag: null,
  attract: true,
  paused: false,
  demoSay: SAY_WATCHING,
  demoFocus: null,
  done: false,
  cheer: 0,
  ripple: 0,
  live: "",
  liveN: 0,
  clock: 0,
  nextAt: FIRST_STEP_AT,
  step: 0,
  pending: null,
  pendingAt: 0,
  fx: { n: 0, focus: null, scroll: null, top: false },
};

export type Action =
  | { type: "TICK" }
  | { type: "INTERACT" }
  | { type: "REDUCED_MOTION" }
  | { type: "TOGGLE"; id: BlockId }
  | { type: "REMOVE"; id: BlockId }
  | { type: "MOVE"; id: BlockId; dir: -1 | 1; kind: "up" | "dn" | "grip" }
  | { type: "DRAG_MOVE"; drag: Drag }
  | { type: "DRAG_END"; active: boolean }
  | { type: "DRAG_CANCEL" }
  | { type: "SET_VIEW"; view: PreviewMode }
  | { type: "SLUG"; raw: string }
  | { type: "PUBLISH" }
  | { type: "DOWNLOAD" }
  | { type: "START_OVER" }
  | { type: "TOGGLE_PAUSE" };

/* ── Helpers (each returns a new state) ────────────────────────────────── */

function say(s: State, text: string): State {
  return text ? { ...s, live: text, liveN: s.liveN + 1 } : s;
}

function fx(s: State, patch: Partial<Omit<Fx, "n">>): State {
  return { ...s, fx: { n: s.fx.n + 1, focus: null, scroll: null, top: false, ...patch } };
}

/** First real interaction ends the demo for good. */
function interact(s: State): State {
  if (!s.attract && s.pending === null) return s;
  return { ...s, attract: false, demoFocus: null, pending: null };
}

interface CommitOpts { inId?: BlockId; flashId?: BlockId; dragged?: BlockId; dragOff?: number }

/** Every change to the stack goes through here, so the snap motion is computed once. */
function commit(s: State, st: BlockId[], opts: CommitOpts, line: string): State {
  const old = s.stack;
  const from: Partial<Record<BlockId, number>> = {};
  if (!opts.dragged) {
    st.forEach((id, i) => {
      const o = old.indexOf(id);
      if (o >= 0 && o !== i) from[id] = (o - i) * PITCH;
    });
  } else if (opts.dragOff) {
    from[opts.dragged] = Math.round(opts.dragOff);
  }
  const n = s.anim.n + 1;
  const done = complete(st);
  let next: State = {
    ...s,
    stack: st,
    anim: { n, from, inId: opts.inId ?? null },
    flash: { id: opts.flashId ?? opts.inId ?? null, n },
    drag: null,
    msg: "",
    done,
  };
  let text = line;
  if (done && !s.done) {
    next.cheer = s.cheer + 1;
    if (text) text += DONE_LINE;
  }
  next = say(next, text);
  return next;
}

function add(s: State, id: BlockId, user: boolean): State {
  if (s.stack.includes(id)) return s;
  const st = [...s.stack, id];
  const next = commit(s, st, { inId: id }, user ? `Added ${BY[id].label}. ${st.length} of ${TOTAL} blocks used.` : "");
  return fx(next, { scroll: id });
}

function remove(s: State, id: BlockId, user: boolean, from: "chip" | "row"): State {
  const i = s.stack.indexOf(id);
  if (i < 0) return s;
  const st = s.stack.filter((x) => x !== id);
  const next = commit(s, st, {}, user ? `Removed ${BY[id].label}. ${st.length} of ${TOTAL} blocks used.` : "");
  if (user && from === "row") {
    const after = st[i] ?? st[i - 1];
    return fx(next, { focus: after ? `bb-rm-${after}` : `bb-chip-${id}` });
  }
  return next;
}

function move(s: State, id: BlockId, dir: -1 | 1, user: boolean, kind: "" | "up" | "dn" | "grip"): State {
  const st = [...s.stack];
  const i = st.indexOf(id);
  if (i < 0) return s;
  const j = i + dir;
  const label = BY[id].label;
  if (j < 0) return user ? say(s, `${label} is already at the top.`) : s;
  if (j >= st.length) return user ? say(s, `${label} is already at the bottom.`) : s;
  st.splice(i, 1);
  st.splice(j, 0, id);
  const next = commit(s, st, { flashId: id }, user ? `Moved ${label} to position ${j + 1} of ${st.length}.` : "");
  return fx(next, { scroll: id, focus: user && kind ? `bb-${kind}-${id}` : null });
}

function publish(s: State, user: boolean): State {
  if (!s.stack.length) {
    const t = "Add a block first. There is nothing to publish yet.";
    return user ? say({ ...s, msg: t }, t) : { ...s, msg: t };
  }
  const slug = s.pub ? s.pub.slug : s.slug.replace(/-+$/, "");
  if (!slug) {
    const t = "Type a name for the link first.";
    return user ? say({ ...s, msg: t }, t) : { ...s, msg: t };
  }
  const sig = s.stack.join(",");
  if (s.pub && s.pub.sig === sig) {
    return user ? say(s, `Already up to date at markdrop.in/${slug}. Change a block, then publish again.`) : s;
  }
  const again = !!s.pub;
  const next: State = { ...s, pub: { slug, sig }, slug, ripple: s.ripple + 1, msg: "" };
  if (!user) return next;
  return say(next, again ? `Published your changes. Same link: markdrop.in/${slug}.` : `Published. Your README is live at markdrop.in/${slug}.`);
}

function reset(s: State, user: boolean): State {
  const n = s.anim.n + 1;
  const next: State = {
    ...s,
    stack: [...IDLE],
    view: "rendered",
    pub: null,
    msg: "",
    slug: DEFAULT_SLUG,
    done: false,
    drag: null,
    anim: { n, from: {}, inId: null },
    flash: { id: null, n },
    mockNote: MOCK_NOTE,
  };
  const out = user ? say(next, "Started over with four blocks: Title, Badges, Install and a Mermaid diagram.") : next;
  return fx(out, { top: true });
}

function doStep(s: State, st: Step): State {
  let next = s;
  if (st.add && !next.stack.includes(st.add)) next = add(next, st.add, false);
  if (st.move) next = move(next, st.move, st.dir ?? -1, false, "");
  if (st.view) next = { ...next, view: st.view };
  if (st.publish) next = publish(next, false);
  if (st.reset) next = reset(next, false);
  return next;
}

function tick(s: State): State {
  if (!s.attract || s.paused) return s;
  let next: State = { ...s, clock: s.clock + TICK_MS };
  if (next.pending !== null && next.clock >= next.pendingAt) {
    const st = STEPS[next.pending];
    next = doStep({ ...next, pending: null }, st);
  }
  if (next.clock >= next.nextAt) {
    const idx = next.step % STEPS.length;
    const st = STEPS[idx];
    next = {
      ...next,
      step: next.step + 1,
      demoSay: st.say,
      demoFocus: st.add ?? st.move ?? null,
      pending: idx,
      pendingAt: next.clock + BEAT_MS,
      nextAt: next.clock + STEP_MS,
    };
  }
  return next;
}

/* ── Reducer ───────────────────────────────────────────────────────────── */

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "TICK":
      return tick(s);
    case "INTERACT":
      return interact(s);
    case "REDUCED_MOTION":
      // The board pauses the demo under reduced motion; the landing rule is stricter: it never runs.
      return s.attract ? { ...s, attract: false, demoFocus: null, pending: null } : s;
    case "TOGGLE": {
      const t = interact(s);
      return t.stack.includes(a.id) ? remove(t, a.id, true, "chip") : add(t, a.id, true);
    }
    case "REMOVE":
      return remove(interact(s), a.id, true, "row");
    case "MOVE":
      return move(interact(s), a.id, a.dir, true, a.kind);
    case "DRAG_MOVE":
      return { ...interact(s), drag: a.drag };
    case "DRAG_END": {
      const g = s.drag;
      if (!a.active || !g) return g ? { ...s, drag: null } : s;
      if (g.to === g.from) return commit(s, [...s.stack], { dragged: g.id, dragOff: g.dy }, "");
      const st = [...s.stack];
      st.splice(g.from, 1);
      st.splice(g.to, 0, g.id);
      const next = commit(
        s,
        st,
        { dragged: g.id, dragOff: g.dy - (g.to - g.from) * PITCH, flashId: g.id },
        `Moved ${BY[g.id].label} to position ${g.to + 1} of ${st.length}.`,
      );
      return fx(next, { scroll: g.id });
    }
    case "DRAG_CANCEL":
      return s.drag ? { ...s, drag: null } : s;
    case "SET_VIEW": {
      const t = interact(s);
      if (t.view === a.view) return t;
      return say({ ...t, view: a.view }, a.view === "source" ? "Showing the Markdown source of README.md." : "Showing the rendered README.");
    }
    case "SLUG": {
      const t = interact(s);
      if (t.pub) return say(t, "The link is set once it is published. Use Start over to pick a new one.");
      return { ...t, slug: cleanSlug(a.raw), msg: "" };
    }
    case "PUBLISH":
      return publish(interact(s), true);
    case "DOWNLOAD": {
      const t = "In the real builder this saves README.md. This preview does not download files.";
      return say({ ...interact(s), mockNote: t }, t);
    }
    case "START_OVER":
      return reset(interact(s), true);
    case "TOGGLE_PAUSE": {
      const p = !s.paused;
      const next: State = {
        ...s,
        paused: p,
        demoSay: p ? "Demo paused." : SAY_WATCHING,
        nextAt: p ? s.nextAt : s.clock + 600,
      };
      return say(next, p ? "Demo paused." : "Demo playing.");
    }
  }
}

/* ── Derived view values (board renderVals() without the closures) ─────── */

export interface Check { t: string; ok: boolean }
export interface SrcLine { n: number; t: string; tk: string; first: BlockId | null; blk: BlockId | null }

export function derive(s: State) {
  const stack = s.stack;
  const used = stack.length;
  const checks: Check[] = [
    { t: "Title on top", ok: stack[0] === "title" },
    { t: "Install", ok: stack.includes("install") },
    { t: "Usage", ok: stack.includes("usage") },
    { t: "License last", ok: used > 0 && stack[used - 1] === "license" },
  ];
  const lines: SrcLine[] = [];
  stack.forEach((id, bi) => {
    if (bi > 0) lines.push({ n: 0, t: "", tk: "", first: null, blk: null });
    SRC[id].forEach((l, li) => lines.push({ n: 0, t: l[0], tk: l[1], first: li === 0 ? id : null, blk: id }));
  });
  lines.forEach((l, i) => { l.n = i + 1; });
  const sig = stack.join(",");
  const pub = s.pub;
  const stale = !!pub && pub.sig !== sig;
  const done = complete(stack);
  return {
    used,
    isEmpty: used === 0,
    checks,
    done,
    lines,
    lineText: `${lines.length} ${lines.length === 1 ? "line" : "lines"}`,
    demoId: s.attract ? s.demoFocus : null,
    par: s.anim.n % 2 ? "a" : "b",
    fpar: s.flash.n % 2 ? "a" : "b",
    stale,
    resKind: (s.msg ? "warn" : pub && !stale ? "live" : pub ? "stale" : "idle") as "warn" | "live" | "stale" | "idle",
    shownSlug: pub ? pub.slug : s.slug || "your-link",
    resLead: done ? "Checklist complete. Publish to get" : "Publishing gives you a link like",
    pubText: stale ? "Publish changes" : pub ? "Published" : "Publish",
    pubGlow: (done && !pub) || stale,
    rp: s.ripple % 2 ? "a" : "b",
  };
}
