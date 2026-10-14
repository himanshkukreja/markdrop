/**
 * Render Bench (landing section 2, artifacts pillar): the pure model.
 *
 * Ported from design/revamp-canvas/PlayRenderBench.dc.html (`class Component` at line 732). No React,
 * no DOM: data, state, a deterministic reducer and `deriveView` (the board's `renderVals`).
 *
 * DCLogic method          → here
 *   constructor state      → initialState (timer fields `aClock`, `aIdx`, `pendingUser`, `reduce` moved in)
 *   componentDidMount      → SET_REDUCE (the Game reads prefers-reduced-motion and dispatches it)
 *   tick()                 → TICK { dt, attractOn }   (the Game only dispatches it while the tab is visible)
 *   start(id, user)        → start()  (PICK, DRAG_END over the frame, and the attract branch of TICK)
 *   finish()               → finish()
 *   interact()             → interact()  (every user action except TOGGLE_PAUSE ends the demo for good)
 *   pick(id)               → PICK  (the Date.now() click-after-drag guard stays a ref in the Game)
 *   cardKey(e, i)          → Game  (moves focus only; no state)
 *   setNote()              → setNote()
 *   setAccess(a)           → ACCESS
 *   togglePw()             → TOGGLE_PW
 *   setVTheme(t)           → VTHEME
 *   copyLink()             → COPY  (no clipboard write: the sample links are not published, see COPY)
 *   unlock() / relock()    → UNLOCK / RELOCK
 *   togglePause()          → TOGGLE_PAUSE
 *   dragDown()             → Game  (pointer capture; no state)
 *   dragMove()             → DRAG_MOVE
 *   dragUp()               → DRAG_END
 *   dragCancel()           → DRAG_CANCEL
 *   renderVals pdf.prev/next → PDF_PAGE;  sheet row/tab → SEL_ROW / SHEET_TAB;  vid → VID_TOGGLE / VID_SEEK;
 *   zip → ZIP_PAGE;  img → IMG_ZOOM
 *   toggleTheme            → dropped (the board's theme switch is canvas-only; the toy follows the site theme)
 */

export type FileId = "html" | "pdf" | "xlsx" | "docx" | "mp4" | "zip" | "png";
export type Access = "anyone" | "workspace" | "private";
export type Gate = "" | "password" | "workspace" | "private";
export type Phase = "shown" | "upload" | "type";
export type VTheme = "light" | "dark";
export type SheetTab = "Budget" | "Notes";
export type ZipPageId = "index.html" | "guide.html" | "api.html";
/** `A`/`B` parity classes replay a one-shot CSS animation without remounting (board convention). */
export type Parity = "" | "A" | "B";

export interface FileDef {
  id: FileId;
  file: string;
  type: string;
  ext: string;
  slug: string;
  /** Card, pip and extension-tag tint (board `tint`). */
  tint: string;
  /** FileIcon glyph and its family tint. */
  icon: string;
  iconTint: string;
}

/* ── The shelf: seven file types, each with the link it gets ───────────────────────────────── */
export const FILES: readonly FileDef[] = [
  { id: "html", file: "launch.html", type: "HTML page", ext: "HTML", slug: "launch", tint: "var(--cat-sync)", icon: "code", iconTint: "var(--cat-sync)" },
  { id: "pdf", file: "q3-report.pdf", type: "PDF report", ext: "PDF", slug: "q3-report", tint: "var(--danger)", icon: "doc", iconTint: "var(--cat-pdf)" },
  { id: "xlsx", file: "q3-budget.xlsx", type: "Spreadsheet", ext: "XLSX", slug: "q3-budget", tint: "var(--success)", icon: "table", iconTint: "var(--cat-sheet)" },
  { id: "docx", file: "proposal.docx", type: "Word doc", ext: "DOCX", slug: "proposal", tint: "var(--cat-document)", icon: "lines", iconTint: "var(--cat-document)" },
  { id: "mp4", file: "demo-clip.mp4", type: "Video", ext: "MP4", slug: "demo-clip", tint: "var(--cat-share)", icon: "film", iconTint: "var(--cat-video)" },
  { id: "zip", file: "docs-site.zip", type: "Zipped site", ext: "ZIP", slug: "docs-site", tint: "var(--cat-artifact)", icon: "archive", iconTint: "var(--cat-artifact)" },
  { id: "png", file: "cover.png", type: "Image", ext: "PNG", slug: "cover", tint: "var(--code-inline)", icon: "image", iconTint: "var(--cat-image)" },
];
export const FBY = Object.fromEntries(FILES.map((f) => [f.id, f])) as Record<FileId, FileDef>;

/** Display text only. These sample slugs are not published, so nothing here is ever a link. */
export const HOST = "markdrop.in";
export const ATTRACT: readonly FileId[] = ["html", "pdf", "mp4", "zip", "docx", "png", "xlsx"];
export const ATTRACT_EVERY = 4800;
/** The board starts its attract clock at 2000, so the first demo file lands 2.8s after it starts. */
export const ATTRACT_START = 2000;
export const TICK_MS = 50;
export const COPIED_MS = 1600;

export const PDF_TITLES = ["Quarterly report", "Summary", "Revenue by month", "Costs", "Hiring", "Customers", "Roadmap", "Risks", "Team", "Appendix A", "Appendix B", "Contacts"];
export const PDF_PAGES = PDF_TITLES.length;

export const SHEET: ReadonlyArray<readonly [string, number, number, number]> = [
  ["Design", 4200, 4800, 5100],
  ["Engineering", 18500, 19200, 21000],
  ["Marketing", 6000, 7400, 9800],
  ["Support", 3100, 3100, 3600],
  ["Hosting", 1250, 1400, 1520],
  ["Tools", 890, 920, 980],
  ["Travel", 2400, 1100, 3300],
  ["Events", 0, 5500, 2000],
  ["Training", 750, 750, 1200],
  ["Hiring", 3000, 4500, 6000],
  ["Office", 2200, 2200, 2200],
  ["Contingency", 1000, 1000, 1500],
];

export const ZIP_PAGES: ReadonlyArray<{ id: ZipPageId; title: string; lead: string; code: string }> = [
  { id: "index.html", title: "Getting started", lead: "Install the tools, then run your first build. Each page in the zip is a page on the site.", code: "" },
  { id: "guide.html", title: "Guide", lead: "Group pages into folders. Links between pages work the way they did on your machine.", code: "" },
  { id: "api.html", title: "API reference", lead: "Every endpoint returns JSON. Start with the list call.", code: "GET /v1/notes?limit=20" },
];
export const VIDEO_SECONDS = 48;
export const CHAPTERS = ["Intro", "Setting up", "The editor", "Sharing", "Wrap-up"];

export const ACCESS: ReadonlyArray<{ id: Access; icon: string; label: string; sub: string; chip: string }> = [
  { id: "anyone", icon: "globe", label: "Anyone with the link", sub: "No sign-in to open it", chip: "Anyone" },
  { id: "workspace", icon: "user", label: "Workspace", sub: "Members sign in to open it", chip: "Workspace" },
  { id: "private", icon: "lock", label: "Private", sub: "Only you can open it", chip: "Private" },
];
const ABY = Object.fromEntries(ACCESS.map((a) => [a.id, a])) as Record<Access, (typeof ACCESS)[number]>;

export const GATES: Record<Exclude<Gate, "">, { icon: string; amber: boolean; title: string; body: string; btn: string; tag: string }> = {
  password: { icon: "lock", amber: false, title: "This file is password protected", body: "Enter the password you were given to open it.", btn: "Enter the password and open", tag: "Opened with the password" },
  workspace: { icon: "user", amber: false, title: "Sign in to open this file", body: "It is shared with your workspace. Members sign in and it opens.", btn: "Sign in as a member", tag: "Signed in as a member" },
  private: { icon: "userX", amber: true, title: "You don't have access", body: "This file is private. Only its owner can open it.", btn: "Switch to the owner", tag: "Opened by the owner" },
};

export const NOTES = {
  start: "Files are protected with a password or an access level. They are not end-to-end encrypted.",
  anyone: "Anyone with the link opens the file straight away. Add a password to ask for one first.",
  workspace: "Visitors now see a sign-in gate. Only members of your workspace get through.",
  private: "Visitors now see a closed gate. Only you can open this file.",
  pwOn: "Visitors now type the password before the file opens. That is protection, not end-to-end encryption.",
  pwOff: "Password off. Anyone with the link opens the file straight away.",
  pwLimited: "Workspace and Private already check who is signed in. Choose Anyone with the link to add a password.",
  pwDropped: "Workspace checks who is signed in, so the password is off.",
  pwDroppedPrivate: "Private checks who is signed in, so the password is off.",
  light: "Previewing the file in the light theme.",
  dark: "Previewing the file in the dark theme.",
} as const;

/** Deterministic on server and client (no locale data involved). */
export function money(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function clock(t: number): string {
  const s = Math.floor(t);
  return "0:" + (s < 10 ? "0" : "") + s;
}

/* ── State ─────────────────────────────────────────────────────────────────────────────────── */
export interface Ghost { id: FileId; x: number; y: number }

export interface State {
  cur: FileId;
  view: FileId;
  phase: Phase;
  prog: number;
  typed: number;
  landN: number;
  done: Partial<Record<FileId, true>>;
  newType: FileId | "";
  access: Access;
  pw: boolean;
  vtheme: VTheme;
  unlocked: boolean;
  note: string;
  noteWarn: boolean;
  noteN: number;
  attract: boolean;
  paused: boolean;
  pdfPage: number;
  vplay: boolean;
  vt: number;
  zipPage: ZipPageId;
  zipN: number;
  imgZoom: boolean;
  selRow: number;
  sheetTab: SheetTab;
  copied: number;
  ghost: Ghost | null;
  hot: boolean;
  dragId: FileId | "";
  live: string;
  /* Timer fields the board kept on `this`. */
  aClock: number;
  aIdx: number;
  pendingUser: boolean;
  reduce: boolean;
}

/** The board's constructor state: the spreadsheet already rendered, the demo armed. Also the SSR poster. */
export const initialState: State = {
  cur: "xlsx", view: "xlsx", phase: "shown", prog: 100, typed: 99, landN: 0,
  done: {}, newType: "",
  access: "anyone", pw: false, vtheme: "light", unlocked: false,
  note: NOTES.start, noteWarn: false, noteN: 0,
  attract: true, paused: false,
  pdfPage: 1, vplay: false, vt: 12, zipPage: "index.html", zipN: 0, imgZoom: false, selRow: 2, sheetTab: "Budget",
  copied: 0, ghost: null, hot: false, dragId: "", live: "",
  aClock: ATTRACT_START, aIdx: 0, pendingUser: false, reduce: false,
};

export type Action =
  | { type: "TICK"; dt: number; attractOn: boolean }
  | { type: "PICK"; id: FileId }
  | { type: "ACCESS"; access: Access }
  | { type: "TOGGLE_PW" }
  | { type: "VTHEME"; vtheme: VTheme }
  | { type: "COPY" }
  | { type: "UNLOCK" }
  | { type: "RELOCK" }
  | { type: "TOGGLE_PAUSE" }
  | { type: "PDF_PAGE"; dir: -1 | 1 }
  | { type: "SEL_ROW"; n: number }
  | { type: "SHEET_TAB"; tab: SheetTab }
  | { type: "VID_TOGGLE" }
  | { type: "VID_SEEK"; t: number }
  | { type: "ZIP_PAGE"; id: ZipPageId }
  | { type: "IMG_ZOOM" }
  | { type: "DRAG_MOVE"; id: FileId; x: number; y: number; hot: boolean }
  | { type: "DRAG_END"; id: FileId; hot: boolean }
  | { type: "DRAG_CANCEL" }
  | { type: "SET_REDUCE"; reduce: boolean };

/* ── Helpers (the board's methods) ─────────────────────────────────────────────────────────── */
export function gateMode(s: Pick<State, "access" | "pw">): Gate {
  if (s.access === "private") return "private";
  if (s.access === "workspace") return "workspace";
  if (s.pw) return "password";
  return "";
}

export function pathOf(id: FileId, s: Pick<State, "zipPage">): string {
  let p = "/" + FBY[id].slug;
  if (id === "zip" && s.zipPage !== "index.html") p += "/" + s.zipPage;
  return p;
}

export function doneCount(s: Pick<State, "done">): number {
  return FILES.filter((f) => s.done[f.id]).length;
}

function interact(s: State): State {
  return s.attract ? { ...s, attract: false } : s;
}

function setNote(s: State, text: string, warn: boolean): State {
  return { ...s, note: text, noteWarn: warn, noteN: s.noteN + 1, live: text };
}

function finish(s: State): State {
  const f = FBY[s.cur];
  const p: State = { ...s, phase: "shown", view: s.cur, prog: 100, typed: 99, landN: s.landN + 1, pendingUser: false };
  if (s.pendingUser) {
    const was = !!s.done[f.id];
    const done = { ...s.done, [f.id]: true as const };
    p.done = done;
    p.newType = was ? "" : f.id;
    const n = doneCount({ done });
    let live = "Rendered " + f.file + " at " + HOST + "/" + f.slug + ". " + n + " of 7 file types.";
    const g = gateMode(s);
    if (g) live += " A visitor sees the " + (g === "password" ? "password" : g === "workspace" ? "sign-in" : "no-access") + " gate first.";
    if (n === 7 && !was) live += " All seven rendered. Your files are next.";
    p.live = live;
  }
  return p;
}

function start(s: State, id: FileId, user: boolean): State {
  const f = FBY[id];
  const base: State = {
    ...s, pendingUser: user, cur: id, unlocked: false, pdfPage: 1, vplay: false, vt: 12,
    zipPage: "index.html", imgZoom: false, selRow: 2, sheetTab: "Budget", newType: "",
  };
  if (user) { base.attract = false; base.live = "Uploading " + f.file + "."; }
  if (s.reduce) return finish({ ...base, phase: "type", prog: 100, typed: 0 });
  return { ...base, phase: "upload", prog: 0, typed: 0 };
}

function tick(s: State, dt: number, attractOn: boolean): State {
  const p: Partial<State> = {};
  if (s.phase === "upload") {
    const v = Math.min(100, s.prog + 6);
    p.prog = v;
    if (v >= 100) { p.phase = "type"; p.typed = 0; }
  } else if (s.phase === "type") {
    const len = ("/" + FBY[s.cur].slug).length;
    const t = s.typed + 1;
    if (t >= len) return finish({ ...s, ...p });
    p.typed = t;
  }
  if (s.vplay && s.view === "mp4" && s.phase === "shown") {
    let t = s.vt + dt / 1000;
    if (t >= VIDEO_SECONDS) t = 0;
    p.vt = t;
  }
  if (s.copied > 0) p.copied = Math.max(0, s.copied - dt);
  if (s.attract && !s.paused && attractOn) {
    const aClock = s.aClock + dt;
    if (aClock >= ATTRACT_EVERY && s.phase === "shown") {
      const id = ATTRACT[s.aIdx % ATTRACT.length];
      return start({ ...s, ...p, aClock: 0, aIdx: s.aIdx + 1 }, id, false);
    }
    p.aClock = aClock;
  }
  return Object.keys(p).length ? { ...s, ...p } : s;
}

/** Whether anything is moving, so the Game only runs its 50ms interval when it has to. */
export function isBusy(s: State): boolean {
  return s.phase !== "shown" || (s.vplay && s.view === "mp4") || s.copied > 0;
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "TICK":
      return tick(s, a.dt, a.attractOn);
    case "PICK":
      return start(s, a.id, true);
    case "ACCESS": {
      const s1 = interact(s);
      if (s1.access === a.access) return setNote(s1, NOTES[a.access], false);
      if (a.access !== "anyone" && s1.pw) {
        return setNote({ ...s1, access: a.access, pw: false, unlocked: false }, a.access === "private" ? NOTES.pwDroppedPrivate : NOTES.pwDropped, true);
      }
      return setNote({ ...s1, access: a.access, unlocked: false }, NOTES[a.access], false);
    }
    case "TOGGLE_PW": {
      const s1 = interact(s);
      if (s1.access !== "anyone") return setNote(s1, NOTES.pwLimited, true);
      const on = !s1.pw;
      return setNote({ ...s1, pw: on, unlocked: false }, on ? NOTES.pwOn : NOTES.pwOff, false);
    }
    case "VTHEME":
      return setNote({ ...interact(s), vtheme: a.vtheme }, NOTES[a.vtheme], false);
    case "COPY": {
      // Deviation from the board: nothing is written to the clipboard. The sample slugs are not
      // published (REVAMP_BUILD H.8), and some may belong to real people, so the button says so instead.
      const url = HOST + pathOf(s.view, s);
      return { ...interact(s), copied: COPIED_MS, live: url + " is a demo link, so nothing was copied. Upload your own file to get a real one." };
    }
    case "UNLOCK": {
      const s1 = interact(s);
      const g = gateMode(s1);
      if (!g) return s1;
      return { ...s1, unlocked: true, live: GATES[g].tag + ". " + FBY[s1.view].file + " opens." };
    }
    case "RELOCK":
      return { ...interact(s), unlocked: false, live: "Locked again. A visitor sees the gate." };
    case "TOGGLE_PAUSE": {
      const paused = !s.paused;
      return { ...s, paused, live: paused ? "Demo paused." : "Demo playing." };
    }
    case "PDF_PAGE": {
      const s1 = interact(s);
      const pg = s1.pdfPage + a.dir;
      if (pg < 1 || pg > PDF_PAGES) return s1;
      return { ...s1, pdfPage: pg, live: "Page " + pg + " of " + PDF_PAGES + "." };
    }
    case "SEL_ROW": {
      const r = SHEET[a.n - 2];
      if (!r) return s;
      const total = money(r[1] + r[2] + r[3]);
      return { ...interact(s), selRow: a.n, live: "Selected row " + a.n + ": " + r[0] + ", total " + total + "." };
    }
    case "SHEET_TAB":
      return { ...interact(s), sheetTab: a.tab };
    case "VID_TOGGLE": {
      const s1 = interact(s);
      const on = !s1.vplay;
      return { ...s1, vplay: on, live: on ? "Playing demo-clip.mp4." : "Paused at " + clock(s1.vt) + "." };
    }
    case "VID_SEEK":
      return { ...interact(s), vt: Math.max(0, Math.min(VIDEO_SECONDS, Number(a.t) || 0)) };
    case "ZIP_PAGE":
      return {
        ...interact(s), zipPage: a.id, zipN: s.zipN + 1,
        live: "Opened " + a.id + " at " + HOST + "/docs-site" + (a.id === "index.html" ? "" : "/" + a.id) + ".",
      };
    case "IMG_ZOOM":
      return { ...interact(s), imgZoom: !s.imgZoom };
    case "DRAG_MOVE":
      return { ...interact(s), ghost: { id: a.id, x: Math.round(a.x), y: Math.round(a.y) }, hot: a.hot, dragId: a.id };
    case "DRAG_END": {
      const s1: State = { ...s, ghost: null, hot: false, dragId: "" };
      return a.hot ? start(s1, a.id, true) : s1;
    }
    case "DRAG_CANCEL":
      return { ...s, ghost: null, hot: false, dragId: "" };
    case "SET_REDUCE":
      // Reduced motion: the demo never runs (it would swap content on its own). The belt then reads
      // "Your turn", which the poster already shows under the same media query, so nothing jumps.
      return a.reduce ? { ...s, reduce: true, attract: false } : { ...s, reduce: false };
    default:
      return s;
  }
}

/* ── deriveView (the board's renderVals, minus the closures) ───────────────────────────────── */
export function deriveView(s: State) {
  const shown = s.phase === "shown";
  const inFlight = !shown;
  const curF = FBY[s.cur];
  const doneN = doneCount(s);
  const all = doneN === 7;
  const left = 7 - doneN;
  const g = gateMode(s);
  const gateOn = !!g && !s.unlocked;
  const parity: Parity = s.landN > 0 ? (s.landN % 2 === 1 ? "A" : "B") : "";

  const cards = FILES.map((f) => ({
    ...f,
    domId: "rb-f-" + f.id,
    cur: s.view === f.id,
    lift: s.dragId === f.id,
    done: !!s.done[f.id],
    aria: "Render " + f.file + ", " + f.type + (s.done[f.id] ? ", rendered" : ""),
  }));

  const pips = FILES.map((f) => ({
    ...f,
    on: !!s.done[f.id],
    isNew: s.newType === f.id,
    title: f.type + (s.done[f.id] ? ", rendered" : ", not yet"),
  }));

  let addr: { placeholder: boolean; ph: string; hasLink: boolean; host: string; path: string; typing: boolean };
  if (s.phase === "upload") addr = { placeholder: true, ph: "Uploading " + curF.file + "…", hasLink: false, host: "", path: "", typing: false };
  else if (s.phase === "type") addr = { placeholder: false, ph: "", hasLink: true, host: HOST, path: ("/" + curF.slug).slice(0, s.typed), typing: true };
  else addr = { placeholder: false, ph: "", hasLink: true, host: HOST, path: pathOf(s.view, s), typing: false };
  const addrIcon = s.pw ? "lock" : s.access === "anyone" ? "globe" : s.access === "workspace" ? "user" : "lock";

  const pg = s.pdfPage;
  let t1 = 0, t2 = 0, t3 = 0;
  const rows = SHEET.map((r, i) => {
    t1 += r[1]; t2 += r[2]; t3 += r[3];
    const n = i + 2;
    const total = money(r[1] + r[2] + r[3]);
    return { n, item: r[0], q1: money(r[1]), q2: money(r[2]), q3: money(r[3]), total, sel: s.selRow === n, aria: "Row " + n + ", " + r[0] + ", total " + total };
  });

  const vtInt = Math.floor(s.vt);
  const chapterIdx = Math.min(4, Math.floor(vtInt / 10));
  const zp = ZIP_PAGES.find((z) => z.id === s.zipPage) ?? ZIP_PAGES[0];

  // `beltText` is for a mouse, `beltTouch` for touch screens, and `beltWide` is only true (and only
  // shown) in the three-column layout, where the link settings sit to the right of the browser.
  let beltLead = "Your turn.";
  let beltText = "Drag a file onto the browser, or click it";
  let beltTouch = "Tap a file to render it";
  let beltWide = "";
  if (all) { beltLead = "All seven rendered."; beltText = beltTouch = "Now try one of your own"; }
  else if (doneN > 0) { beltLead = left + " to go."; beltText = beltTouch = "Then try the link settings"; beltWide = " on the right"; }

  const pwLimited = s.access !== "anyone";
  const gd = g ? GATES[g] : GATES.password;
  const url = HOST + pathOf(s.view, s);

  return {
    meter: {
      n: doneN, all,
      aria: "Rendered: " + doneN + " of 7 file types",
      sub: doneN === 0 ? "Render a file from the shelf to start." : left + " left: " + FILES.filter((x) => !s.done[x.id]).map((x) => x.ext).join(", "),
    },
    pips, cards,
    addr: { ...addr, icon: addrIcon, locked: !!g, flash: shown ? parity : ("" as Parity), aria: addr.hasLink ? "Link: " + addr.host + addr.path : addr.ph },
    chip: {
      prot: !!g,
      icon: s.access === "anyone" ? (s.pw ? "lock" : "globe") : ABY[s.access].icon,
      text: s.pw ? "Anyone + password" : ABY[s.access].chip,
    },
    copy: {
      done: s.copied > 0,
      icon: s.copied > 0 ? "info" : "copy",
      text: s.copied > 0 ? "Demo link" : "Copy link",
      aria: s.copied > 0 ? "Demo link, nothing copied" : "Copy link " + url,
      disabled: inFlight,
    },
    vtheme: s.vtheme,
    body: { dim: inFlight, land: inFlight ? ("" as Parity) : parity },
    showGate: gateOn,
    showView: !gateOn,
    gate: { title: gd.title, body: gd.body, btn: gd.btn, icon: gd.icon, amber: gd.amber, pop: shown, isPw: g === "password" },
    showUnlocked: !!g && s.unlocked && shown,
    unlockTag: g ? GATES[g].tag : "",
    view: s.view,
    pdf: {
      page: pg, label: "Page " + pg + " of " + PDF_PAGES, title: PDF_TITLES[pg - 1],
      flip: (pg % 2 ? "A" : "B") as Parity,
      atStart: pg <= 1, atEnd: pg >= PDF_PAGES,
      bars: [0, 1, 2, 3, 4].map((i) => ((pg * 37 + i * 23) % 58) + 34),
    },
    sheet: {
      rows, totN: SHEET.length + 2,
      t1: money(t1), t2: money(t2), t3: money(t3), tt: money(t1 + t2 + t3),
      name: "E" + s.selRow, formula: "=SUM(B" + s.selRow + ":D" + s.selRow + ")",
      tab: s.sheetTab,
    },
    vid: {
      playing: s.vplay,
      aria: s.vplay ? "Pause the video" : "Play the video",
      time: clock(vtInt) + " / 0:" + VIDEO_SECONDS,
      t: vtInt,
      chapter: "Chapter " + (chapterIdx + 1) + ": " + CHAPTERS[chapterIdx],
      shift: Math.round(s.vt * 9),
    },
    zip: {
      files: ZIP_PAGES.map((z) => ({ id: z.id, pressed: s.zipPage === z.id })),
      title: zp.title, lead: zp.lead, code: zp.code,
      crumb: "docs-site / " + zp.id,
      flip: (s.zipN % 2 ? "A" : "B") as Parity,
      animate: s.zipN > 0,
    },
    img: { zoom: s.imgZoom, label: s.imgZoom ? "Zoom out" : "Zoom in" },
    fly: {
      show: inFlight, id: curF.id, file: curF.file,
      label: s.phase === "upload" ? "Uploading to your account" : "Rendering in the browser",
      prog: s.prog,
    },
    hot: s.hot,
    attract: s.attract,
    paused: s.paused,
    beltDemo: s.paused ? "Demo paused. Pick a file to take over." : "Watching a demo. Pick a file to take over.",
    beltLead, beltText, beltTouch, beltWide,
    pp: { text: s.paused ? "Play demo" : "Pause demo", aria: s.paused ? "Play the demo" : "Pause the demo" },
    access: ACCESS.map((a) => ({ ...a, pressed: s.access === a.id })),
    pw: {
      on: s.pw, limited: pwLimited,
      sub: pwLimited ? "For Anyone with the link" : s.pw ? "Visitors enter it first" : "Off",
      aria: pwLimited ? "Password, available with Anyone with the link" : "Password",
    },
    note: { text: s.note, warn: s.noteWarn, nudge: (s.noteN ? (s.noteN % 2 ? "A" : "B") : "") as Parity },
    ghost: s.ghost ? { ...s.ghost, file: FBY[s.ghost.id].file } : null,
    live: s.live,
  };
}

export type ViewModel = ReturnType<typeof deriveView>;
