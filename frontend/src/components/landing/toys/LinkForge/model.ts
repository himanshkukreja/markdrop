/**
 * Link Forge: the rules of the forge. Pure data, state and reducer; no React, no DOM.
 * Ported from design/revamp-canvas/PlayLinkForge.dc.html (logic from line 427).
 *
 * Strip-only TypeScript (no enums, no parameter properties, no imports), so `node --test` can load
 * it directly (see model.test.mjs).
 *
 * DCLogic method → where it lives now
 *   constructor            → initialState (+ "today" once the game mounts: MIN_DATE is computed, not hard-coded)
 *   componentDidMount      → Game effects: reduced motion (never autostarts), IntersectionObserver, visibility
 *   tick()                 → "tick" (the Game sends "stop" instead when focus is inside the stage, as the board does)
 *   releaseStage()         → Game (blurs the focused stage control before "togglePause")
 *   stopDemo()             → "stop"
 *   togglePause()          → "togglePause"
 *   user(patch)            → "user", "flip", "slugInput", "slugEnter", "useSuggestion"
 *   apply(patch, byUser)   → apply()
 *   copy()                 → "copyStart" + "copyDemo" (no clipboard write: the link is a preview); copiedAt → Game timeout → "copyClear"
 *   renderVals()           → deriveView()
 *   derive()               → derive()
 *
 * Differences from the board, on purpose:
 * - The demo does not start in the constructor. The Game sends "autostart" once the section is in
 *   view, the tab is visible, the layout is two-column and reduced motion is off. So the static
 *   first frame (the SSR poster) honestly reads "Play demo".
 * - Slug checks are a simulation: no network. "Taken" names are labelled as demo, and a valid name
 *   says nothing is reserved until you publish (the real check happens at publish time, 409).
 * - Copy does not write to the clipboard: the forged link is not published (its name is not reserved
 *   and its key is fake), so the button says "Preview" and the live region explains.
 * - The chat unfurl mirrors the real OG cards (F2/R35): a password or encrypted document unfurls as
 *   a content-free "Password-protected document" / "Encrypted document" card.
 */

export type DestId = "link" | "ws";
export type ExpId = "never" | "1d" | "7d" | "30d" | "custom";
export type TabId = "team" | "phone";
export type TraitId = "name" | "pw" | "exp" | "enc" | "dom";
export type SlugStatus = "ok" | "random" | "short" | "taken";

export interface Settings {
  dest: DestId;
  slug: string;
  /** The raw text the visitor typed, when slugify changed it (drives the "Cleaned up" note). */
  echo: string;
  pwOn: boolean;
  pw: string;
  pwShow: boolean;
  exp: ExpId;
  date: string;
  enc: boolean;
  tab: TabId;
}

export interface State extends Settings {
  /** Every change of link shape (demo or visitor); its parity replays the forge animation. */
  forgeN: number;
  /** Distinct valid shapes the visitor made. */
  forged: number;
  shapes: Record<string, true>;
  found: Partial<Record<TraitId, true>>;
  /** "demo": the visitor pressed Copy on a preview link; nothing is written to the clipboard. */
  copied: "" | "ok" | "fail" | "demo";
  copyN: number;
  /** Demo mode is on (board `attract`). */
  attract: boolean;
  paused: boolean;
  /** The visitor took over at least once: the demo never starts on its own again. */
  touched: boolean;
  say: string;
  live: string;
  aClock: number;
  aIdx: number;
  lastShape: string;
  /** First selectable expiry date (tomorrow). The poster uses the board's fixed date. */
  minDate: string;
  /** The date the demo and the reset use for a custom expiry. */
  idleDate: string;
}

/* ── The rules of the forge (claims kept to product facts) ── */

/** Demo-only "taken" names and the suggestion for each. Nothing is looked up. */
export const TAKEN: Record<string, string> = { readme: "readme-k4n", docs: "docs-7qp" };
/** A sample of the 7-character base58 slug the server generates when the name is blank. */
export const RANDOM = "k7f3qa2";
/** The board's dates (canvas day 2026-10-13). The Game replaces them with real ones at mount. */
export const POSTER_MIN_DATE = "2026-10-14";
export const POSTER_IDLE_DATE = "2026-10-31";
export const SLUG_MAX = 50;
export const PW_MAX = 40;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const EXPIRY: ReadonlyArray<{ id: ExpId; label: string }> = [
  { id: "never", label: "Never" },
  { id: "1d", label: "1 day" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "custom", label: "Custom" },
];

export const TRAITS: ReadonlyArray<{ id: TraitId; label: string }> = [
  { id: "name", label: "Name" },
  { id: "pw", label: "Password" },
  { id: "exp", label: "Expiry" },
  { id: "enc", label: "Encrypt" },
  { id: "dom", label: "Domain" },
];

export const DESTS: ReadonlyArray<{ id: DestId; title: string; meta: string; icon: string }> = [
  { id: "link", title: "Just this link", meta: "markdrop.in/…", icon: "link" },
  { id: "ws", title: "A workspace folder", meta: "docs.example.com/handbook/…", icon: "folder" },
];

export const TABS: ReadonlyArray<{ id: TabId; label: string; icon: string }> = [
  { id: "team", label: "Team chat", icon: "list" },
  { id: "phone", label: "Phone chat", icon: "inbox" },
];

export const COPY = {
  eyebrow: "Publish settings",
  title: "Make the link yours.",
  lead: "Name it, lock it, set it to expire or encrypt it. The link changes as you go, and so does what people see when you paste it in a chat.",
  ctaPrimary: "Start writing",
  ctaPrimaryHref: "/new",
  ctaNote: "No login. No friction. Just links.",
  ctaSecondary: "See workspaces",
  ctaSecondaryHref: "/enterprise",
} as const;

const SNIP = "Week one: accounts, rituals, and who to ask for what.";
const SNIP_SHORT = "Accounts, rituals, who to ask.";
/** The real OG cards for documents that are not readable anonymously (REVAMP_PLAN 7.21, F2). */
const CARD_PASSWORD = { title: "Password-protected document", snip: "Open the link and enter the password to read it." };
const CARD_ENCRYPTED = { title: "Encrypted document", snip: "The key is in the link. Markdrop stores ciphertext it has no key for." };

const IDLE: Settings = {
  dest: "link",
  slug: "team-handbook",
  echo: "",
  pwOn: false,
  pw: "",
  pwShow: false,
  exp: "never",
  date: POSTER_IDLE_DATE,
  enc: false,
  tab: "team",
};

/* ── Attract loop: a taken name, a password, an expiry, encryption, a workspace ── */

export interface DemoStep {
  at: number;
  /** `idle: true` resets to IDLE with the state's own idle date. */
  set: Partial<Settings> & { idle?: true };
  say: string;
}
export const DEMO: DemoStep[] = [];
function at(t: number, set: DemoStep["set"], say?: string) {
  DEMO.push({ at: t, set, say: say || "" });
}
at(0, { idle: true }, "Demo: a plain link, ready to share");
at(1500, { slug: "", echo: "" }, "Demo: naming it readme");
"readme".split("").forEach((_, i) => at(1700 + i * 140, { slug: "readme".slice(0, i + 1) }));
at(3700, { slug: "readme-k4n" }, "Demo: readme is taken, so take the suggestion");
at(5200, { pwOn: true }, "Demo: adding a password");
"harbor".split("").forEach((_, i) => at(5500 + i * 110, { pw: "harbor".slice(0, i + 1) }));
at(7400, { exp: "7d" }, "Demo: expires in 7 days");
at(9200, { enc: true }, "Demo: encrypting it, the preview seals");
at(11600, { tab: "phone" }, "Demo: the same link on a phone");
at(13600, { enc: false, pwOn: false, pw: "", dest: "ws", slug: "onboarding" }, "Demo: publishing to docs.example.com");
at(15600, { exp: "custom" }, "Demo: a custom expiry date");
at(17600, { tab: "team" }, "Demo: back in the team chat");
export const LOOP = 20000;

/* ── Helpers ── */

/** Same alphabet and limits as `/new` (letters, digits, - and _; at most 50). Spaces and dots become dashes. */
export function slugify(v: string): string {
  return String(v || "")
    .replace(/[\s.]+/g, "-")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX);
}

/** A deterministic, fake 43-character key (the length of a real base64url AES-256 key). Never real. */
export function keyFor(seed: string): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let out = "Qx7";
  for (let i = 0; i < 40; i++) {
    h = (Math.imul(h ^ (h >>> 13), 1103515245) + 12345) >>> 0;
    out += abc[h % 64];
  }
  return out;
}

export function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return "";
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return "";
  return MONTHS[mo - 1] + " " + Number(m[3]) + ", " + m[1];
}

function isoDay(d: Date): string {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/** Tomorrow (the first date a link can stop working) and the demo's custom date, 18 days out like the board. */
export function datesFrom(nowMs: number): { minDate: string; idleDate: string } {
  const now = new Date(nowMs);
  const min = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const idle = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 18);
  return { minDate: isoDay(min), idleDate: isoDay(idle) };
}

/* ── Derivation: everything shown comes from the settings, so impossible states answer truthfully ── */

export interface Derived {
  ws: boolean;
  host: string;
  prefix: string;
  clean: string;
  name: string;
  status: SlugStatus;
  valid: boolean;
  pwSet: boolean;
  dateTxt: string;
  expTag: string;
  expOn: boolean;
  fragShow: string;
  display: string;
  url: string;
  summary: string;
  traits: TraitId[];
  shape: string;
  announce: string;
}

export function derive(s: Settings & { minDate: string }): Derived {
  const ws = s.dest === "ws";
  const host = ws ? "docs.example.com" : "markdrop.in";
  const prefix = ws ? "/handbook/" : "/";
  const clean = (s.slug || "").replace(/-+$/, "");
  let status: SlugStatus = "ok";
  let name = clean;
  if (!clean) {
    status = "random";
    name = RANDOM;
  } else if (clean.length < 3) status = "short";
  else if (!ws && TAKEN[clean.toLowerCase()]) status = "taken";
  const valid = status === "ok" || status === "random";
  const pwSet = !!s.pwOn && s.pw.length > 0;
  const dateTxt = fmtDate(s.date);
  let expTag = "";
  let expLine = "It never expires.";
  if (s.exp === "1d") { expTag = "Expires in 1 day"; expLine = "It stops working in 1 day."; }
  if (s.exp === "7d") { expTag = "Expires in 7 days"; expLine = "It stops working in 7 days."; }
  if (s.exp === "30d") { expTag = "Expires in 30 days"; expLine = "It stops working in 30 days."; }
  if (s.exp === "custom") {
    const future = !!dateTxt && s.date >= s.minDate;
    expTag = future ? "Expires " + dateTxt : "";
    expLine = future ? "It stops working on " + dateTxt + "." : dateTxt ? "Pick a date after today." : "Pick a date for it to stop working.";
  }
  const expOn = !!expTag;
  const key = s.enc ? keyFor(name) : "";
  const fragShow = s.enc ? "#k=" + key.slice(0, 7) + "…" : "";
  const display = host + prefix + name + fragShow;
  const url = "https://" + host + prefix + name + (s.enc ? "#k=" + key : "");

  const lines: string[] = [];
  if (status === "short") lines.push("A custom name needs at least 3 characters. Leave it blank and you get a short random one.");
  else if (status === "taken") lines.push("In this demo, markdrop.in/" + clean + " is already taken. Use " + TAKEN[clean.toLowerCase()] + ", or try another name. Real names are checked when you publish.");
  else {
    if (s.enc) lines.push("Encrypted in your browser: Markdrop stores ciphertext it has no key for, and the title is sealed too.");
    else if (ws) lines.push("Opens on docs.example.com with your logo and name. You pick who can open it: just you, anyone with the link, the workspace, or named people.");
    else if (pwSet) lines.push("Anyone with the link and the password can read it, no account needed. You can edit it later.");
    else lines.push("Anyone with the link can read it, no account needed. You can edit it later.");
    if (pwSet && (s.enc || ws)) lines.push("Readers enter the password first.");
    if (s.enc) lines.push("Lose the link and the document is gone.");
    lines.push(expLine);
  }
  const summary = lines.join(" ");

  const traits: TraitId[] = [];
  if (valid) {
    if (status === "ok") traits.push("name");
    if (pwSet) traits.push("pw");
    if (expOn) traits.push("exp");
    if (s.enc) traits.push("enc");
    if (ws) traits.push("dom");
  }
  const shape = valid ? [s.dest, status, pwSet ? "p" : "-", s.exp, s.enc ? "e" : "-"].join("|") : "x|" + status;
  const announce = (valid ? "Link: " + display + ". " : "") + summary;
  return { ws, host, prefix, clean, name, status, valid, pwSet, dateTxt, expTag, expOn, fragShow, display, url, summary, traits, shape, announce };
}

/* ── State machine ── */

export const initialState: State = {
  ...IDLE,
  forgeN: 0,
  forged: 0,
  shapes: {},
  found: {},
  copied: "",
  copyN: 0,
  attract: false,
  paused: false,
  touched: false,
  say: "",
  live: "",
  aClock: 0,
  aIdx: 0,
  lastShape: derive({ ...IDLE, minDate: POSTER_MIN_DATE }).shape,
  minDate: POSTER_MIN_DATE,
  idleDate: POSTER_IDLE_DATE,
};

/**
 * The tallest the settings card gets while the demo plays (a taken name with its suggestion, a
 * password with its hint, the encryption warning). The View renders it invisibly under the real card
 * so the demo never pushes the page around (CLS). Only the visitor's own input can grow the card past
 * it (a custom date on top of all that), and shifts right after input do not count.
 */
export const ghostState: State = {
  ...initialState,
  slug: "readme",
  pwOn: true,
  pw: "harbor",
  exp: "7d",
  enc: true,
};

export type Action =
  | { type: "tick"; dt: number }
  | { type: "autostart" }
  | { type: "stop" }
  | { type: "togglePause" }
  | { type: "user"; patch: Partial<Settings> }
  | { type: "flip"; key: "pwOn" | "pwShow" | "enc" }
  | { type: "slugInput"; raw: string }
  | { type: "slugEnter" }
  | { type: "useSuggestion" }
  | { type: "copyStart" }
  | { type: "copied"; ok: boolean; url: string }
  | { type: "copyDemo" }
  | { type: "copyClear" }
  | { type: "today"; minDate: string; idleDate: string };

/** board.apply(): settings change, shape counter, and (for the visitor) the meter and announcement. */
function apply(s: State, patch: Partial<Settings>, byUser: boolean): State {
  const next: State = { ...s, ...patch };
  const d = derive(next);
  if (d.shape !== s.lastShape) {
    next.lastShape = d.shape;
    next.forgeN = s.forgeN + 1;
  }
  if (byUser) {
    if (d.valid && !s.shapes[d.shape]) {
      next.shapes = { ...s.shapes, [d.shape]: true };
      next.forged = Object.keys(next.shapes).length;
    }
    const before = Object.keys(s.found).length;
    const f: Partial<Record<TraitId, true>> = { ...s.found };
    d.traits.forEach((t) => { f[t] = true; });
    next.found = f;
    next.live = d.announce;
    if (Object.keys(f).length === TRAITS.length && before < TRAITS.length) next.live = "All five options tried. " + d.announce;
  }
  return next;
}

/** board.stopDemo(): the visitor took over; the demo stays off until they press Play. */
function stop(s: State): State {
  if (!s.attract) return s.touched ? s : { ...s, touched: true };
  return { ...s, attract: false, paused: false, say: "", touched: true };
}

function user(s: State, patch: Partial<Settings>): State {
  return apply(stop(s), patch, true);
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "tick": {
      if (!s.attract || s.paused) return s;
      let n: State = { ...s, aClock: s.aClock + a.dt };
      while (n.aIdx < DEMO.length && n.aClock >= DEMO[n.aIdx].at) {
        const st = DEMO[n.aIdx];
        const patch: Partial<Settings> = st.set.idle ? { ...IDLE, date: n.idleDate } : st.set;
        n = apply(n, patch, false);
        if (st.say) n.say = st.say;
        n.aIdx += 1;
      }
      if (n.aClock >= LOOP) {
        n.aClock = 0;
        n.aIdx = 0;
      }
      return n;
    }
    case "autostart":
      if (s.attract || s.touched) return s;
      return { ...s, attract: true, paused: false, aClock: 0, aIdx: 0 };
    case "stop":
      return stop(s);
    case "togglePause":
      if (!s.attract) return { ...s, aClock: 0, aIdx: 0, attract: true, paused: false, live: "Demo playing. Press Pause demo to stop it." };
      return { ...s, paused: !s.paused, live: s.paused ? "Demo playing." : "Demo paused." };
    case "user":
      return user(s, a.patch);
    case "flip":
      return user(s, { [a.key]: !s[a.key] });
    case "slugInput": {
      const raw = String(a.raw || "");
      const sl = slugify(raw);
      return user(s, { slug: sl, echo: raw !== sl ? raw : "" });
    }
    case "slugEnter": {
      const d = derive(s);
      if (d.status !== "taken") return s;
      return user(s, { slug: TAKEN[d.clean.toLowerCase()], echo: "" });
    }
    case "useSuggestion": {
      const d = derive(s);
      return user(s, { slug: TAKEN[d.clean.toLowerCase()] || s.slug, echo: "" });
    }
    case "copyStart":
      return stop(s);
    case "copied":
      return a.ok
        ? { ...s, copied: "ok", copyN: s.copyN + 1, live: "Copied " + a.url }
        : { ...s, copied: "fail", copyN: s.copyN + 1, live: "Copying is blocked here. Select the link text to copy it." };
    case "copyDemo":
      // The forged link is a preview: the name is not reserved and the key is fake, so nothing is
      // copied (REVAMP_BUILD H.8: markdrop.in slugs in mocks are display text, never live links).
      return { ...stop(s), copied: "demo", copyN: s.copyN + 1, live: "Nothing copied: this link is a preview. It goes live when you publish it." };
    case "copyClear":
      return s.copied ? { ...s, copied: "" } : s;
    case "today": {
      const n: State = { ...s, minDate: a.minDate, idleDate: a.idleDate };
      if (!s.touched && s.date === POSTER_IDLE_DATE) n.date = a.idleDate;
      return n;
    }
    default:
      return s;
  }
}

/* ── View model (board renderVals without the closures) ── */

export type Tone = "" | "ok" | "warn" | "bad";

export interface ViewModel {
  attract: boolean;
  running: boolean;
  ppText: string;
  sayOn: boolean;
  say: string;
  meter: {
    n: number;
    parity: "" | "a" | "b";
    stamps: Array<{ id: TraitId; label: string; on: boolean; srText: string }>;
    hint: string;
    done: boolean;
  };
  dests: Array<{ id: DestId; title: string; meta: string; icon: string; pressed: boolean }>;
  host: string;
  prefix: string;
  ws: boolean;
  slug: string;
  slugCount: string;
  slugTone: Tone;
  st: { tone: Tone; icon: string; text: string; sug: string };
  pw: { on: boolean; sub: string; subDim: boolean; val: string; show: boolean; hint: string; hintDim: boolean };
  enc: boolean;
  chips: Array<{ id: ExpId; label: string; pressed: boolean }>;
  expCustom: boolean;
  expLab: string;
  date: string;
  minDate: string;
  outNote: string;
  pill: {
    parity: "" | "a" | "b";
    tone: Tone;
    icon: string;
    enc: boolean;
    long: boolean;
    host: string;
    path: string;
    random: boolean;
    frag: string;
    full: string;
  };
  copy: { disabled: boolean; ok: boolean; aria: string; icon: string; text: string };
  tags: Array<{ key: string; tone: "" | "enc" | "dom" | "off" | "warn"; icon: string; text: string }>;
  summary: string;
  tabs: Array<{ id: TabId; label: string; icon: string; pressed: boolean }>;
  cv: {
    broken: boolean;
    brokenText: string;
    team: boolean;
    phone: boolean;
    sealed: boolean;
    ws: boolean;
    site: string;
    siteHost: string;
    lockIcon: "" | "lock" | "key";
    title: string;
    snip: string;
    snipShort: string;
    link: string;
    reply: string;
    wsNote: boolean;
  };
  live: string;
}

const par = (n: number): "" | "a" | "b" => (n > 0 ? (n % 2 ? "a" : "b") : "");

export function deriveView(s: State): ViewModel {
  const d = derive(s);
  const foundN = Object.keys(s.found || {}).length;

  /* Slug status line */
  let st: ViewModel["st"];
  if (d.status === "random") st = { tone: "", icon: "info", text: "Blank is fine: you get a short random link like " + d.host + d.prefix + RANDOM + ".", sug: "" };
  else if (d.status === "short") st = { tone: "bad", icon: "alert", text: "At least 3 characters, or leave it blank.", sug: "" };
  else if (d.status === "taken") st = { tone: "warn", icon: "alertCircle", text: "markdrop.in/" + d.clean + " is taken in this demo. Press Enter or", sug: TAKEN[d.clean.toLowerCase()] };
  else if (s.echo) st = { tone: "ok", icon: "checkCircle", text: "Cleaned up: spaces become dashes and other symbols drop out.", sug: "" };
  else if (d.ws) st = { tone: "ok", icon: "checkCircle", text: "Goes in your handbook folder. Folders become URL paths.", sug: "" };
  else st = { tone: "ok", icon: "checkCircle", text: "Looks good: letters, numbers, dashes and underscores. Nothing is reserved until you publish.", sug: "" };

  const enc = !!s.enc;
  const pw = {
    on: !!s.pwOn,
    sub: enc ? "Optional here: the key in the link already locks the text." : "Readers type it before the page opens.",
    subDim: enc,
    val: s.pw,
    show: !!s.pwShow,
    hint: !s.pw ? "Type a password to turn it on." : enc ? "Two gates: the password opens the page, the key after # decrypts it." : "Share the password separately from the link.",
    hintDim: enc,
  };

  const pillTone: Tone = d.status === "taken" ? "warn" : d.status === "short" ? "bad" : "";
  const pill = {
    parity: par(s.forgeN),
    tone: pillTone,
    icon: enc ? "eyeOff" : d.pwSet ? "lock" : d.ws ? "globe" : "link",
    enc,
    long: d.display.length > 38,
    host: d.host,
    path: d.prefix + d.name,
    random: d.status === "random",
    frag: d.fragShow,
    full: d.valid ? d.url : "",
  };
  const copy = {
    disabled: !d.valid,
    ok: s.copied === "ok",
    aria: d.valid ? "Copy link " + d.display : "Copy link, unavailable until the name is fixed",
    icon: s.copied === "ok" ? "check" : s.copied === "demo" ? "info" : "copy",
    text: s.copied === "ok" ? "Copied" : s.copied === "fail" ? "Select it" : s.copied === "demo" ? "Preview" : "Copy",
  };

  const tags: ViewModel["tags"] = [];
  if (!d.valid) tags.push({ key: "bad", tone: "warn", icon: "alert", text: d.status === "taken" ? "Name taken" : "Name too short" });
  else if (d.status === "random") tags.push({ key: "name", tone: "", icon: "zap", text: "Random name" });
  else tags.push({ key: "name", tone: "", icon: "edit", text: "Custom name" });
  if (d.ws) tags.push({ key: "dom", tone: "dom", icon: "globe", text: "Your domain" });
  if (d.pwSet) tags.push({ key: "pw", tone: "", icon: "lock", text: "Password" });
  else if (s.pwOn) tags.push({ key: "pw-off", tone: "off", icon: "lock", text: "Password not set yet" });
  if (d.expOn) tags.push({ key: "exp", tone: "", icon: "clock", text: d.expTag });
  if (enc) tags.push({ key: "enc", tone: "enc", icon: "eyeOff", text: "End-to-end encrypted" });
  if (!d.ws && !d.pwSet && !enc) tags.push({ key: "anyone", tone: "", icon: "eye", text: "Anyone with the link" });

  /* Chat preview: content-free cards exactly where the real OG card is content-free */
  const team = s.tab !== "phone";
  const hidden = enc ? CARD_ENCRYPTED : d.pwSet ? CARD_PASSWORD : null;
  let reply = "Opened it, no sign-in needed.";
  if (d.ws) reply = "Opened it on docs.example.com.";
  if (enc) reply = "Opened it from the full link.";
  if (d.pwSet) reply = "Got it. What is the password?";
  const cv = {
    broken: !d.valid,
    brokenText: "Fix the link name to see how it unfurls.",
    team: d.valid && team,
    phone: d.valid && !team,
    sealed: d.valid && enc,
    ws: d.ws,
    site: d.ws ? "Example docs" : "Markdrop",
    siteHost: d.host,
    lockIcon: (enc ? "key" : d.pwSet ? "lock" : "") as "" | "lock" | "key",
    title: hidden ? hidden.title : "Team handbook",
    snip: hidden ? hidden.snip : SNIP,
    snipShort: hidden ? hidden.snip : SNIP_SHORT,
    link: d.display,
    reply,
    wsNote: d.ws && !hidden,
  };

  /* Meter */
  let hint = "Change any setting to forge a new link shape.";
  if (s.forged > 0 && foundN < TRAITS.length) hint = "Tried " + foundN + " of 5 options. Each new combination counts.";
  if (foundN >= TRAITS.length) hint = "All five tried. One link can carry every option.";

  const running = s.attract && !s.paused;
  return {
    attract: s.attract,
    running,
    ppText: running ? "Pause demo" : "Play demo",
    sayOn: !!s.attract && !!s.say,
    say: s.paused ? "Demo paused" : s.say,
    meter: {
      n: s.forged || 0,
      parity: par(s.forged || 0),
      stamps: TRAITS.map((t) => ({ id: t.id, label: t.label, on: !!s.found[t.id], srText: s.found[t.id] ? ", tried" : ", not tried yet" })),
      hint,
      done: foundN >= TRAITS.length,
    },
    dests: DESTS.map((x) => ({ id: x.id, title: x.title, meta: x.meta, icon: x.icon, pressed: s.dest === x.id })),
    host: d.host,
    prefix: d.prefix,
    ws: d.ws,
    slug: s.slug,
    slugCount: (s.slug || "").length + " / " + SLUG_MAX,
    slugTone: d.status === "taken" ? "warn" : d.status === "short" ? "bad" : "",
    st,
    pw,
    enc,
    chips: EXPIRY.map((x) => ({ id: x.id, label: x.label, pressed: s.exp === x.id })),
    expCustom: s.exp === "custom",
    expLab: s.exp === "never" ? "Never expires" : d.expTag || "Pick a date",
    date: s.date,
    minDate: s.minDate,
    outNote: d.valid ? "Updates as you change anything" : "Not ready to share yet",
    pill,
    copy,
    tags,
    summary: d.summary,
    tabs: TABS.map((t) => ({ id: t.id, label: t.label, icon: t.icon, pressed: s.tab === t.id })),
    cv,
    live: s.live,
  };
}
