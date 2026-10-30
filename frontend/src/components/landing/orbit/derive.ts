/**
 * deriveView = the boards' renderVals() without the closures (handlers are attached by the View from
 * the `on` dispatcher). Pure: the same state always draws the same picture.
 *
 * Animation classes are returned as semantic tokens ("ca" / "cb", "fa" / "fb", ...) that the View maps
 * to CSS-module classes. A counter of 0 means "no animation": the END state.
 */
import {
  ACH, COPY, DESKTOP, FILES, MOBILE, MOONS, PAD, PLAY_SC, TOTAL,
  mod, par, seatDeg, seatXY,
  type FeatId, type FileDef, type FileId, type Form, type Info, type MoonId, type ScreenId, type Tone, type ViewId,
} from "./data";
import { P2P_RELAY_LIVE } from "@/lib/marketingFlags";
import { armed as isArmed, countOf, fileOf, moonAt, nextFeat, nextFile, type State } from "./model";

/** Parity token for a one-shot replay, or "" when the counter is 0 (END state, no animation). */
export const flip = (n: number) => (n > 0 ? par(n) : "");

export interface MoonVM {
  id: MoonId; i: number; label: string; icon: string; cat: string;
  deg: number; x: number; y: number; s: number; op: number; z: number; fx: number; fy: number;
  fin: boolean; found: boolean; docked: boolean; next: boolean; front: boolean;
  pressed: boolean; aria: string;
}
export interface TileVM { id: FileId; i: number; name: string; mime: string; ext: string; tint: string; left: number; top: number; seen: boolean; cur: boolean; armed: boolean; pressed: boolean; aria: string }
export interface CardVM {
  /** The card shown: a view id, or "refusal" (Encrypt + a file). Used for analytics ids only. */
  id: string;
  eyebrow: string; title: string; line: string;
  req: string; tone: Tone; reqIcon: string;
  host: string; path: string; frag: string; hasLink: boolean;
  note: string; noteLink: Info["noteLink"] | null; warn: boolean; noteIcon: string;
  href: string; cta: string;
  isIntro: boolean; isFin: boolean; isCombo: boolean;
  icon: string; cat: string; anim: string;
}
export interface AchVM { id: string; icon: string; title: string; on: boolean; aria: string }

function card(s: State, view: ViewId, file: FileDef, combo: boolean): CardVM {
  const C = COPY[s.form];
  const isCombo = view === "render" && combo;
  const I = isCombo ? C.info.refusal : C.info[view] ?? C.info.intro;
  return {
    id: isCombo ? "refusal" : view,
    eyebrow: I.eyebrow, title: I.title,
    line: isCombo ? file.name + " still opens at its link. " + I.line : I.line,
    req: I.req ?? "", tone: I.tone ?? "neutral",
    reqIcon: I.req === "Workspaces" ? "globe" : I.req === "Free account" ? "user" : "check",
    host: I.host ?? "", path: view === "render" ? file.slug : I.path ?? "", frag: I.frag ?? "", hasLink: !!I.host,
    note: I.note ?? "", noteLink: I.noteLink ?? null, warn: isCombo,
    noteIcon: isCombo ? "alert" : view === "render" ? "lock" : "info",
    href: I.href || "/new", cta: I.cta || "Try it for real",
    isIntro: view === "intro", isFin: view === "finale", isCombo,
    icon: I.icon, cat: I.cat, anim: flip(s.cardN),
  };
}

function hintFor(s: State, fin: boolean, isCombo: boolean): string {
  const C = COPY[s.form];
  const count = countOf(s);
  const play = s.mode === "play";
  if (fin || isCombo) return "";
  if (isArmed(s)) return C.hintArmed;
  if (!play) return C.hintDemo;
  if (!s.found.render) return C.hintRender;
  if (!s.ach.encFile) return C.hintEncFile;
  if (P2P_RELAY_LIVE && s.found.send && !s.ach.relay) return C.hintRelay;
  if (count < TOTAL) return C.hintNext;
  if (!s.ach.files) return "Render all five file types.";
  return "";
}

function achs(s: State): AchVM[] {
  return ACH.map((a) => ({ id: a.id, icon: a.icon, title: a.title, on: !!s.ach[a.id], aria: (s.ach[a.id] ? "Earned: " : "Not earned yet: ") + a.title }));
}

function moons(s: State, form: Form, nextId: string, view: ViewId): MoonVM[] {
  const G = form === "mobile" ? MOBILE : DESKTOP;
  const fin = s.finale;
  const play = s.mode === "play";
  return MOONS.map((m, i) => {
    const u = i - s.rot;
    const deg = seatDeg(G, u);
    const [x, y] = seatXY(G, u);
    const c = Math.cos((deg * Math.PI) / 180);
    const fx = fin ? G.FIN_POS[i][0] - x : 0;
    const fy = fin ? G.FIN_POS[i][1] - y : 0;
    const front = mod(u, G.NS) === 0;
    const docked = front && !fin && (form === "mobile" ? view === m.id : s.dock === m.id);
    const found = !!s.found[m.id];
    const next = !fin && play && nextId === m.id && !docked;
    return {
      id: m.id, i, label: m.label, icon: m.icon, cat: m.cat,
      deg, x: x - G.CX, y: y - G.CY,
      s: form === "mobile" ? 0.82 + 0.09 * (1 + c) : 0.8 + 0.1 * (1 + c),
      op: form === "mobile" ? 0.66 + 0.17 * (1 + c) : 0.62 + 0.19 * (1 + c),
      z: fin ? 46 : Math.round(20 + 10 * c),
      fx, fy, fin, found, docked, next, front,
      pressed: view === m.id,
      aria: m.label + (found ? ", discovered" : ", not discovered yet") + (next ? ", next to find" : "") + (form === "mobile" && front ? ", in front" : ""),
    };
  });
}

function cons(s: State, form: Form) {
  const G = form === "mobile" ? MOBILE : DESKTOP;
  const fm = MOONS.map((m, i) => ({ m, i })).filter((o) => s.found[o.m.id]);
  const pts = fm.map((o) => { const p = seatXY(G, o.i - s.rot); return p[0].toFixed(1) + "," + p[1].toFixed(1); });
  if (fm.length >= 3) pts.push(pts[0]);
  return { show: !s.finale && fm.length >= 2, pts: pts.join(" "), anim: flip(s.consN) };
}

function tiles(s: State, form: Form, armed: boolean, view: ViewId, curOn: boolean): TileVM[] {
  const G = form === "mobile" ? MOBILE : DESKTOP;
  const half = form === "mobile" ? 22 : 26;
  return FILES.map((f, i) => {
    const cur = f.id === s.file && curOn;
    const x = G.TILE_X[i];
    return {
      id: f.id, i, name: f.name, mime: f.mime, ext: f.ext, tint: f.tint,
      left: x - half, top: G.tileTop(x), seen: !!s.seen[f.id], cur, armed,
      pressed: cur && view === "render",
      aria: (armed ? "Encrypt and share " : "Render ") + f.name + (s.seen[f.id] ? ", rendered before" : ""),
    };
  });
}

/* ── Desktop ──────────────────────────────────────────────────────────── */

export function deriveDesktop(s: State) {
  const G = DESKTOP;
  const C = COPY.desktop;
  const count = countOf(s);
  const fin = s.finale;
  const view: ViewId = fin ? "finale" : s.view;
  const file = fileOf(s.file);
  const play = s.mode === "play";
  const armed = isArmed(s);
  const nextF = nextFeat(s);
  const nextId = nextF ? nextF.id : "";
  const dragging = !!s.drag;
  const nfId = nextFile(s);
  const nfF = fileOf(nfId);
  const combo = s.combo && !fin;
  const tilesVM = tiles(s, "desktop", armed, view, true);

  const station = {
    next: !fin && play && nextId === "render",
    aria: "Artifact screen, showing " + file.name + ". " + (armed ? "Encrypt and share " : "Render ") + "the next file, " + nfF.name + ".",
    cap: (armed ? "Encrypt next: " : "Render next: ") + nfF.badge,
  };
  const band = armed ? { text: C.bandArmed, armed: true } : { text: "RENDER ANY FILE", armed: false };

  const fd = s.fileDelay;
  const pd = (fd + 0.62).toFixed(2) + "s";
  let pill = { path: file.slug, badge: file.badge, icon: file.bicon, tone: "neutral" as Tone };
  if (combo) pill = { path: file.slug, badge: "Password", icon: "lock", tone: "warning" };
  if (fin) pill = { path: "new", badge: "No account", icon: "check", tone: "success" };

  const from = s.from ?? { x: PAD[0], y: PAD[1] };
  const toSt = s.flyTo === "station";
  const dest = toSt ? [G.STATION[0], G.STATION[1] + 40] : G.FRONT;
  const qx = Math.round((from.x + G.FRONT[0]) / 2);
  const dfly = {
    anim: s.launch ? flip(s.launchN) : "",
    path: "path('M " + Math.round(from.x) + " " + Math.round(from.y) + " Q " + qx + " " + Math.round(Math.min(from.y, dest[1]) - 170) + " " + dest[0] + " " + dest[1] + "')",
  };
  const fileIdx = FILES.findIndex((f) => f.id === file.id);
  const fx = G.TILE_X[fileIdx];
  const ty0 = G.tileTop(fx) + 20;
  const ffly = {
    anim: fin ? "" : flip(s.fileN),
    path: "path('M " + fx + " " + ty0 + " Q " + fx + " 236 990 300')",
    fd: fd + "s",
    file,
  };

  /* Route preview: hovering or focusing the drop draws where it will go. */
  let aimT: number[] | null = null; let aimF: number[] = PAD; let aimR = 40; let tgt = false;
  const at = s.aimAt;
  if (at && !fin && !dragging) {
    tgt = true;
    if (at.k === "moon") aimT = seatXY(G, MOONS.findIndex((m) => m.id === at.id) - s.rot);
    else {
      const tf = fileOf(at.k === "file" ? at.id : nfId);
      const tx = G.TILE_X[FILES.findIndex((f) => f.id === tf.id)];
      aimF = [tx, G.tileTop(tx) + 10]; aimT = G.STATION; aimR = 30;
    }
  } else if (s.aim && !fin && !dragging && nextId) {
    aimT = nextId === "render" ? G.STATION : seatXY(G, MOONS.findIndex((m) => m.id === nextId) - s.rot);
    aimR = nextId === "render" ? 30 : 40;
  }
  const aim = aimT
    ? {
      show: true, tgt,
      d: "M " + Math.round(aimF[0]) + " " + Math.round(aimF[1]) + " Q " + Math.round((aimF[0] + aimT[0]) / 2) + " " + Math.round(Math.min(aimF[1], aimT[1]) - (aimF === PAD ? 150 : 60)) + " " + Math.round(aimT[0]) + " " + Math.round(aimT[1]),
      x: Math.round(aimT[0]), y: Math.round(aimT[1]), r: aimR,
    }
    : { show: false, tgt: false, d: "", x: 0, y: 0, r: 0 };

  const relay = P2P_RELAY_LIVE && s.relay;
  const sd = relay ? "M 158 108 C 200 18, 340 18, 382 108" : "M 158 108 L 382 108";
  const send = { relay, d: sd, path: "path('" + sd + "')", route: (relay ? "relay" : "direct") as "relay" | "direct", btn: relay ? "Show the direct path" : "Show the relay path" };

  const cardVM = card(s, view, file, combo);
  const hint = hintFor(s, fin, cardVM.isCombo);

  const pips = C.feats.map((f) => ({
    id: f.id as FeatId, label: f.label, quest: f.quest, cat: f.cat,
    found: !!s.found[f.id], on: view === f.id, star: f.id === "render",
    aria: f.label + ": " + f.quest + (s.found[f.id] ? ", discovered" : ", not discovered yet"),
  }));

  const carry = {
    anim: flip(s.carryN),
    icon: !nextF ? "checkCircle" : nextId === "render" ? nfF.bicon : nextF.icon,
    text: !nextF ? "Finale" : nextId === "render" ? nfF.badge : nextF.label,
  };

  return {
    form: "desktop" as const,
    paused: s.paused, fin, dragging,
    card: cardVM, hint,
    connDot: flip(s.cardN),
    stageLabel: "Orbit playground, " + count + " of " + TOTAL + " discovered. The drop flies to the next feature. Arrow keys move between moons or between files; Enter picks.",
    cons: cons(s, "desktop"),
    pd, file, combo, pill, pk: flip(s.fileN), band, station,
    tiles: tilesVM, moons: moons(s, "desktop", nextId, view),
    dock: s.dock, dioN: s.dioN, send,
    dfly, dockRip: s.launch && !toSt ? flip(s.launchN) : "", ffly, aim,
    padLabel: nextF ? "Launch the drop to the next feature: " + nextF.label + ". " + nextF.quest + ". You can also drag it onto a moon, a file or the screen." : "All " + TOTAL + " found. Replay the finale.",
    padNext: nextF ? "Next: " + nextF.quest : "All " + TOTAL + " found. Click for the finale.",
    carry,
    padDrop: s.launch ? flip(s.launchN) : "",
    ghost: s.drag,
    ppText: s.paused ? "Play" : "Pause",
    ppAria: s.paused ? "Play the demo and ambient motion" : "Pause the demo and ambient motion",
    count, pips, achs: achs(s),
    announce: s.announce,
  };
}
export type DesktopVM = ReturnType<typeof deriveDesktop>;

/* ── Mobile ───────────────────────────────────────────────────────────── */

export function deriveMobile(s: State) {
  const G = MOBILE;
  const C = COPY.mobile;
  const count = countOf(s);
  const fin = s.finale;
  const view: ViewId = fin ? "finale" : s.view;
  const file = fileOf(s.file);
  const play = s.mode === "play";
  const armed = isArmed(s);
  const nextF = nextFeat(s);
  const nextId = nextF ? nextF.id : "";
  const isPlay = s.layout === "play";
  const sheetOpen = isPlay && s.sheet;
  const sc = sheetOpen ? PLAY_SC : 1;
  const combo = s.combo && !fin;
  const onScreen = FILES.find((f) => f.id === s.screen) ?? null;
  const nfId = nextFile(s);
  const nfF = fileOf(nfId);

  const station = {
    next: !fin && play && nextId === "render",
    aria: "Artifact screen, showing " + (onScreen ? onScreen.name : (MOONS.find((m) => m.id === s.screen) ?? MOONS[0]).label) + ". Tap to " + (armed ? "encrypt and share " : "render ") + "the next file, " + nfF.name + ". Swipe it to flip file types.",
    cap: (armed ? "Encrypt next: " : "Render next: ") + nfF.badge,
  };
  const band = armed ? { text: C.bandArmed, armed: true } : { text: "RENDER ANY FILE", armed: false };

  let pill: { host: string; path: string; frag: string; badge: string; icon: string; tone: Tone };
  if (fin) pill = { host: "markdrop.in/", path: "new", frag: "", badge: "No account", icon: "check", tone: "success" };
  else if (onScreen) pill = { host: "markdrop.in/", path: onScreen.slug, frag: "", badge: combo ? "Password" : onScreen.badge, icon: combo ? "lock" : onScreen.bicon, tone: combo ? "warning" : "neutral" };
  else {
    const mm = MOONS.find((m) => m.id === s.screen) ?? MOONS[0];
    pill = { frag: "", ...mm.pill };
    if (s.screen === "send" && P2P_RELAY_LIVE && s.relay) Object.assign(pill, { badge: "Relay", icon: "wave", tone: "info" });
  }

  const relay = P2P_RELAY_LIVE && s.relay;
  const sd = relay ? "M 118 100 C 140 8, 220 8, 242 100" : "M 118 100 L 242 100";
  const send = { relay, d: sd, path: "path('" + sd + "')", route: (relay ? "relay" : "direct") as "relay" | "direct" };

  /* The courier's flight, in stage-local px: from the courier (in the HUD, the sheet or the peek, all
     below the stage) to the front seat or the screen. The stage itself is scaled while the sheet is
     open, so the start point is mapped back through that scale. */
  const from = !isPlay ? [268, 372] : sheetOpen ? [286, 695] : [264, 550];
  const dest = s.flyTo === "station" ? [G.STATION[0], G.STATION[1] + 30] : G.FRONT;
  const dfly = {
    anim: s.launch ? flip(s.launchN) : "",
    path: "path('M " + from[0] + " " + from[1] + " Q " + Math.round((from[0] + dest[0]) / 2) + " " + Math.round(Math.min(from[1], dest[1]) - 110) + " " + Math.round(dest[0]) + " " + Math.round(dest[1]) + "')",
  };
  const fileIdx = FILES.findIndex((f) => f.id === file.id);
  const fx = G.TILE_X[fileIdx];
  const ty0 = G.tileTop(fx) + 18;
  const ffly = {
    anim: s.fileFly && !fin ? flip(s.fileN) : "",
    path: "path('M " + fx + " " + ty0 + " Q " + fx + " 110 195 96')",
    fd: s.fd + "s",
    file,
  };

  /* Caption: the nameplate under the front seat. In the first beat it carries the document half. */
  const vf = C.feats.find((f) => f.id === view);
  let cap: { icon: string; cat: string; label: string; sep: string; tail: string; mono: boolean };
  if (fin) cap = { icon: "checkCircle", cat: "var(--success)", label: "All " + TOTAL + " found", sep: "·", tail: "markdrop.in/new", mono: true };
  else if (view === "intro") cap = { icon: "lines", cat: "var(--cat-document)", label: "release-notes.md", sep: "→", tail: "markdrop.in/release-notes", mono: true };
  else if (view === "render") cap = { icon: combo ? "lock" : file.bicon, cat: "var(--cat-artifact)", label: combo ? "Password instead" : file.badge, sep: "·", tail: "Free account", mono: false };
  else if (vf) cap = { icon: vf.id === "send" ? "arrowRight" : vf.icon, cat: vf.cat, label: vf.label, sep: "·", tail: vf.req ?? "", mono: false };
  else cap = { icon: "link", cat: "var(--accent-text)", label: "Tap anything", sep: "·", tail: "swipe to spin", mono: false };
  const pm = MOONS[moonAt(s, -1)];
  const nm = MOONS[moonAt(s, 1)];

  const cardVM = card(s, view, file, combo);
  const hint = hintFor(s, fin, cardVM.isCombo);
  const heroHint = !play ? "Demo playing. Tap to play." : count < TOTAL ? "Swipe to spin the orbit." : "All " + TOTAL + " found.";

  const stamps = C.feats.map((f, i) => ({
    id: f.id as FeatId, n: i + 1, icon: f.icon, cat: f.cat,
    got: !!s.found[f.id], on: view === f.id, big: f.id === "render",
    aria: f.label + ": " + f.quest + (s.found[f.id] ? ", discovered" : ", not discovered yet"),
  }));

  return {
    form: "mobile" as const,
    paused: s.paused, fin, isPlay, isHero: !isPlay, sheetOpen, sc, heroAnim: flip(s.heroN),
    stageLabel: "Orbit playground, " + count + " of " + TOTAL + " discovered. Swipe or use the arrow buttons to spin the orbit. Tap a moon, a file or the screen. Arrow keys move between moons or between files; Enter picks.",
    cons: cons(s, "mobile"), band, station,
    screen: s.screen as ScreenId, screenN: s.screenN, paneAnim: flip(s.screenN), pd: s.pd.toFixed(2) + "s", combo,
    pill, pk: flip(s.screenN), send,
    tiles: tiles(s, "mobile", armed, view, !!onScreen), moons: moons(s, "mobile", nextId, view),
    ffly, dockRip: s.launch && s.flyTo !== "station" ? flip(s.launchN) : "", dfly,
    courDrop: s.launch ? flip(s.launchN) : "",
    cap: { ...cap, anim: flip(s.cardN) },
    prevAria: "Spin the orbit back: " + pm.label,
    nextAria: "Spin the orbit on: " + nm.label,
    ppAria: s.paused ? "Play the demo and ambient motion" : "Pause the demo and ambient motion",
    count, heroHint, hint, sheetHint: !!hint && !cardVM.note && !cardVM.isIntro,
    carry: { kicker: nextF ? "Next" : "Done", text: !nextF ? "Finale" : nextId === "render" ? nfF.badge : nextF.label },
    courierAria: nextF ? "Send the drop to the next feature: " + nextF.label + ". " + nextF.quest + "." : "All " + TOTAL + " found. Replay the finale.",
    stamps, achs: achs(s),
    showPeek: isPlay && !s.sheet,
    card: cardVM,
    showTry: view !== "finale" && !cardVM.isCombo,
    showRelay: P2P_RELAY_LIVE && view === "send",
    showCourier: view !== "finale",
    openAria: "Show details: " + cardVM.title,
    relayPressed: relay,
    relayAria: relay ? "Show the direct path" : "Show the relay path",
    announce: s.announce,
  };
}
export type MobileVM = ReturnType<typeof deriveMobile>;
