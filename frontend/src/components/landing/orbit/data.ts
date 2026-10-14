/**
 * Orbit hero data, ported verbatim from the approved boards:
 *   desktop  design/revamp-canvas/PlayFinal.dc.html        (frame 1440 x 1000)
 *   mobile   design/revamp-canvas/PlayFinalMobile.dc.html  (stage 390 x 344)
 * The two boards' INFO / FEATS / hints differ on purpose (mobile is shorter); both sets live here as
 * COPY.desktop / COPY.mobile and are selected by layout. Never merge them by hand.
 *
 * Honesty gates (flags.ts) are applied here, once, so the model and the view never see relay copy
 * while the relay is not confirmed live.
 */
import { P2P_RELAY_LIVE } from "@/lib/marketingFlags";
import { VSCODE_URL } from "./flags";

export type Form = "desktop" | "mobile";
export type MoonId = "publish" | "encrypt" | "sync" | "send" | "domain" | "builder";
export type FeatId = MoonId | "render";
export type FileId = "html" | "pdf" | "xlsx" | "mp4" | "zip";
export type ViewId = FeatId | "intro" | "finale";
export type ScreenId = FileId | MoonId;
export type AchId = "files" | "encFile" | "relay";
export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export const TICK = 100;

/* ── Geometry ─────────────────────────────────────────────────────────── */

export interface Geo {
  CX: number; CY: number; RX: number; RY: number;
  SEATS: number[];
  NS: number; GAP: number;
  FRONT: [number, number];
  STATION: [number, number];
  BEAT_MS: number; IDLE_MS: number; FIN_MS: number;
  FIN_POS: Array<[number, number]>;
  /** Rack tile x centres, in FILES order. */
  TILE_X: number[];
  tileTop: (x: number) => number;
}

/** Desktop frame px (the 1440 x 1000 board). Seat 3.5 (behind the screen) is never a seat. */
export const DESKTOP: Geo = {
  CX: 990, CY: 390, RX: 372, RY: 150,
  SEATS: [0, 47, 93, 140, 220, 267, 313],
  NS: 7, GAP: 6,
  FRONT: [990, 540],
  STATION: [990, 309],
  BEAT_MS: 4200, IDLE_MS: 20000, FIN_MS: 3800,
  FIN_POS: [[800, 180], [1180, 180], [1180, 340], [1180, 500], [800, 500], [800, 340]],
  TILE_X: [870, 930, 990, 1050, 1110],
  /* Top of a rack tile so its foot sits on the disc's front edge (disc centre 990,410, radii 220 by 70). */
  tileTop: (x) => { const dx = (x - 990) / 220; return Math.round(410 + 70 * Math.sqrt(1 - dx * dx) - 4 - 62); },
};
export const PAD: [number, number] = [1327, 750];

/** Mobile stage px (390 x 344). The back seats (120, 240) sit beside the screen, never behind it. */
export const MOBILE: Geo = {
  CX: 195, CY: 192, RX: 164, RY: 78,
  SEATS: [0, 40, 80, 120, 240, 280, 320],
  NS: 7, GAP: 6,
  FRONT: [195, 270],
  STATION: [195, 99],
  BEAT_MS: 4000, IDLE_MS: 20000, FIN_MS: 3600,
  FIN_POS: [[95, 30], [295, 30], [295, 104], [295, 178], [95, 178], [95, 104]],
  TILE_X: [101, 148, 195, 242, 289],
  /* Top of a rack tile so its foot sits on the disc front edge (disc centre 195,186, radii 124 by 40). */
  tileTop: (x) => { const dx = (x - 195) / 124; return Math.round(186 + 40 * Math.sqrt(Math.max(0, 1 - dx * dx)) - 4 - 54); },
};
export const PLAY_SC = 0.8;

export const geo = (form: Form): Geo => (form === "mobile" ? MOBILE : DESKTOP);

export const mod = (a: number, n: number) => ((a % n) + n) % n;
/** The a/b parity flip that replays a CSS animation without remounting. */
export const par = (n: number) => (mod(n, 2) ? "a" : "b");
export const seatDeg = (g: Geo, u: number) => 360 * Math.floor(u / g.NS) + g.SEATS[mod(u, g.NS)];
export const seatXY = (g: Geo, u: number): [number, number] => {
  const r = (seatDeg(g, u) * Math.PI) / 180;
  return [g.CX + g.RX * Math.sin(r), g.CY + g.RY * Math.cos(r)];
};

/* ── Moons, files, features ───────────────────────────────────────────── */

export interface Pill { host: string; path: string; frag?: string; badge: string; icon: string; tone: Tone }
export interface Moon { id: MoonId; label: string; icon: string; cat: string; pill: Pill }

/** Six moons in orbit order. Render any file is not a moon: it is the planet itself. */
export const MOONS: Moon[] = [
  { id: "publish", label: "Publish", icon: "lines", cat: "var(--cat-document)", pill: { host: "markdrop.in/", path: "release-notes", badge: "Page", icon: "lines", tone: "neutral" } },
  { id: "encrypt", label: "Encrypt", icon: "lock", cat: "var(--accent-text)", pill: { host: "markdrop.in/", path: "plan", frag: "#k=7Qx2…", badge: "Encrypted", icon: "lock", tone: "info" } },
  { id: "sync", label: "VS Code sync", icon: "vscode", cat: "var(--cat-sync)", pill: { host: "markdrop.in/", path: "release-notes", badge: "Synced", icon: "check", tone: "success" } },
  { id: "send", label: "Send a file", icon: "send", cat: "var(--cat-share)", pill: { host: "markdrop.in/", path: "share/7fK2q", badge: "Direct", icon: "arrowRight", tone: "neutral" } },
  { id: "domain", label: "Your domain", icon: "globe", cat: "var(--text-secondary)", pill: { host: "docs.example.com/", path: "guides/onboarding", badge: "", icon: "globe", tone: "neutral" } },
  { id: "builder", label: "README builder", icon: "builder", cat: "var(--cat-builder)", pill: { host: "markdrop.in/", path: "my-project", badge: "README", icon: "builder", tone: "neutral" } },
];

export interface FileDef { id: FileId; ext: string; name: string; mime: string; slug: string; badge: string; bicon: string; tint: string }
export const FILES: FileDef[] = [
  { id: "html", ext: "HTML", name: "launch-page.html", mime: "text/html", slug: "launch-page", badge: "HTML page", bicon: "code", tint: "var(--cat-sync)" },
  { id: "pdf", ext: "PDF", name: "q3-report.pdf", mime: "application/pdf", slug: "q3-report", badge: "PDF", bicon: "doc", tint: "var(--danger)" },
  { id: "xlsx", ext: "XLSX", name: "q3-budget.xlsx", mime: "application/vnd.ms-excel", slug: "q3-budget", badge: "Spreadsheet", bicon: "table", tint: "var(--success)" },
  { id: "mp4", ext: "MP4", name: "product-demo.mp4", mime: "video/mp4", slug: "product-demo", badge: "Video", bicon: "film", tint: "var(--cat-share)" },
  { id: "zip", ext: "ZIP", name: "docs-site.zip", mime: "application/zip", slug: "docs-site", badge: "Zipped site", bicon: "archive", tint: "var(--cat-artifact)" },
];
export const SCREENS: ScreenId[] = ["html", "pdf", "xlsx", "mp4", "zip", "publish", "encrypt", "sync", "send", "domain", "builder"];

export interface Feat { id: FeatId; label: string; cat: string; quest: string; icon: string; req?: string }
/** The seven features, each with the job it does for you. Only the mobile set carries `req`. */
const FEATS_DESKTOP: Feat[] = [
  { id: "publish", label: "Publish", cat: "var(--cat-document)", quest: "Turn notes into a page", icon: "lines" },
  { id: "render", label: "Render any file", cat: "var(--cat-artifact)", quest: "Open a PDF without downloading it", icon: "archive" },
  { id: "encrypt", label: "Encrypt", cat: "var(--accent-text)", quest: "Lock a document with a key in its link", icon: "lock" },
  { id: "sync", label: "VS Code sync", cat: "var(--cat-sync)", quest: "Publish straight from VS Code", icon: "code" },
  { id: "send", label: "Send a file", cat: "var(--cat-share)", quest: "Send photos to your phone", icon: "arrowRight" },
  { id: "domain", label: "Your domain", cat: "var(--text-secondary)", quest: "Put docs on your own domain", icon: "globe" },
  { id: "builder", label: "README builder", cat: "var(--cat-builder)", quest: "Build a README from blocks", icon: "builder" },
];
const FEATS_MOBILE: Feat[] = [
  { id: "publish", label: "Publish", cat: "var(--cat-document)", quest: "Turn notes into a page", icon: "lines", req: "No account" },
  { id: "render", label: "Render any file", cat: "var(--cat-artifact)", quest: "Open a PDF without downloading it", icon: "archive", req: "Free account" },
  { id: "encrypt", label: "Encrypt", cat: "var(--accent-text)", quest: "Lock a document with a key in its link", icon: "lock", req: "No account" },
  { id: "sync", label: "VS Code sync", cat: "var(--cat-sync)", quest: "Publish straight from VS Code", icon: "code", req: "Free account" },
  { id: "send", label: "Send a file", cat: "var(--cat-share)", quest: "Send photos to your phone", icon: "send", req: "No account" },
  { id: "domain", label: "Your domain", cat: "var(--text-secondary)", quest: "Put docs on your own domain", icon: "globe", req: "Workspaces" },
  { id: "builder", label: "README builder", cat: "var(--cat-builder)", quest: "Build a README from blocks", icon: "builder", req: "No account" },
];

/** Attract mode: both halves of the promise in the first beat, files every other beat after. */
export interface Beat { moon?: MoonId; file?: FileId; intro?: boolean }
export const BEATS: Beat[] = [
  { moon: "publish", file: "html", intro: true },
  { file: "pdf" },
  { moon: "encrypt" },
  { file: "xlsx" },
  { moon: "sync" },
  { file: "mp4" },
  { moon: "send" },
  { file: "zip" },
  { moon: "domain" },
  { moon: "builder" },
];

/* ── Info cards ───────────────────────────────────────────────────────── */

export interface Info {
  eyebrow: string; title: string; line: string;
  req?: string; tone?: Tone;
  host?: string; path?: string; frag?: string;
  note?: string;
  /** A trailing link inside the note (the P2P disclosure). */
  noteLink?: { text: string; href: string };
  icon: string; cat: string; href: string; cta?: string;
}
type InfoId = ViewId | "refusal";

/* The Send disclosure (REVAMP_BUILD 5.H.6, D6). Same text in both layouts. While the relay is live
   (P2P_RELAY_LIVE), the board's relay sentence goes before it; flipped off, every relay word is gone. */
const RELAY_SENTENCE = "If a network blocks a direct path, an encrypted relay forwards bytes it cannot read. ";
const SEND_NOTE = (P2P_RELAY_LIVE ? RELAY_SENTENCE : "") + "Encrypted device to device. Files are never stored on our servers. Markdrop keeps file details and connection info — ";
const SEND_NOTE_LINK = { text: "see what we record", href: "/share#what-we-record" };

const INFO_DESKTOP: Record<InfoId, Info> = {
  intro: { eyebrow: "How it works", title: "Two ways in. One link out.", line: "Write a document or upload a file. Either way you get a link that opens as a page in any browser.", icon: "link", cat: "var(--accent-text)", href: "/new" },
  publish: { eyebrow: "Documents", title: "Paste markdown, get a page", line: "Notes, docs and AI write-ups: headings, tables, code, Mermaid diagrams and math render at a link you can name.", req: "No account", tone: "success", host: "markdrop.in/", path: "release-notes", note: "Add a password, an expiry or view counts. Edit it later and open pages refresh.", icon: "lines", cat: "var(--cat-document)", href: "/new" },
  render: { eyebrow: "Artifacts", title: "Upload a file. It opens as a page.", line: "HTML pages, PDFs, spreadsheets, Word docs, video and zipped sites render in the browser from a sandboxed domain. No download, no app.", req: "Free account", tone: "info", host: "markdrop.in/", note: "Files are protected with a password or an access level, not end-to-end encryption.", icon: "archive", cat: "var(--cat-artifact)", href: "/upload" },
  refusal: { eyebrow: "Honest answer", title: "Encryption is for documents", line: "Files get a password or an access level instead.", req: "Free account", tone: "info", host: "markdrop.in/", note: "End-to-end encryption covers documents you write or paste. The Password badge on the screen shows what a file gets instead.", icon: "alert", cat: "var(--warning)", href: "/upload" },
  encrypt: { eyebrow: "End-to-end encryption", title: "The key lives in the link", line: "Turn it on and the document is sealed with AES-256-GCM in your browser. Markdrop stores ciphertext it has no key for.", req: "No account", tone: "success", host: "markdrop.in/", path: "plan", frag: "#k=7Qx2…", note: "Browsers never send the part after the # to a server. Encryption is for documents.", icon: "lock", cat: "var(--accent-text)", href: "/new?encrypt=1" },
  sync: { eyebrow: "VS Code extension", title: "Save in VS Code. The page updates.", line: "Publish from the editor and sync both ways: edit the page on the web and the file on your disk follows.", req: "Free account", tone: "info", host: "markdrop.in/", path: "release-notes", note: "", icon: "vscode", cat: "var(--cat-sync)", href: VSCODE_URL },
  send: { eyebrow: "Device to device", title: "Send files straight to a device", line: "Share one link or QR code with up to 10 people. From a terminal: markdrop send and markdrop get.", req: "No account", tone: "success", host: "markdrop.in/", path: "share/7fK2q", note: SEND_NOTE, noteLink: SEND_NOTE_LINK, icon: "send", cat: "var(--cat-share)", href: "/share", cta: "Send a file" },
  domain: { eyebrow: "Workspaces", title: "Publish under your own domain", line: "Run a workspace on docs.example.com with your logo, accent and name. Folders become URL paths.", req: "Workspaces", tone: "neutral", host: "docs.example.com/", path: "guides/onboarding", note: "Each page can be private, workspace only, shared with named people or open to anyone with the link.", icon: "globe", cat: "var(--text-secondary)", href: "/enterprise" },
  builder: { eyebrow: "README builder", title: "Build a README from blocks", line: "Drag in ready-made sections, diagrams and math included, then publish it as a page or export it to PDF.", req: "No account", tone: "success", host: "markdrop.in/", path: "my-project", note: "", icon: "builder", cat: "var(--cat-builder)", href: "/builder" },
  finale: { eyebrow: "7 of 7 discovered", title: "You found all seven", line: "Documents you write and files you upload end the same way: one link that opens in any browser. Start with a document; it needs no account.", host: "markdrop.in/", path: "new", icon: "checkCircle", cat: "var(--success)", href: "/new" },
};

const INFO_MOBILE: Record<InfoId, Info> = {
  intro: INFO_DESKTOP.intro,
  publish: { ...INFO_DESKTOP.publish, line: "Notes, docs and AI write-ups: tables, code, Mermaid diagrams and math render at a link you can name." },
  render: { ...INFO_DESKTOP.render, line: "HTML pages, PDFs, spreadsheets, Word docs, video and zipped sites render in the browser. No download, no app.", note: "Files get a password or an access level, not end-to-end encryption." },
  refusal: { ...INFO_DESKTOP.refusal, note: "End-to-end encryption covers documents you write or paste." },
  encrypt: { ...INFO_DESKTOP.encrypt, note: "Browsers never send the part after the # to a server." },
  sync: INFO_DESKTOP.sync,
  send: { ...INFO_DESKTOP.send, line: "One link or QR code, up to 10 people. In a terminal: markdrop send and markdrop get." },
  domain: INFO_DESKTOP.domain,
  builder: INFO_DESKTOP.builder,
  finale: INFO_DESKTOP.finale,
};

export interface Ach { id: AchId; icon: string; title: string }
const ACH_ALL: Ach[] = [
  { id: "files", icon: "archive", title: "Rendered all five file types" },
  { id: "encFile", icon: "lock", title: "Read the fine print: asked to encrypt a file" },
  { id: "relay", icon: "wave", title: "Found the relay" },
];
export const ACH: Ach[] = P2P_RELAY_LIVE ? ACH_ALL : ACH_ALL.filter((a) => a.id !== "relay");

export interface Copy {
  feats: Feat[];
  info: Record<InfoId, Info>;
  /* Hints and labels whose wording differs by input (click vs tap). */
  hintArmed: string; hintDemo: string; hintRender: string; hintEncFile: string; hintRelay: string; hintNext: string;
  encryptOn: string; bandArmed: string; encryptCta: string;
}
export const COPY: Record<Form, Copy> = {
  desktop: {
    feats: FEATS_DESKTOP,
    info: INFO_DESKTOP,
    hintArmed: "Encrypt is on. Pick a file on the planet to see what happens.",
    hintDemo: "Demo playing. Click the screen, a file or a moon to take over.",
    hintRender: "Click the screen or a file to render it.",
    hintEncFile: "Try encrypting a PDF: open Encrypt, then pick PDF.",
    hintRelay: P2P_RELAY_LIVE ? "In Send, show the relay path." : "",
    hintNext: "Click the drop to fly to the next feature.",
    encryptOn: " Encrypt is on: pick a file to see what happens.",
    bandArmed: "ENCRYPT ON · PICK A FILE",
    encryptCta: "Encrypt a document instead",
  },
  mobile: {
    feats: FEATS_MOBILE,
    info: INFO_MOBILE,
    hintArmed: "Encrypt is on. Tap a file on the planet to see what happens.",
    hintDemo: "Demo playing. Tap a moon, a file or the screen to take over.",
    hintRender: "Tap the screen or a file to render it.",
    hintEncFile: "Try encrypting a PDF: open Encrypt, then tap PDF.",
    hintRelay: P2P_RELAY_LIVE ? "In Send a file, show the relay path." : "",
    hintNext: "Tap the drop to fly to the next feature.",
    encryptOn: " Encrypt is on: tap a file to see what happens.",
    bandArmed: "ENCRYPT ON · TAP A FILE",
    encryptCta: "Encrypt a doc",
  },
};

/* ── Static decor (seeded, so the server and the client draw the same sky) ── */

export interface Star { g: string; x: number; y: number; fs: number; op: number; tw: boolean; delay: number }
/* Desktop: kept off the planet, the diorama, the pad and the lead line. Same LCG and draw order as
   the board, so the sky matches it exactly. */
export const STARS_DESKTOP: Star[] = (() => {
  let seed = 20261013;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const G = ["+", "·", "*", "#", "·", ">", "/", "~", "`", "·", "-", "+", "·", "|"];
  const out: Star[] = [];
  let tries = 0;
  while (out.length < 36 && tries < 3000) {
    tries++;
    const x = Math.round(600 + rnd() * 820);
    const y = Math.round(84 + rnd() * 800);
    const g = G[Math.floor(rnd() * G.length)];
    const fs = 11 + Math.floor(rnd() * 4);
    const op = +(0.16 + rnd() * 0.3).toFixed(2);
    const tw = rnd() < 0.3;
    if (x > 740 && x < 1240 && y > 160 && y < 560) continue;
    if (x > 730 && x < 1250 && y > 570 && y < 870) continue;
    if (x > 1230 && y > 680) continue;
    if (x < 760 && y > 640) continue;
    out.push({ g, x, y, fs, op, tw, delay: tw ? +(rnd() * 7).toFixed(2) : 0 });
  }
  return out;
})();

/* Mobile: kept off the planet and the caption row. Glyphs are at least 11px (the type floor). */
export const STARS_MOBILE: Star[] = (() => {
  let seed = 20261013;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const G = ["+", "·", "*", "#", "·", ">", "/", "~", "`", "·", "-", "+", "·", "|"];
  const out: Star[] = [];
  let tries = 0;
  while (out.length < 18 && tries < 2000) {
    tries++;
    const x = Math.round(6 + rnd() * 372);
    const y = Math.round(4 + rnd() * 286);
    const g = G[Math.floor(rnd() * G.length)];
    const fs = 10 + Math.floor(rnd() * 4);
    const op = +(0.16 + rnd() * 0.3).toFixed(2);
    const tw = rnd() < 0.3;
    if (x > 56 && x < 334 && y < 250) continue;
    out.push({ g, x, y, fs: Math.max(11, fs), op, tw, delay: tw ? +(rnd() * 7).toFixed(2) : 0 });
  }
  return out;
})();

export const GLYPHS_DESKTOP = ["#", "**", ">", "$$", "```", "- [x]", "|--|"].map((g, i) => ({ g, o: i * 14 + 5 }));
export const GLYPHS_MOBILE = ["#", "**", ">", "$$", "```"].map((g, i) => ({ g, o: i * 20 + 5 }));
export const BURST = Array.from({ length: 14 }, (_, i) => ({
  c: i % 4,
  a: Math.round((i * 360) / 14 + (i % 2) * 9),
  d: 96 + (i % 3) * 22,
  dl: +(2.4 + (i % 5) * 0.05).toFixed(2),
}));
