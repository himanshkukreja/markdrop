"use client";

/**
 * Card previews for the workspace listing's Cards view (feat/card-previews):
 * `POST /api/v1/workspaces/{id}/items/previews` (backend services/card_preview.py), and for the
 * home's "Continue" cards (items anywhere, ANYWHERE): `POST /api/v1/me/previews`.
 *
 * A card asks only while it is on screen (`useInView`, one shared IntersectionObserver). Asks
 * wait for the browser to be idle after the folder renders, go out SIX at a time, at most TWO
 * requests in flight, so a folder click never queues behind a preview. Answers stay in memory
 * for the tab (keyed by the item's `updated_at`, so a change refetches), at most MAX_ENTRIES,
 * and are reused when the folder is opened again. A "pending" answer (a picture being made) is
 * asked again with a backoff while its card is still on screen.
 *
 * Live HTML renders are rationed too (`useLive`): at most MAX_LIVE frames at once, the most
 * recently hovered; the rest show their static preview.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { errorStatus, request } from "@/lib/workspaces";

export type PreviewBlock =
  | { t: "h1" | "h2" | "h3" | "p" | "quote"; x: string }
  | { t: "li"; x: string; n?: number; d?: number }
  | { t: "todo"; x: string; done?: boolean; d?: number }
  | { t: "code"; x: string; lang?: string }
  | { t: "hr" }
  | { t: "img"; kind?: "diagram" | "math" }
  | { t: "table"; rows: string[][] };

export interface CardPreview {
  state: "ok" | "locked" | "encrypted" | "pending";
  /** page · markdown · html · bundle · pdf · image · video · sheet · text · docx · pptx · audio · none… */
  type?: string;
  blocks?: PreviewBlock[];
  icon?: string;
  cover?: { gallery?: string; url?: string; src?: string; y?: number };
  /** A small WebP thumbnail, always a data: URI. */
  src?: string;
  w?: number;
  h?: number;
  pages?: number;
  rows?: string[][];
  lines?: string[];
  /** An HTML file's own URL on the artifact origin (signed), for a sandboxed frame there. */
  live?: string;
  live_ttl?: number;
  duration?: number;
}

/** The cache's "workspace" for items anywhere (the home's Continue cards): `POST /api/v1/me/previews`. */
export const ANYWHERE = "~me";

const BATCH = 6;
const MAX_INFLIGHT = 2;
const MAX_ENTRIES = 400;
const FRESH_MS = 15 * 60_000;
const RETRY_MS = [1200, 2500, 5000, 9000, 15000];

interface Entry {
  v: string;
  at: number;
  data: CardPreview | null;
  inflight: boolean;
  tries: number;
  /** Cards on screen that want it. */
  subs: number;
  timer: number | null;
}

const store = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const queue = new Map<string, Set<string>>(); // workspace → slugs
let inflight = 0;
let scheduled = false;

const keyOf = (ws: string, slug: string) => `${ws}\u0000${slug}`;

function notify(key: string) {
  for (const l of listeners.get(key) ?? []) l();
}

function fresh(e: Entry): boolean {
  if (!e.data || e.data.state === "pending") return false;
  const ttl = e.data.live ? Math.min(FRESH_MS, Math.max(30_000, (e.data.live_ttl ?? 900) * 1000 - 90_000)) : FRESH_MS;
  return Date.now() - e.at < ttl;
}

function evict() {
  if (store.size <= MAX_ENTRIES) return;
  const idle = [...store.entries()].filter(([, e]) => e.subs <= 0 && !e.inflight).sort((a, b) => a[1].at - b[1].at);
  for (const [k] of idle.slice(0, store.size - MAX_ENTRIES)) store.delete(k);
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  const run = () => {
    scheduled = false;
    flush();
  };
  // After the folder has painted and the browser is idle: previews never compete with a click.
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 400 });
  else window.setTimeout(run, 80);
}

function enqueue(ws: string, slug: string) {
  let q = queue.get(ws);
  if (!q) queue.set(ws, (q = new Set()));
  q.add(slug);
  schedule();
}

function flush() {
  while (inflight < MAX_INFLIGHT) {
    const next = [...queue.entries()].find(([, q]) => q.size > 0);
    if (!next) return;
    const [ws, q] = next;
    const slugs: string[] = [];
    for (const s of q) {
      q.delete(s);
      const e = store.get(keyOf(ws, s));
      if (!e || e.subs <= 0 || e.inflight) continue; // left the screen before its turn
      e.inflight = true;
      slugs.push(s);
      if (slugs.length >= BATCH) break;
    }
    if (!q.size) queue.delete(ws);
    if (slugs.length) void send(ws, slugs);
  }
}

async function send(ws: string, slugs: string[]) {
  inflight++;
  let got: Record<string, CardPreview> | null = null;
  let retry = true;
  try {
    const r = await request<{ previews?: Record<string, CardPreview> }>(
      ws === ANYWHERE ? "/api/v1/me/previews" : `/api/v1/workspaces/${encodeURIComponent(ws)}/items/previews`,
      { method: "POST", body: JSON.stringify({ slugs }) },
    );
    got = r.previews ?? {};
  } catch (e) {
    // Offline, rate limited or a hiccup: try again later. Refused (signed out, not a member): don't.
    // Either way the cards keep their icons.
    const status = errorStatus(e);
    retry = status === 0 || status === 429 || status >= 500;
    got = null;
  } finally {
    inflight--;
  }
  for (const s of slugs) {
    const key = keyOf(ws, s);
    const e = store.get(key);
    if (!e) continue;
    e.inflight = false;
    const p = got?.[s];
    if (p) {
      e.data = p;
      e.at = Date.now();
    }
    if (((!p && retry) || p?.state === "pending") && e.tries < RETRY_MS.length) {
      const wait = RETRY_MS[e.tries++]!;
      if (e.timer) window.clearTimeout(e.timer);
      e.timer = window.setTimeout(() => {
        e.timer = null;
        if (e.subs > 0) enqueue(ws, s);
      }, wait);
    }
    notify(key);
  }
  if (queue.size) schedule();
}

function want(ws: string, slug: string, v: string) {
  const key = keyOf(ws, slug);
  let e = store.get(key);
  if (!e) {
    e = { v, at: 0, data: null, inflight: false, tries: 0, subs: 0, timer: null };
    store.set(key, e);
    evict();
  } else if (e.v !== v) {
    // The item changed since: keep showing the old preview until the new one is in.
    e.v = v;
    e.at = 0;
    e.tries = 0;
  }
  e.subs++;
  if (!e.inflight && !fresh(e) && !e.timer) enqueue(ws, slug);
}

function unwant(ws: string, slug: string) {
  const e = store.get(keyOf(ws, slug));
  if (!e) return;
  e.subs = Math.max(0, e.subs - 1);
}

/** Ask again now (an HTML card's live URL went stale before a hover). */
export function refreshPreview(ws: string, slug: string) {
  const e = store.get(keyOf(ws, slug));
  if (!e || e.inflight || e.subs <= 0) return;
  e.at = 0;
  e.tries = 0;
  enqueue(ws, slug);
}

export function isFresh(ws: string, slug: string): boolean {
  const e = store.get(keyOf(ws, slug));
  return !!e && fresh(e);
}

/** The card's preview (null until it arrives), asked for while `active` (on screen). */
export function useCardPreview(ws: string, slug: string, version: string, active: boolean): CardPreview | null {
  const key = keyOf(ws, slug);
  const subscribe = useCallback(
    (cb: () => void) => {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(cb);
      return () => {
        set!.delete(cb);
        if (!set!.size) listeners.delete(key);
      };
    },
    [key],
  );
  const data = useSyncExternalStore(
    subscribe,
    () => store.get(key)?.data ?? null,
    () => null,
  );
  useEffect(() => {
    if (!active || !ws || !slug) return;
    want(ws, slug, version);
    return () => unwant(ws, slug);
  }, [active, ws, slug, version]);
  return data;
}

/* ── On screen ─────────────────────────────────────────────────────────── */

let observer: IntersectionObserver | null = null;
const watchers = new Map<Element, (on: boolean) => void>();

function observe(el: Element, cb: (on: boolean) => void) {
  if (typeof IntersectionObserver === "undefined") {
    cb(true);
    return () => {};
  }
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const en of entries) watchers.get(en.target)?.(en.isIntersecting);
      },
      { rootMargin: "200px 0px" },
    );
  }
  watchers.set(el, cb);
  observer.observe(el);
  return () => {
    watchers.delete(el);
    observer?.unobserve(el);
  };
}

/** Whether the element is on (or within 200 px of) the screen. */
export function useInView<T extends Element>(): [React.RefCallback<T>, boolean] {
  const [on, setOn] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  const ref = useCallback((el: T | null) => {
    stop.current?.();
    stop.current = null;
    if (el) stop.current = observe(el, setOn);
  }, []);
  useEffect(() => () => stop.current?.(), []);
  return [ref, on];
}

/* ── Live frames, rationed ─────────────────────────────────────────────── */

export const MAX_LIVE = 3;
let live: string[] = [];
const liveListeners = new Set<() => void>();
const emitLive = () => {
  for (const l of liveListeners) l();
};

export function promoteLive(key: string) {
  if (live[0] === key) return;
  live = [key, ...live.filter((k) => k !== key)].slice(0, MAX_LIVE);
  emitLive();
}

export function dropLive(key: string) {
  if (!live.includes(key)) return;
  live = live.filter((k) => k !== key);
  emitLive();
}

/** Whether this card's frame is one of the few live ones. */
export function useLive(key: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      liveListeners.add(cb);
      return () => liveListeners.delete(cb);
    },
    () => live.includes(key),
    () => false,
  );
}

/** Live frames only where they make sense: a mouse that hovers, and no data saver or 2G. */
export function liveAllowed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return false;
    const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (c?.saveData || /(^|-)2g$/.test(c?.effectiveType ?? "")) return false;
  } catch {
    return false;
  }
  return true;
}

/** Only a URL on the artifact origin (never the app's own), and only its byte or viewer paths. */
export function safeLiveUrl(url: string | undefined): string | null {
  if (!url || typeof window === "undefined") return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.origin === window.location.origin) return null;
    const expected = process.env.NEXT_PUBLIC_ARTIFACT_ORIGIN;
    if (expected && u.origin !== new URL(expected).origin) return null;
    if (!u.pathname.startsWith("/r/") && !u.pathname.startsWith("/v/")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export const isDataImage = (s: string | undefined): s is string => !!s && s.startsWith("data:image/webp;base64,");
