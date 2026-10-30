"use client";

/**
 * Browser-side memory for the docs: synced tab choices ("macOS" everywhere once picked), recent
 * searches, and "changed since your last visit". All localStorage, all optional: private mode or
 * a full quota just means nothing is remembered. Server snapshots are always empty, so static
 * HTML never depends on a reader's storage.
 */
import { useSyncExternalStore } from "react";

const EVENT = "docs:storage";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
}

function subscribe(cb: () => void) {
  const onStorage = () => cb();
  window.addEventListener("storage", onStorage);
  window.addEventListener(EVENT, onStorage);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(EVENT, onStorage);
  };
}

/* ── Synced choices (tabs{sync=…}, the home's install box) ────────────────── */

const choiceKey = (group: string) => `docs_tab_${group}`;

function guessOs(): string | null {
  if (typeof navigator === "undefined") return null;
  const p = `${(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? ""} ${navigator.platform} ${navigator.userAgent}`;
  if (/iPhone|iPad|Mac/i.test(p)) return "macOS";
  if (/Win/i.test(p)) return "Windows";
  if (/Linux|X11|CrOS|Android/i.test(p)) return "Linux";
  return null;
}

/** The reader's choice for a sync group, or null (first tab). `os` falls back to this device. */
export function useSyncedChoice(group: string | undefined): string | null {
  return useSyncExternalStore(
    subscribe,
    () => (group ? read(choiceKey(group)) ?? (group === "os" ? guessOs() : null) : null),
    () => null,
  );
}

export function setSyncedChoice(group: string, value: string) {
  write(choiceKey(group), value);
}

/* ── Recent searches ─────────────────────────────────────────────────────── */

const RECENT = "docs_recent_searches";
let recentCache: { raw: string | null; list: string[] } = { raw: null, list: [] };

function recentSnapshot(): string[] {
  const raw = read(RECENT);
  if (raw === recentCache.raw) return recentCache.list;
  let list: string[] = [];
  try {
    const v = JSON.parse(raw ?? "[]");
    if (Array.isArray(v)) list = v.filter((x) => typeof x === "string").slice(0, 6);
  } catch {}
  recentCache = { raw, list };
  return list;
}
const NO_RECENT: string[] = [];

export function useRecentSearches(): string[] {
  return useSyncExternalStore(subscribe, recentSnapshot, () => NO_RECENT);
}

export function rememberSearch(q: string) {
  const query = q.trim();
  if (query.length < 2) return;
  const next = [query, ...recentSnapshot().filter((x) => x.toLowerCase() !== query.toLowerCase())].slice(0, 6);
  write(RECENT, JSON.stringify(next));
}

export function clearRecentSearches() {
  write(RECENT, null);
}

/* ── Changed since your last visit ───────────────────────────────────────── */

interface Seen {
  t: number;
  h: Record<string, string>;
}
const visitResults = new Map<string, string[]>();
const NONE: string[] = [];

/**
 * Sections whose content hash differs from the reader's previous visit to this page (new sections
 * count as changed). The first visit shows nothing. The visit is recorded once per page load.
 */
function visit(path: string, hashes: Record<string, string>): string[] {
  const cached = visitResults.get(path);
  if (cached) return cached;
  const key = `docs_seen:${path}`;
  let prev: Seen | null = null;
  try {
    const v = JSON.parse(read(key) ?? "null");
    if (v && typeof v === "object" && v.h && typeof v.h === "object") prev = v as Seen;
  } catch {}
  const changed = prev ? Object.keys(hashes).filter((id) => prev!.h[id] !== hashes[id]) : NONE;
  try {
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), h: hashes }));
  } catch {}
  visitResults.set(path, changed);
  return changed;
}

export function useChangedSections(path: string, hashes: Record<string, string>): string[] {
  return useSyncExternalStore(
    noopSubscribe,
    () => visit(path, hashes),
    () => NONE,
  );
}
function noopSubscribe() {
  return () => {};
}

/* ── Changelog: last visit ───────────────────────────────────────────────── */

const CL_KEY = "docs_changelog_seen";
let clVisit: { prev: string | null } | null = null;

/** The date (YYYY-MM-DD) of the reader's previous changelog visit, or null on the first. */
export function useChangelogLastVisit(today: string): string | null {
  return useSyncExternalStore(
    noopSubscribe,
    () => {
      if (!clVisit) {
        clVisit = { prev: read(CL_KEY) };
        try {
          localStorage.setItem(CL_KEY, today);
        } catch {}
      }
      return clVisit.prev;
    },
    () => null,
  );
}

/* ── Opening the search palette from anywhere ────────────────────────────── */

export const SEARCH_EVENT = "docs:open-search";

export function openSearch(query = "") {
  window.dispatchEvent(new CustomEvent(SEARCH_EVENT, { detail: { query } }));
}
