/**
 * "Can they open it?" (landing section 8): the attachment-vs-link game. Pure data, state and
 * reducer, ported from design/revamp-canvas/PlayCanTheyOpen.dc.html. No React, no DOM.
 *
 * Board DCLogic method -> where it lives now:
 *   constructor            -> `initialState` (the board's `aClock = 1000`, `aIdx = 0` start values below)
 *   componentDidMount      -> Game: matchMedia reduced motion dispatches `stopDemo`; the 100ms interval
 *                             runs only while the section is in view and the tab is visible
 *   tick()                 -> Game keeps the attract clock in a ref (no re-render per tick) and
 *                             dispatches `demoStep` every STEP_MS; `aIdx` lives in state
 *   interact()             -> `interact()` helper, applied by every user action
 *   send(dev, thing, user) -> `send()` helper
 *   pickDev(id)            -> action `pickDev`
 *   pickThing(id)          -> action `pickThing` (the click-after-drag guard is a ref in Game)
 *   togglePause()          -> action `togglePause` (Game resets the clock to RESUME_AT on play)
 *   down / dragMove        -> Game holds the pointer origin in a ref; action `dragMove` carries the ghost
 *   dragUp                 -> action `drop`
 *   dragCancel             -> action `dragCancel`
 *   renderVals()           -> `deriveView()` (pure; View renders it)
 */

/* ── Who is on the other end ─────────────────────────────────────────── */
export type DevId = "phone" | "tablet" | "laptop" | "linux" | "tv";
export type Device = { id: DevId; label: string; sub: string; short: string; where: string };
export const DEVICES: readonly Device[] = [
  { id: "phone", label: "Phone", sub: "Mail app", short: "Phone", where: "a phone" },
  { id: "tablet", label: "Tablet", sub: "Mail app", short: "Tablet", where: "a tablet" },
  { id: "laptop", label: "Work laptop", sub: "No office suite installed", short: "Laptop", where: "a work laptop" },
  { id: "linux", label: "Linux desktop", sub: "Desktop mail client", short: "Desktop", where: "a Linux desktop" },
  { id: "tv", label: "TV browser", sub: "A browser and a remote", short: "TV", where: "a TV browser" },
];

/* ── What is being sent (one document, five artifacts) ───────────────── */
export type ThingId = "md" | "xlsx" | "docx" | "mp4" | "zip" | "html";
export type ThingIcon = "doc" | "table" | "lines" | "film" | "archive" | "code";
export type Thing = { id: ThingId; file: string; size: string; icon: ThingIcon; kind: "Document" | "Artifact"; ext: string };
export const THINGS: readonly Thing[] = [
  { id: "md", file: "trip-notes.md", size: "4 KB", icon: "doc", kind: "Document", ext: ".md" },
  { id: "xlsx", file: "q3-budget.xlsx", size: "86 KB", icon: "table", kind: "Artifact", ext: ".xlsx" },
  { id: "docx", file: "proposal.docx", size: "1.1 MB", icon: "lines", kind: "Artifact", ext: ".docx" },
  { id: "mp4", file: "launch-video.mp4", size: "1.2 GB", icon: "film", kind: "Artifact", ext: ".mp4" },
  { id: "zip", file: "microsite.zip", size: "3.4 MB", icon: "archive", kind: "Artifact", ext: ".zip" },
  { id: "html", file: "checkout.html", size: "48 KB", icon: "code", kind: "Artifact", ext: ".html" },
];

export const DEV_BY = Object.fromEntries(DEVICES.map((d) => [d.id, d])) as Record<DevId, Device>;
export const THING_BY = Object.fromEntries(THINGS.map((t) => [t.id, t])) as Record<ThingId, Thing>;

export type Verdict = "ok" | "part" | "fail";
export const VERDICT_LABEL: Record<Verdict, string> = { ok: "Opened", part: "Opened, not as sent", fail: "Did not open" };
export const VERDICT_ICON: Record<Verdict, "checkCircle" | "alertCircle" | "x"> = { ok: "checkCircle", part: "alertCircle", fail: "x" };

export type AttKind = "raw" | "preview" | "app" | "download" | "big" | "folder" | "nowhere" | "local" | "bare";
export type AttOutcome = { k: AttKind; v: Verdict; vl?: string; chrome: string; title: string; text: string; line?: string };

/** What usually happens to the attachment. Outcomes vary by app; these are the common, generic ones. */
export function att(d: DevId, t: ThingId): AttOutcome {
  const mob = d === "phone" || d === "tablet";
  if (t === "mp4") return { k: "big", v: "fail", vl: "Did not arrive", chrome: "Inbox", title: "Too large to email", text: "Mail services cap attachments far below 1.2 GB, so it never leaves your outbox." };
  if (d === "tv") return { k: "nowhere", v: "fail", chrome: "TV browser", title: "Nowhere to open it", text: "A TV browser has no mail app and nowhere to save a file." };
  if (t === "md") {
    if (d === "tablet") return { k: "app", v: "fail", chrome: "Mail · trip-notes.md", title: "Needs an app", text: "Nothing on this tablet opens .md files, so it asks them to find one.", line: "No app here opens .md files." };
    if (d === "phone") return { k: "raw", v: "part", chrome: "Mail · trip-notes.md", title: "Shows the raw symbols", text: "It opens as plain text: # and ** instead of headings and bold." };
    return { k: "raw", v: "part", chrome: "Text editor · trip-notes.md", title: d === "laptop" ? "Downloads, then shows raw symbols" : "Shows the raw symbols", text: "It opens in a text editor: # and ** instead of headings and bold." };
  }
  if (t === "xlsx" || t === "docx") {
    const sheet = t === "xlsx";
    const f = sheet ? "q3-budget.xlsx" : "proposal.docx";
    if (mob) {
      return sheet
        ? { k: "preview", v: "part", chrome: "Preview · " + f, title: "A read-only preview", text: "The first sheet shows. Other tabs, charts and formulas may not." }
        : { k: "preview", v: "ok", chrome: "Preview · " + f, title: "A read-only preview", text: "A plain proposal usually previews fine, and this one did." };
    }
    if (d === "laptop") return { k: "download", v: "fail", chrome: "Downloads", title: "Downloads instead of opening", text: sheet ? "There is no spreadsheet app on this laptop to open it." : "There is no word processor on this laptop to open it.", line: "No app here opens " + (sheet ? ".xlsx" : ".docx") + " files." };
    return { k: "app", v: "part", chrome: "Mail · " + f, title: "Needs an office suite", text: "If one is installed it opens, though layouts and fonts can shift.", line: "Choose an office suite to open it." };
  }
  if (t === "zip") return { k: "folder", v: "fail", chrome: "Files · microsite.zip", title: "Opens a folder of files", text: "They get index.html, styles and images, not a site they can click through." };
  if (mob) return { k: "bare", v: "part", chrome: "Preview · checkout.html", title: "Opens without its styles", text: "The mail preview shows bare text. Scripts and linked files often do not load." };
  return { k: "local", v: "ok", chrome: "file:///Downloads/checkout.html", title: "Downloads, then opens", text: "Saved to disk, then opened in a browser. It works because it is a single file." };
}

export type LinkKind = "md" | "sheet" | "doc" | "send" | "tvsend" | "site" | "html";
export type LinkOutcome = { k: LinkKind; path: string; v: Verdict; vl?: string; title: string; text: string; acct: boolean };
type LinkBase = Omit<LinkOutcome, "v">;

/** What the Markdrop link does. Artifacts need the sender to have a free account; readers never need one. */
export const LINK: Record<ThingId, LinkBase> = {
  md: { k: "md", path: "trip-notes", title: "Opens as a formatted page", text: "Headings, bold and checklists render in the browser.", acct: false },
  xlsx: { k: "sheet", path: "q3-budget", title: "Opens as a sheet, tabs and all", text: "Rendered in the browser, so there is nothing to install.", acct: true },
  docx: { k: "doc", path: "proposal", title: "Opens as a formatted page", text: "Headings and paragraphs, rendered in the browser.", acct: true },
  mp4: { k: "send", path: "share/7fK2q", title: "Goes device to device", text: "Sent browser to browser and encrypted device to device. The file is never stored. Keep both pages open until it lands.", acct: false, vl: "Received" },
  zip: { k: "site", path: "microsite", title: "Opens as a working site", text: "The zip unpacks into pages, styles and images that link to each other.", acct: true },
  html: { k: "html", path: "checkout", title: "Opens and runs in the browser", text: "Served from a separate sandboxed origin, so its scripts can run.", acct: true },
};

export function link(d: DevId, t: ThingId): LinkOutcome {
  const b = LINK[t];
  if (d === "tv" && t === "mp4") return { k: "tvsend", path: b.path, v: "fail", title: "Nowhere to save it", text: "A device-to-device send saves the file, and a TV browser has nowhere to keep it. Send it to a laptop instead.", acct: false };
  const text = d === "tv" ? "Type the short link into the TV browser. " + b.text : b.text;
  return { ...b, v: "ok", text };
}

export type Tried = Partial<Record<DevId, Partial<Record<ThingId, true>>>>;
export function tally(tried: Tried, d: DevId): { n: number; l: number; a: number } {
  const m = tried[d] || {};
  let n = 0;
  let l = 0;
  let a = 0;
  for (const t of THINGS) {
    if (!m[t.id]) continue;
    n += 1;
    if (link(d, t.id).v === "ok") l += 1;
    if (att(d, t.id).v === "ok") a += 1;
  }
  return { n, l, a };
}

/* ── Attract (demo) loop ─────────────────────────────────────────────── */
export const ATTRACT: ReadonlyArray<readonly [DevId, ThingId]> = [
  ["phone", "md"], ["tv", "docx"], ["laptop", "zip"], ["phone", "mp4"], ["linux", "html"], ["tablet", "xlsx"], ["laptop", "xlsx"],
];
/** One demo send every 3.6s. */
export const STEP_MS = 3600;
/** The board's 100ms tick. */
export const TICK_MS = 100;
/** The clock starts here, so the first demo send lands 2.6s after the section comes into view. */
export const CLOCK_START = 1000;
/** Pressing Play makes the next send land 600ms later. */
export const RESUME_AT = STEP_MS - 600;

/* ── State ───────────────────────────────────────────────────────────── */
export type Ghost = { id: ThingId; x: number; y: number };
export type State = {
  dev: DevId;
  thing: ThingId;
  /** Bumped on every send; its parity flips the root class so the CSS keyframes replay. 0 = no animation yet. */
  run: number;
  tried: Tried;
  /** The demo loop is armed (Game only ticks it while in view, visible and motion is allowed). */
  attract: boolean;
  /** The current pair came from the demo, not the visitor. */
  demo: boolean;
  aIdx: number;
  live: string;
  ghost: Ghost | null;
  hot: boolean;
};

export const initialState: State = {
  dev: "laptop",
  thing: "xlsx",
  run: 0,
  tried: { laptop: { xlsx: true } },
  attract: true,
  demo: false,
  aIdx: 0,
  live: "",
  ghost: null,
  hot: false,
};

export type Action =
  | { type: "pickDev"; id: DevId }
  | { type: "pickThing"; id: ThingId }
  | { type: "demoStep" }
  | { type: "togglePause" }
  | { type: "stopDemo" }
  | { type: "dragMove"; ghost: Ghost; hot: boolean; first: boolean }
  | { type: "drop"; id: ThingId }
  | { type: "dragCancel" };

function interact(s: State): State {
  return s.attract || s.demo ? { ...s, attract: false, demo: false } : s;
}

function send(s: State, devId: DevId, thingId: ThingId, fromUser: boolean): State {
  let tried = s.tried;
  let live = s.live;
  if (fromUser) {
    const was = tally(s.tried, devId).n;
    tried = { ...s.tried, [devId]: { ...(s.tried[devId] || {}), [thingId]: true } };
    const D = DEV_BY[devId];
    const T = THING_BY[thingId];
    const a = att(devId, thingId);
    const l = link(devId, thingId);
    const sc = tally(tried, devId);
    live = `${D.label}, ${T.file}. As an attachment: ${a.title}. As a Markdrop link: ${l.title}. Links worked ${sc.l} of ${sc.n}, attachments ${sc.a} of ${sc.n}.`;
    if (sc.n === THINGS.length && was < THINGS.length) live += ` All six sent to ${D.where}.`;
  }
  return { ...s, dev: devId, thing: thingId, run: s.run + 1, tried, demo: !fromUser, live };
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "pickDev":
      return send(interact(s), a.id, s.thing, true);
    case "pickThing":
      return send(interact(s), s.dev, a.id, true);
    case "demoStep": {
      if (!s.attract || s.ghost) return s;
      const [d, t] = ATTRACT[s.aIdx % ATTRACT.length];
      return { ...send(s, d, t, false), aIdx: s.aIdx + 1 };
    }
    case "togglePause":
      return s.attract ? { ...s, attract: false, demo: false, live: "Demo paused." } : { ...s, attract: true, live: "Demo playing." };
    case "stopDemo":
      return s.attract || s.demo ? { ...s, attract: false, demo: false } : s;
    case "dragMove": {
      const base = a.first ? interact(s) : s;
      return { ...base, ghost: a.ghost, hot: a.hot };
    }
    case "drop": {
      const hot = s.hot;
      const cleared = { ...s, ghost: null, hot: false };
      return hot ? send(cleared, s.dev, a.id, true) : cleared;
    }
    case "dragCancel":
      return s.ghost || s.hot ? { ...s, ghost: null, hot: false } : s;
    default:
      return s;
  }
}

/* ── View model (the board's renderVals) ─────────────────────────────── */
export type DeviceView = { id: DevId; label: string; short: string; sub: string; on: boolean; done: boolean; count: string; aria: string };
export type ThingView = Thing & { on: boolean; aria: string };
export type ColView = { id: ThingId; ext: string; cur: boolean; lc: Verdict | "no"; ac: Verdict | "no" };
export type ViewModel = {
  parity: "" | "a" | "b";
  D: Device;
  T: Thing;
  A: AttOutcome & { vlabel: string; vicon: (typeof VERDICT_ICON)[Verdict] };
  L: LinkOutcome & { vlabel: string; vicon: (typeof VERDICT_ICON)[Verdict]; req: string; reqTone: "neutral" | "success" };
  devices: DeviceView[];
  things: ThingView[];
  score: { fin: boolean; where: string; lText: string; aText: string; goal: string };
  cols: ColView[];
  ghost: (Ghost & { icon: ThingIcon; label: string }) | null;
  demoOn: boolean;
  playing: boolean;
  hot: boolean;
  live: string;
};

export function deriveView(s: State): ViewModel {
  const D = DEV_BY[s.dev];
  const T = THING_BY[s.thing];
  const a = att(s.dev, s.thing);
  const l = link(s.dev, s.thing);
  const total = THINGS.length;
  const devices = DEVICES.map((d) => {
    const n = tally(s.tried, d.id).n;
    return {
      id: d.id, label: d.label, short: d.short, sub: d.sub,
      on: d.id === s.dev,
      done: n === total,
      count: n ? `${n} of ${total}` : "",
      aria: d.label + ", " + d.sub + (n ? `. ${n} of ${total} sent` : ""),
    };
  });
  const things = THINGS.map((t) => ({ ...t, on: t.id === s.thing, aria: `Send ${t.file}, ${t.size}, to ${D.where}` }));
  const sc = tally(s.tried, s.dev);
  const fin = sc.n === total;
  const m = s.tried[s.dev] || {};
  const g = s.ghost;
  return {
    parity: s.run === 0 ? "" : s.run % 2 ? "a" : "b",
    D, T,
    A: { ...a, vlabel: a.vl || VERDICT_LABEL[a.v], vicon: VERDICT_ICON[a.v] },
    L: {
      ...l, vlabel: l.vl || VERDICT_LABEL[l.v], vicon: VERDICT_ICON[l.v],
      req: l.acct ? "Sender needs a free account" : "No account needed",
      reqTone: l.acct ? "neutral" : "success",
    },
    devices,
    things,
    score: {
      fin,
      where: "On " + D.where,
      lText: sc.n ? `Links worked ${sc.l} of ${sc.n}` : "Nothing sent here yet",
      aText: sc.n ? `Attachments ${sc.a} of ${sc.n}` : "Pick a file to send",
      goal: fin ? "All six sent. Try another device." : `${total - sc.n} more to see the whole picture.`,
    },
    cols: THINGS.map((t) => ({
      id: t.id, ext: t.ext, cur: t.id === s.thing,
      lc: m[t.id] ? link(s.dev, t.id).v : "no",
      ac: m[t.id] ? att(s.dev, t.id).v : "no",
    })),
    ghost: g ? { ...g, icon: THING_BY[g.id].icon, label: THING_BY[g.id].file } : null,
    demoOn: s.attract && s.demo,
    playing: s.attract,
    hot: s.hot,
    live: s.live,
  };
}
