/**
 * Domain Studio: pure data, state, reducer and view model (no React, no DOM).
 * Port of design/revamp-canvas/PlayDomainStudio.dc.html (`class Component extends DCLogic`).
 *
 * DCLogic method      → here
 *   fresh()           → fresh() / initialState
 *   componentDidMount → Game: STOP_DEMO under reduced motion, the 100ms TICK interval
 *   set / say         → say() (announcement + the sayN parity space)
 *   sayDone           → sayDone() (adds the finale line when the fifth item lands)
 *   engage            → engage(), run by every user action below
 *   tick              → TICK { dt, demo } (attract cycle only when `demo`; DNS verify timer always)
 *   focusId / goCheck → Game (DOM focus); SAY for the "Go live" chip while verifying
 *   onCompany         → COMPANY
 *   pickAcc / pickLogo→ PICK_ACC / PICK_LOGO
 *   rowKey            → Game keyboard → PICK_ACC / PICK_LOGO + focus (rowTarget())
 *   setChrome         → CHROME
 *   toggleSignin      → TOGGLE_SIGNIN
 *   setViewAs         → VIEW_AS
 *   onDomain          → DOMAIN
 *   addedTxt          → ADDED_TXT (Game focuses #ds-dom when the host is not usable)
 *   addedCname        → ADDED_CNAME { reduce } (reduced motion skips the verify wait)
 *   backDns           → BACK_DNS
 *   goLive            → goLive(), from TICK or ADDED_CNAME
 *   restartDns        → RESTART_DNS
 *   copy              → Game clipboard → ENGAGE, then COPY_NO_HOST | COPIED | COPY_BLOCKED; COPY_CLEAR
 *                       after 1600ms (the board's copiedAt check lives in Game as a timeout)
 *   onEmail / emailKey→ EMAIL / Game Enter → INVITE
 *   pickRole          → ROLE
 *   invite            → INVITE
 *   togglePlay        → TOGGLE_PLAY
 *   resetAll          → RESET
 *   renderVals        → deriveView()
 *
 * Self-contained on purpose (no imports), so `node --test` can load it with type stripping.
 */

/* ── Data ─────────────────────────────────────────────────────────────── */

/**
 * Brand accents the visitor can pick. These stand for the visitor's own brand, so they are the one
 * place raw colour values are allowed (REVAMP_BUILD 5.T, Domain Studio). The default is the
 * design-system `demo-accent` token ("someone else's brand in demos"), the same brand the
 * Enterprise page shows. `base` fills buttons and logos (white text on it passes AA, 4.54:1 or
 * more); `inkLight` / `inkDark` keep brand-coloured text at AA on each theme's surfaces.
 */
export const ACCENTS = [
  { name: "Magenta", base: "var(--demo-accent)", inkLight: "#B8005E", inkDark: "#FDA5D5" },
  { name: "Teal", base: "#0F766E", inkLight: "#0F766E", inkDark: "#5EEAD4" },
  { name: "Violet", base: "#6D28D9", inkLight: "#6D28D9", inkDark: "#C4B5FD" },
  { name: "Ochre", base: "#B45309", inkLight: "#92400E", inkDark: "#FCD34D" },
  { name: "Forest", base: "#15803D", inkLight: "#166534", inkDark: "#86EFAC" },
  { name: "Graphite", base: "#475569", inkLight: "#334155", inkDark: "#CBD5E1" },
] as const;

export type LogoShape = "circle" | "square" | "outline" | "diamond";
export const LOGOS: ReadonlyArray<{ id: LogoShape; name: string; two: boolean }> = [
  { id: "circle", name: "Circle", two: false },
  { id: "square", name: "Rounded square", two: true },
  { id: "outline", name: "Outline", two: true },
  { id: "diamond", name: "Diamond", two: false },
];

export const STEPS = ["Add TXT", "Add CNAME", "Verifying", "Live"] as const;
export type Role = "viewer" | "member" | "admin" | "owner";
export const ROLES: readonly Role[] = ["viewer", "member", "admin", "owner"];
export type InviteRole = "viewer" | "member" | "admin";
export const INVITE_ROLES: readonly InviteRole[] = ["viewer", "member", "admin"];
const SUGGEST = ["sam@example.com", "ana@example.com", "lee@example.com", "kim@example.com", "max@example.com"];

export type CheckKey = "named" | "accent" | "logo" | "live" | "invited";
export const CHECKS: ReadonlyArray<{ k: CheckKey; t: string; target: string }> = [
  { k: "named", t: "Name it", target: "ds-name" },
  { k: "accent", t: "Pick an accent", target: "ds-sw-0" },
  { k: "logo", t: "Pick a logo", target: "ds-lg-0" },
  { k: "live", t: "Go live on your domain", target: "ds-dns-go" },
  { k: "invited", t: "Invite someone", target: "ds-em" },
];

type HostStatus = "empty" | "ours" | "bad" | "ok";
const DOMAIN_MSG: Record<Exclude<HostStatus, "ok">, string> = {
  empty: "Enter a domain you own, like docs.example.com.",
  ours: "That is a Markdrop domain. Use one you own.",
  bad: "Not a domain yet. Try docs.example.com.",
};
export const VERIFY_MS = 1800;
/** Attract cadence: accent every 2.4s, logo every 4.8s, viewer chrome every 9.6s. */
export const ATTRACT_MS = 2400;
export const TICK_MS = 100;
export const COPIED_MS = 1600;
export const CNAME_TARGET = "edge.markdrop.in";

/* ── Pure helpers (ported verbatim) ───────────────────────────────────── */

export function normHost(raw: string): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "");
}

export function checkHost(host: string): HostStatus {
  if (!host) return "empty";
  if (/(^|\.)markdrop\.in$/.test(host)) return "ours";
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return "bad";
  return "ok";
}

/** A stable, made-up verification value per host (FNV-1a, two rounds). Not a real token. */
export function tokenFor(host: string): string {
  let a = 2166136261 >>> 0;
  for (let i = 0; i < host.length; i++) {
    a ^= host.charCodeAt(i);
    a = Math.imul(a, 16777619) >>> 0;
  }
  let b = Math.imul(a ^ 0x5bd1e995, 2654435761) >>> 0;
  b = (b ^ (b >>> 15)) >>> 0;
  return (a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0")).slice(0, 16);
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const withArticle = (role: string) => (role === "admin" ? "an " : "a ") + role;
type Done = Record<CheckKey, boolean>;
export const countDone = (d: Done) => CHECKS.filter((c) => d[c.k]).length;

/* ── State ────────────────────────────────────────────────────────────── */

export type Chrome = "full" | "none";
export type ViewAs = "visitor" | "member";
export type CopyKey = "txtName" | "txtVal" | "cnName" | "cnVal";
export type Step = 0 | 1 | 2 | 3;
export type Member = { id: number; email: string; role: InviteRole };

export type State = {
  /** The attract demo is armed (cycles accent, logo and chrome while in view). */
  attract: boolean;
  /** Attract clock in ms (the board's `this.ac`). */
  ac: number;
  company: string;
  domainRaw: string;
  acc: number;
  logo: number;
  chrome: Chrome;
  signin: boolean;
  viewAs: ViewAs;
  step: Step;
  dnsHost: string;
  verifyT: number;
  dnsBad: boolean;
  copied: CopyKey | "";
  email: string;
  role: InviteRole;
  members: Member[];
  emErr: string;
  newN: number;
  /** Member id counter (the board's `this.mid`). */
  mid: number;
  done: Done;
  washN: number;
  popN: number;
  dropN: number;
  live: string;
  /** Announcement counter (the board's `this.sayN`); survives Reset so repeats still announce. */
  sayN: number;
};

function fresh(): Omit<State, "attract" | "ac" | "mid" | "sayN"> {
  return {
    company: "Yourco",
    domainRaw: "docs.example.com",
    acc: 0,
    logo: 0,
    chrome: "full",
    signin: false,
    viewAs: "visitor",
    step: 0,
    dnsHost: "",
    verifyT: 0,
    dnsBad: false,
    copied: "",
    email: "sam@example.com",
    role: "member",
    members: [],
    emErr: "",
    newN: 0,
    done: { named: false, accent: false, logo: false, live: false, invited: false },
    washN: 0,
    popN: 0,
    dropN: 0,
    live: "",
  };
}

export const initialState: State = { attract: true, ac: 0, mid: 0, sayN: 0, ...fresh() };

/* ── Actions ──────────────────────────────────────────────────────────── */

export type Action =
  | { type: "TICK"; dt: number; demo: boolean }
  | { type: "STOP_DEMO" }
  | { type: "ENGAGE" }
  | { type: "TOGGLE_PLAY" }
  | { type: "RESET" }
  | { type: "SAY"; msg: string }
  | { type: "COMPANY"; value: string }
  | { type: "PICK_ACC"; i: number }
  | { type: "PICK_LOGO"; i: number }
  | { type: "CHROME"; value: Chrome }
  | { type: "TOGGLE_SIGNIN" }
  | { type: "VIEW_AS"; value: ViewAs }
  | { type: "DOMAIN"; value: string }
  | { type: "ADDED_TXT" }
  | { type: "ADDED_CNAME"; reduce: boolean }
  | { type: "BACK_DNS" }
  | { type: "RESTART_DNS" }
  | { type: "COPY_NO_HOST" }
  | { type: "COPIED"; key: CopyKey }
  | { type: "COPY_BLOCKED"; key: CopyKey }
  | { type: "COPY_CLEAR"; key: CopyKey }
  | { type: "EMAIL"; value: string }
  | { type: "ROLE"; value: InviteRole }
  | { type: "INVITE" };

function say(s: State, msg: string): State {
  const sayN = s.sayN + 1;
  return { ...s, sayN, live: msg + (sayN % 2 ? "" : " ") };
}

function sayDone(s: State, msg: string, before: Done, after: Done): State {
  const finished = countDone(after) === CHECKS.length && countDone(before) < CHECKS.length;
  return say(s, finished ? msg + " All five done. Create a workspace to do it for real." : msg);
}

/** The first real input stops the attract demo for good (Play brings it back on request). */
function engage(s: State): State {
  return s.attract ? { ...s, attract: false, ac: 0 } : s;
}

function goLive(s: State): State {
  const before = s.done;
  const after = { ...before, live: true };
  const next: State = { ...s, step: 3, verifyT: VERIFY_MS, done: after, dropN: s.dropN + 1 };
  return sayDone(next, "Both records found. " + s.dnsHost + " is live.", before, after);
}

/** What a copy button copies, and whether there is anything worth copying yet. */
export function copyTarget(s: State, key: CopyKey): { text: string; what: string; ready: boolean } {
  const host = normHost(s.domainRaw);
  const ok = checkHost(host) === "ok";
  const recHost = s.step > 0 ? s.dnsHost : ok ? host : "<your domain>";
  const recReady = s.step > 0 || ok;
  switch (key) {
    case "txtName":
      return { text: "_markdrop-verify." + recHost, what: "TXT name", ready: recReady };
    case "txtVal":
      return { text: "markdrop-verify=" + (recReady ? tokenFor(recHost) : "…"), what: "TXT value", ready: recReady };
    case "cnName":
      return { text: recHost, what: "CNAME name", ready: recReady };
    case "cnVal":
      return { text: CNAME_TARGET, what: "CNAME target", ready: true };
  }
}

/** Whether "I added the TXT record" will be refused (Game moves focus to the domain field). */
export function txtBlocked(s: State): boolean {
  return checkHost(normHost(s.domainRaw)) !== "ok";
}

/** Arrow keys, Home and End move along a row of picks (the board's rowKey). -1 = not handled. */
export function rowTarget(key: string, i: number, n: number): number {
  if (key === "ArrowRight" || key === "ArrowDown") return (i + 1) % n;
  if (key === "ArrowLeft" || key === "ArrowUp") return (i + n - 1) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return -1;
}

export function reducer(state: State, a: Action): State {
  switch (a.type) {
    case "TICK": {
      let s = state;
      if (a.demo && s.attract) {
        const ac = s.ac + a.dt;
        s = { ...s, ac };
        if (ac % ATTRACT_MS === 0) {
          s.acc = (s.acc + 1) % ACCENTS.length;
          s.washN = s.washN + 1;
          if (ac % (ATTRACT_MS * 2) === 0) {
            s.logo = (s.logo + 1) % LOGOS.length;
            s.popN = s.popN + 1;
          }
          if (ac % (ATTRACT_MS * 4) === 0) s.chrome = s.chrome === "full" ? "none" : "full";
        }
      }
      if (s.step === 2) {
        const t = s.verifyT + a.dt;
        s = t >= VERIFY_MS ? goLive(s) : { ...s, verifyT: t };
      }
      return s;
    }

    case "STOP_DEMO":
      return state.attract ? { ...state, attract: false, ac: 0 } : state;

    case "ENGAGE":
      return engage(state);

    case "TOGGLE_PLAY": {
      const on = !state.attract;
      return say({ ...state, attract: on, ac: 0 }, on ? "Demo playing. It cycles accents, logos and chrome." : "Demo paused.");
    }

    case "RESET":
      return say({ ...state, ...fresh(), attract: false, ac: 0, mid: 0 }, "Reset. Everything is back to the start.");

    case "SAY":
      return say(state, a.msg);

    /* ── Brand ── */
    case "COMPANY": {
      const s = engage(state);
      const v = String(a.value).slice(0, 28);
      const before = s.done;
      if (v.trim()) {
        const after = { ...before, named: true };
        const next = { ...s, company: v, done: after };
        return before.named ? next : sayDone(next, "Name set. It shows in the header and the link preview.", before, after);
      }
      return { ...s, company: v };
    }

    case "PICK_ACC": {
      const s = engage(state);
      const i = ((a.i % ACCENTS.length) + ACCENTS.length) % ACCENTS.length;
      const before = s.done;
      const after = { ...before, accent: true };
      return sayDone(
        { ...s, acc: i, washN: s.washN + 1, done: after },
        ACCENTS[i].name + " accent. Links, buttons and the link preview use it.",
        before,
        after,
      );
    }

    case "PICK_LOGO": {
      const s = engage(state);
      const i = ((a.i % LOGOS.length) + LOGOS.length) % LOGOS.length;
      const before = s.done;
      const after = { ...before, logo: true };
      return sayDone(
        { ...s, logo: i, popN: s.popN + 1, done: after },
        LOGOS[i].name + " logo. It shows in the header, the sign-in page and the link preview.",
        before,
        after,
      );
    }

    case "CHROME":
      return say(
        { ...engage(state), chrome: a.value },
        a.value === "full"
          ? "Viewer chrome: Full. Your logo, name and folders sit above the document."
          : "Viewer chrome: None. Visitors see just the document.",
      );

    case "TOGGLE_SIGNIN": {
      const on = !state.signin;
      return say(
        { ...engage(state), signin: on, viewAs: "visitor" },
        on
          ? "Sign-in required. Visitors sign in before the page opens. Use View as Member to see the page after sign-in."
          : "Sign-in off. Visitors go straight to the page.",
      );
    }

    case "VIEW_AS":
      return say(
        { ...engage(state), viewAs: a.value },
        a.value === "member" ? "Viewing as a signed-in member." : "Viewing as a visitor who has not signed in.",
      );

    /* ── Domain and DNS ── */
    case "DOMAIN": {
      const s = engage(state);
      const raw = String(a.value).slice(0, 64);
      const host = normHost(raw);
      if (s.step > 0 && host !== s.dnsHost) {
        return say(
          { ...s, domainRaw: raw, dnsBad: false, step: 0, verifyT: 0, done: { ...s.done, live: false } },
          "New domain, new records. Start again with the TXT record.",
        );
      }
      return { ...s, domainRaw: raw, dnsBad: false };
    }

    case "ADDED_TXT": {
      const s = engage(state);
      const host = normHost(s.domainRaw);
      const st = checkHost(host);
      if (st !== "ok") return say({ ...s, dnsBad: true }, DOMAIN_MSG[st]);
      return say({ ...s, step: 1, dnsHost: host, dnsBad: false }, "Next, add the CNAME that routes " + host + " to " + CNAME_TARGET + ".");
    }

    case "ADDED_CNAME": {
      const s = engage(state);
      if (s.step !== 1) return s;
      if (a.reduce) return goLive(s);
      return say({ ...s, step: 2, verifyT: 0 }, "Checking both records for " + s.dnsHost + ".");
    }

    case "BACK_DNS":
      return say({ ...engage(state), step: 0, verifyT: 0 }, "Back to the TXT record.");

    case "RESTART_DNS":
      return say(
        { ...engage(state), step: 0, verifyT: 0, done: { ...state.done, live: false } },
        "Starting over. Add the TXT record first.",
      );

    case "COPY_NO_HOST": {
      const s = engage(state);
      const st = checkHost(normHost(s.domainRaw));
      return say({ ...s, dnsBad: true }, st === "ok" ? DOMAIN_MSG.empty : DOMAIN_MSG[st]);
    }

    case "COPIED": {
      const t = copyTarget(state, a.key);
      return say({ ...engage(state), copied: a.key }, "Copied the " + t.what + ": " + t.text);
    }

    case "COPY_BLOCKED": {
      const t = copyTarget(state, a.key);
      return say(engage(state), "Copying is blocked here. The " + t.what + " is " + t.text + ".");
    }

    case "COPY_CLEAR":
      return state.copied === a.key ? { ...state, copied: "" } : state;

    /* ── People ── */
    case "EMAIL":
      return { ...engage(state), email: String(a.value).slice(0, 64), emErr: "" };

    case "ROLE":
      return say({ ...engage(state), role: a.value }, "Inviting as " + withArticle(a.value) + ".");

    case "INVITE": {
      const s = engage(state);
      const v = s.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(v)) {
        const msg = "Enter an email address, like sam@example.com.";
        return say({ ...s, emErr: msg }, msg);
      }
      const prev = s.members.find((m) => m.email === v);
      if (prev) {
        /* Move them to the top so the change is visible even when the list is trimmed. */
        const rest = s.members.filter((m) => m.email !== v);
        return say(
          { ...s, members: [{ ...prev, role: s.role }, ...rest], emErr: "", newN: s.newN + 1 },
          v + " is already invited. Role changed to " + s.role + ".",
        );
      }
      const mid = s.mid + 1;
      const list = [{ id: mid, email: v, role: s.role }, ...s.members];
      const next = SUGGEST.find((x) => !list.some((m) => m.email === x)) || "";
      const before = s.done;
      const after = { ...before, invited: true };
      return sayDone(
        { ...s, mid, members: list, emErr: "", newN: s.newN + 1, done: after, email: next },
        "Invited " + v + " as " + withArticle(s.role) + ".",
        before,
        after,
      );
    }
  }
}

/* ── View model (the board's renderVals, minus closures and theme) ────── */

/** Parity flag that replays a CSS animation without remounting ('' before the first run). */
const par = (n: number): "" | "a" | "b" => (n ? (n % 2 ? "a" : "b") : "");

export function deriveView(s: State) {
  const a = ACCENTS[s.acc];
  const L = LOGOS[s.logo];

  /* Name and monogram */
  const name = s.company.trim() || "Your company";
  const words = name.split(/\s+/).filter(Boolean);
  const one = words[0].charAt(0).toUpperCase();
  const two =
    words.length > 1 ? (words[0].charAt(0) + words[1].charAt(0)).toUpperCase() : one + words[0].charAt(1).toLowerCase();
  const txt = L.two ? two : one;

  /* Domain */
  const host = normHost(s.domainRaw);
  const st = checkHost(host);
  const ok = st === "ok";
  const shownHost = ok ? host : "your domain";
  const isLive = s.step === 3;

  /* DNS records */
  const recHost = s.step > 0 ? s.dnsHost : ok ? host : "<your domain>";
  const txtName = "_markdrop-verify." + recHost;
  const recReady = s.step > 0 || ok;
  const txtVal = "markdrop-verify=" + (recReady ? tokenFor(recHost) : "…");
  const v1 = s.verifyT >= 700;
  const v2 = s.verifyT >= 1400;
  const copyBtn = (key: CopyKey, what: string) => ({ id: "ds-cp-" + key, ok: s.copied === key, aria: "Copy the " + what });

  const count = countDone(s.done);
  const finale = count === CHECKS.length;
  const gate = s.signin && s.viewAs === "visitor";

  return {
    playing: s.attract,
    ppText: s.attract ? "Pause demo" : "Play demo",
    brand: { base: a.base, inkLight: a.inkLight, inkDark: a.inkDark },

    company: s.company,
    domainRaw: s.domainRaw,
    dom: {
      invalid: !ok,
      hint: ok ? "Folders become paths: " + host + "/handbook" : DOMAIN_MSG[st as Exclude<HostStatus, "ok">],
    },

    accName: a.name,
    swatches: ACCENTS.map((x, i) => {
      const on = i === s.acc;
      return { id: "ds-sw-" + i, on, base: x.base, rip: on ? par(s.washN) : "", aria: x.name + " accent" };
    }),

    logoName: L.name,
    logos: LOGOS.map((x, i) => ({
      id: "ds-lg-" + i,
      on: i === s.logo,
      shape: x.id,
      txt: x.two ? two : one,
      aria: x.name + " logo",
    })),

    chromeOpts: (
      [
        { v: "full", t: "Full", sub: "Logo, name, folders" },
        { v: "none", t: "None", sub: "Just the document" },
      ] as const
    ).map((x) => ({ id: "ds-ch-" + x.v, v: x.v as Chrome, t: x.t, sub: x.sub, on: s.chrome === x.v })),

    signin: { on: s.signin, hint: s.signin ? "On: visitors sign in first" : "Off: visitors go straight in" },
    viewOpts: (
      [
        ["visitor", "Visitor"],
        ["member", "Member"],
      ] as const
    ).map(([v, t]) => ({ id: "ds-va-" + v, v: v as ViewAs, t, on: s.viewAs === v })),

    /* Preview */
    name,
    brandLogo: { shape: L.id, txt, pop: par(s.popN) },
    url: { host: shownHost, placeholder: !ok, live: isLive, st: isLive ? "Live" : "DNS pending" },
    drop: par(s.dropN),
    wash: par(s.washN),
    chromeFull: s.chrome === "full",
    showDoc: !gate,
    gate,
    gateLine: name + " asks visitors to sign in before reading on " + shownHost + ".",
    docBare: s.chrome === "none",
    card: {
      title: s.signin ? "Sign in · " + name : "Onboarding guide",
      desc: s.signin ? "Sign in to read this page." : "Welcome to " + name + ". Start with the setup checklist.",
      url: shownHost + "/handbook/onboarding",
    },

    /* DNS card */
    dns: {
      host: ok || s.step > 0 ? (s.step > 0 ? s.dnsHost : host) : "your domain",
      stepText: "Step " + (s.step + 1) + " of 4",
      fillPct: (s.step / 3) * 75,
      nodes: STEPS.map((t, i) => {
        const done = i < s.step || isLive;
        return { t, num: String(i + 1), done, cur: i === s.step && !isLive, live: isLive && i === 3 };
      }),
      step: s.step,
      noteBad: s.dnsBad && !ok,
      txtNote: s.dnsBad && !ok ? DOMAIN_MSG[st as Exclude<HostStatus, "ok">] : "Proves you own the domain.",
      txtName,
      txtVal,
      cnName: recHost,
      cnTarget: CNAME_TARGET,
      copy: {
        txtName: copyBtn("txtName", "TXT name"),
        txtVal: copyBtn("txtVal", "TXT value"),
        cnName: copyBtn("cnName", "CNAME name"),
        cnVal: copyBtn("cnVal", "CNAME target"),
      },
      v1: { ok: v1, t: v1 ? "found" : "checking" },
      v2: { ok: v2, t: v2 ? "found" : "checking" },
      pbPct: Math.min(100, Math.round((s.verifyT / VERIFY_MS) * 100)),
    },

    /* People */
    peopleN: 1 + s.members.length + (s.members.length ? " people" : " person"),
    ladder: ROLES.map((r, i) => ({ t: r, on: r === s.role, sep: i < ROLES.length - 1 })),
    email: s.email,
    em: {
      invalid: !!s.emErr,
      hint:
        s.emErr ||
        (s.members.length > 2 ? s.members.length + " invited. The newest two show here." : "Pick a role, then Invite or press Enter."),
    },
    roleOpts: INVITE_ROLES.map((r) => ({ id: "ds-role-" + r, v: r, t: cap(r), on: s.role === r })),
    members: [
      { key: "owner", av: initials(name), email: "You", role: "Owner", owner: true, anim: "" as "" | "a" | "b" },
      ...s.members.slice(0, 2).map((m, k) => ({
        key: "m" + m.id,
        av: initials(m.email),
        email: m.email,
        role: cap(m.role),
        owner: false,
        anim: k === 0 ? par(s.newN) : ("" as const),
      })),
    ],

    /* Checklist */
    finale,
    score: finale ? "Ready" : count + " of 5",
    segs: CHECKS.map((c) => s.done[c.k]),
    checks: CHECKS.map((c) => ({
      k: c.k,
      id: "ds-ck-" + c.k,
      t: c.t,
      on: s.done[c.k],
      aria: c.t + (s.done[c.k] ? ", done" : ", not done yet") + ". Go to it.",
    })),

    live: s.live,
  };
}

export type ViewModel = ReturnType<typeof deriveView>;

/** Avatar initials, as the design-system Avatar computes them. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");
}

/** Where a checklist chip sends focus (the current pick for accent and logo). */
export function checkTarget(s: State, k: CheckKey): string {
  if (k === "accent") return "ds-sw-" + s.acc;
  if (k === "logo") return "ds-lg-" + s.logo;
  return CHECKS.find((c) => c.k === k)!.target;
}
