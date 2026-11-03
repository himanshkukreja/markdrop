"use client";

/**
 * Who's viewing (backend services/viewers.py, over the document's live socket).
 *
 * The page's socket (useDocumentViewer, ArtifactView) hands itself to a PresenceChannel when it
 * opens. The channel says hello (this tab's random nonce, the signed-in reader's presence ticket,
 * "Show me as anonymous"), pings every 15 s, says when the tab is hidden or shown, and reports the
 * section being read, at most every 2 s. The server decides who appears by name; nothing here
 * ever sends a name.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export type PresenceSection =
  | { h: string; label: string }
  | { p: number; label: string }
  | { s: number; label: string }
  | { label: string };

export interface PresenceViewer {
  /** Opaque per-connection id (never an account id). */
  id: string;
  /** Named viewers only: owner, workspace member, or shared with by email. */
  name?: string;
  pic?: string;
  owner?: boolean;
  /** Anonymous viewers: "Otter", "Fox"… */
  animal?: string;
  /** 0–5: --chart-1…6. */
  color: number;
  state: "active" | "away";
  sec: PresenceSection | null;
}

export interface PresenceSnapshot {
  on: boolean;
  /** End-to-end encrypted: a count only, never names or sections. */
  countOnly: boolean;
  total: number;
  viewers: PresenceViewer[];
  you: string | null;
  me: PresenceViewer | null;
}

/** What the page reports as "where I am". */
export type SectionRef = { h: string } | { p: number } | { s: number } | null;

const HEARTBEAT_MS = 15_000;
const SECTION_MS = 2_000;
const ANON_KEY = "md_presence_anon";
const NONCE_KEY = "md_presence_tab";

// ── Names and colours ─────────────────────────────────────────────────────────

const EMOJI: Record<string, string> = {
  Otter: "🦦", Fox: "🦊", Owl: "🦉", Panda: "🐼", Koala: "🐨", Tiger: "🐯", Lion: "🦁", Rabbit: "🐰",
  Hedgehog: "🦔", Penguin: "🐧", Dolphin: "🐬", Whale: "🐳", Octopus: "🐙", Turtle: "🐢", Frog: "🐸",
  Badger: "🦡", Raccoon: "🦝", Llama: "🦙", Sloth: "🦥", Flamingo: "🦩", Parrot: "🦜", Swan: "🦢",
  Eagle: "🦅", Duck: "🦆", Bee: "🐝", Butterfly: "🦋", Ladybug: "🐞", Crab: "🦀", Seal: "🦭",
  Squirrel: "🐿️", Zebra: "🦓", Giraffe: "🦒", Kangaroo: "🦘", Hippo: "🦛", Camel: "🐫", Elephant: "🐘",
  Bear: "🐻", Wolf: "🐺", Monkey: "🐵", Deer: "🦌", Bison: "🦬", Beaver: "🦫", Shark: "🦈",
  Lobster: "🦞", Snail: "🐌", Peacock: "🦚", Hamster: "🐹", Unicorn: "🦄", Dodo: "🦤", Mammoth: "🦣",
  Chick: "🐤", Bat: "🦇", Boar: "🐗", Gorilla: "🦍", Orangutan: "🦧", Skunk: "🦨", Moose: "🫎",
  Rhino: "🦏", Lizard: "🦎", Shrimp: "🦐",
};

export function viewerName(v: Pick<PresenceViewer, "name" | "animal">): string {
  return v.name ?? `Anonymous ${v.animal ?? "viewer"}`;
}

export function animalGlyph(animal?: string): string | null {
  return (animal && EMOJI[animal]) || null;
}

export function viewerInitials(v: Pick<PresenceViewer, "name" | "animal">): string {
  const src = v.name ?? v.animal ?? "?";
  return src.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}

/** Six hues the design system tunes for both themes (chart-4's amber sits too close to chart-2's orange). */
const PALETTE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-5)", "var(--chart-6)", "var(--cat-sync)"];

export function viewerColor(i: number): string {
  return PALETTE[(((i | 0) % 6) + 6) % 6]!;
}

/** A stable 0–5 colour for something the page already knows (the studio's people). */
export function colorFor(key: string): number {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return Math.abs(h) % 6;
}

/** "In “Install”", "Page 3", "At 2:30", or the studio's own words. */
export function sectionText(sec: PresenceSection | null | undefined): string | null {
  if (!sec) return null;
  if ("h" in sec) return `In “${sec.label}”`;
  return sec.label;
}

/** "3 people viewing: Riya, Anonymous Otter, you" */
export function stackLabel(viewers: PresenceViewer[], you: string | null, total: number): string {
  const others = viewers.filter((v) => v.id !== you).map(viewerName);
  const names = [...others.slice(0, 5), ...(you ? ["you"] : [])];
  const rest = total - Math.min(others.length, 5) - (you ? 1 : 0);
  const list = rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(", ");
  if (total <= 1) return you ? "Only you are viewing" : "1 person viewing";
  return `${total} people viewing: ${list}`;
}

// ── Preferences ───────────────────────────────────────────────────────────────

export function readAnonPref(): boolean {
  try {
    return localStorage.getItem(ANON_KEY) === "1";
  } catch {
    return false;
  }
}

function writeAnonPref(on: boolean): void {
  try {
    if (on) localStorage.setItem(ANON_KEY, "1");
    else localStorage.removeItem(ANON_KEY);
  } catch { /* storage off: this visit only */ }
}

/** This tab's random id: the server seeds its animal from it, so a reconnect keeps the animal. */
function tabNonce(): string {
  const make = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  try {
    const have = sessionStorage.getItem(NONCE_KEY);
    if (have && /^[A-Za-z0-9_-]{8,40}$/.test(have)) return have;
    const n = make();
    sessionStorage.setItem(NONCE_KEY, n);
    return n;
  } catch {
    return make();
  }
}

// ── The channel ───────────────────────────────────────────────────────────────

function parse(msg: Record<string, unknown>): PresenceSnapshot {
  const on = msg.on === true;
  const countOnly = msg.count_only === true;
  const viewers = Array.isArray(msg.viewers) ? (msg.viewers as PresenceViewer[]) : [];
  return {
    on,
    countOnly,
    total: typeof msg.total === "number" ? msg.total : 0,
    viewers,
    you: typeof msg.you === "string" ? msg.you : null,
    me: msg.me && typeof msg.me === "object" ? (msg.me as PresenceViewer) : null,
  };
}

const secKey = (s: SectionRef) => JSON.stringify(s);

export class PresenceChannel {
  private ws: WebSocket | null = null;
  private ticket: string | null = null;
  private anon = false;
  private sec: SectionRef = null;
  private sentSec = "null";
  private lastSecAt = 0;
  private secTimer: ReturnType<typeof setTimeout> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private nonce = "";
  private wasOff = false;
  private listeners = new Set<() => void>();
  snapshot: PresenceSnapshot | null = null;

  constructor() {
    if (typeof window !== "undefined") {
      this.anon = readAnonPref();
      this.nonce = tabNonce();
    }
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  getSnapshot = () => this.snapshot;

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private send(obj: Record<string, unknown>) {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch { /* closing */ }
    }
  }

  private visibility = () => {
    this.send({ type: "state", v: document.visibilityState === "hidden" ? "away" : "active" });
  };

  private hello() {
    this.sentSec = secKey(this.sec);
    this.lastSecAt = Date.now();
    this.send({
      type: "hello",
      n: this.nonce,
      ...(this.ticket ? { pt: this.ticket } : {}),
      anon: this.anon,
      state: document.visibilityState === "hidden" ? "away" : "active",
      ...(this.sec ? { sec: this.sec } : {}),
    });
  }

  /** The page's socket opened. */
  attach(ws: WebSocket) {
    this.detach(false);
    this.ws = ws;
    this.hello();
    this.beat = setInterval(() => this.send({ type: "ping" }), HEARTBEAT_MS);
    document.addEventListener("visibilitychange", this.visibility);
  }

  /** The socket closed (it reconnects on its own). */
  detach(clear = true) {
    this.ws = null;
    if (this.beat) clearInterval(this.beat);
    if (this.secTimer) clearTimeout(this.secTimer);
    this.beat = this.secTimer = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.visibility);
    if (clear && this.snapshot) {
      this.snapshot = null;
      this.emit();
    }
  }

  /** A message from the socket. True when it was presence (the caller ignores it then). */
  handle(msg: { type?: string } & Record<string, unknown>): boolean {
    if (msg?.type !== "presence") return false;
    const snap = parse(msg);
    const backOn = snap.on && this.wasOff;
    this.wasOff = !snap.on;
    this.snapshot = snap;
    // Turned back on: the server forgot every section while it was off.
    if (backOn) {
      this.sentSec = "null";
      this.flushSection();
    }
    this.emit();
    return true;
  }

  /** The signed-in reader's ticket (or none, signed out): a new hello when it changes. */
  setTicket(t: string | null) {
    if (t === this.ticket) return;
    this.ticket = t;
    if (this.ws) this.hello();
  }

  get anonymous() {
    return this.anon;
  }

  setAnon(on: boolean) {
    this.anon = on;
    writeAnonPref(on);
    this.send({ type: "anon", v: on });
    this.emit();
  }

  /** Where the reader is. Sent at most every 2 s (the last value always goes). */
  setSection(sec: SectionRef) {
    this.sec = sec;
    if (secKey(sec) === this.sentSec || this.secTimer) return;
    const wait = Math.max(0, this.lastSecAt + SECTION_MS - Date.now());
    this.secTimer = setTimeout(() => { this.secTimer = null; this.flushSection(); }, wait);
  }

  private flushSection() {
    if (!this.ws || this.snapshot?.countOnly || this.snapshot?.on === false) return;
    const key = secKey(this.sec);
    if (key === this.sentSec) return;
    this.sentSec = key;
    this.lastSecAt = Date.now();
    this.send({ type: "sec", sec: this.sec });
  }

  dispose() {
    this.detach(false);
    this.listeners.clear();
  }
}

/**
 * One channel for the page, its snapshot, and the reader's "Show me as anonymous" choice.
 * `ticket` is the presence ticket from the page's latest signed-in read (null when signed out).
 */
export function usePresenceChannel(ticket: string | null) {
  const [channel] = useState(() => new PresenceChannel());
  useEffect(() => () => channel.dispose(), [channel]);
  useEffect(() => { channel.setTicket(ticket); }, [channel, ticket]);
  const snapshot = useSyncExternalStore(channel.subscribe, channel.getSnapshot, () => null);
  const [anon, setAnonState] = useState(false);
  useEffect(() => setAnonState(channel.anonymous), [channel]);
  const setAnon = useCallback((on: boolean) => { channel.setAnon(on); setAnonState(on); }, [channel]);
  return { channel, snapshot, anon, setAnon };
}

/**
 * Markers for the sections other people are in: heading id → their colours and names. Your own
 * entry is left out (the page already shows where you are).
 */
export function sectionMarkers(snapshot: PresenceSnapshot | null): Record<string, { color: number; name: string; away: boolean }[]> {
  const out: Record<string, { color: number; name: string; away: boolean }[]> = {};
  if (!snapshot?.on || snapshot.countOnly) return out;
  for (const v of snapshot.viewers) {
    if (v.id === snapshot.you || !v.sec || !("h" in v.sec)) continue;
    (out[v.sec.h] ??= []).push({ color: v.color, name: viewerName(v), away: v.state === "away" });
  }
  return out;
}
