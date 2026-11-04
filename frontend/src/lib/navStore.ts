"use client";

/**
 * The navigation caches behind the app rail and the page tree, in the spirit of workspaceStore
 * (one shared copy, no library):
 *
 * - a workspace's outline (`GET /workspaces/{id}/nav`): its top-level pages, documents and files,
 *   one request per workspace however many folders are open;
 * - a page's sub-pages (`GET /documents/{slug}/children`), shared by the rail, the page tree and
 *   "Pages inside", so the same list is never fetched twice at once.
 *
 * Entries are keyed by the session the request carries (the token's tail), so another account,
 * or signing out, never shows the previous one's rows. Stale-while-revalidate: what's cached shows at once and is refreshed in the
 * background when it is older than the caller allows, when the window regains focus after a
 * minute, and whenever something changed it: `workspaceChanged(id)` (lib/workspaceStore) and
 * `pagesChanged()` (lib/pages calls it after a page is created, saved, moved or deleted). A
 * refresh never empties what is on screen.
 */
import { useEffect, useSyncExternalStore } from "react";
import { getWorkspaceNav, type WorkspaceNav } from "@/lib/workspaces";
import { listChildren, PagesApiError, type ChildPage } from "@/lib/pages";
import { getToken } from "@/lib/api";

/** lib/workspaceStore's event (a workspace's folders or items changed). */
const WS_CHANGE_EVENT = "md:workspace-change";
/** Fired by lib/pages after a page is created, saved, moved or deleted. */
export const PAGES_EVENT = "md:pages-change";
const FOCUS_MAX_AGE = 60_000;

interface Entry<T> {
  data: T | null;
  error: boolean;
  at: number;
  stale: boolean;
}

class Cache<T> {
  private entries = new Map<string, Entry<T>>();
  private inflight = new Map<string, Promise<T>>();
  private active = new Map<string, number>();
  version = 0;

  constructor(private fetcher: (key: string) => Promise<T>) {}

  peek(key: string): Entry<T> | undefined {
    return this.entries.get(key);
  }

  /** The cached value when it's fresh enough (and not marked stale), else one shared request. */
  load(key: string, maxAge = Infinity): Promise<T> {
    const e = this.entries.get(key);
    if (e?.data && !e.stale && Date.now() - e.at <= maxAge) return Promise.resolve(e.data);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.fetcher(key)
      .then((data) => {
        this.entries.set(key, { data, error: false, at: Date.now(), stale: false });
        return data;
      })
      .catch((err) => {
        // Keep what's on screen; just remember it failed (a later refresh retries).
        const prev = this.entries.get(key);
        this.entries.set(key, { data: prev?.data ?? null, error: true, at: Date.now(), stale: false });
        throw err;
      })
      .finally(() => {
        this.inflight.delete(key);
        this.bump();
      });
    this.inflight.set(key, p);
    return p;
  }

  loading(key: string): boolean {
    return this.inflight.has(key);
  }

  retain(keys: string[], maxAge: number): () => void {
    for (const k of keys) {
      this.active.set(k, (this.active.get(k) ?? 0) + 1);
      void this.load(k, maxAge).catch(() => {});
    }
    return () => {
      for (const k of keys) {
        const n = (this.active.get(k) ?? 1) - 1;
        if (n <= 0) this.active.delete(k);
        else this.active.set(k, n);
      }
    };
  }

  /** Mark matching entries stale; the ones on screen refresh now, the others when next asked for. */
  invalidate(match: (key: string) => boolean = () => true, soft = false) {
    for (const [k, e] of this.entries) if (match(k)) e.stale = true;
    if (soft) return;
    for (const k of this.active.keys()) if (match(k)) void this.load(k).catch(() => {});
  }

  /** Refresh what's on screen when it is older than `maxAge`. */
  refreshActive(maxAge: number) {
    for (const k of this.active.keys()) void this.load(k, maxAge).catch(() => {});
  }


  bump() {
    this.version++;
    for (const l of listeners) l();
  }
}

const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  wire();
  listeners.add(cb);
  return () => listeners.delete(cb);
};

const sep = "|";
/** Who the requests are for: the session token's tail (what the API sees), "anon" without one. */
const who = () => getToken()?.slice(-24) || "anon";
const keyOf = (id: string) => `${who()}${sep}${id}`;
const idOf = (key: string) => key.slice(key.indexOf(sep) + 1);

const navCache = new Cache<WorkspaceNav>((key) => getWorkspaceNav(idOf(key)));
const kidsCache = new Cache<ChildPage[]>((key) =>
  // An API without pages (404 on /children) is just "no sub-pages".
  listChildren(idOf(key)).catch((e) => {
    if (e instanceof PagesApiError && e.status === 404) return [];
    throw e;
  }),
);

let wired = false;
function wire() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener(WS_CHANGE_EVENT, (e) => {
    const id = (e as CustomEvent<{ id?: string }>).detail?.id;
    navCache.invalidate((k) => !id || idOf(k) === id);
    // Sub-pages aren't keyed by workspace: a move or delete anywhere may touch any of them.
    kidsCache.invalidate();
  });
  window.addEventListener(PAGES_EVENT, (e) => {
    // A save is "soft": mark stale only (autosave runs often); anything else refreshes what's shown.
    const soft = !!(e as CustomEvent<{ soft?: boolean }>).detail?.soft;
    navCache.invalidate(undefined, soft);
    kidsCache.invalidate(undefined, soft);
  });
  const refresh = () => {
    if (document.visibilityState === "hidden") return;
    navCache.refreshActive(FOCUS_MAX_AGE);
    kidsCache.refreshActive(FOCUS_MAX_AGE);
  };
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
}

/** A page was created, saved, moved or deleted: outlines and sub-page lists refresh. */
export function pagesChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PAGES_EVENT, { detail: { soft: false } }));
}

/* ── Hooks ─────────────────────────────────────────────────────────────── */

/** Per id: the value, null while not loaded yet, or false when it failed with nothing cached. */
export type NavSlot<T> = T | null | false;

function slotOf<T>(cache: Cache<T>, key: string): NavSlot<T> {
  const e = cache.peek(key);
  if (e?.data) return e.data;
  return e?.error && !cache.loading(key) ? false : null;
}

/** The outline of workspace `id` for this session, as cached now (read during render; pair it with
 *  `useNavRetain`, whose returned version changes whenever it does). */
export const navSlot = (id: string): NavSlot<WorkspaceNav> => slotOf(navCache, keyOf(id));

/** The sub-pages of `slug` for this session, as cached now (pair it with `useNavRetain`). */
export const childrenSlot = (slug: string): NavSlot<ChildPage[]> => slotOf(kidsCache, keyOf(slug));

/**
 * Keep the outlines of `workspaces` and the sub-pages of `pages` loaded while mounted, and return
 * a version number that changes whenever anything cached does (a memo dependency). `maxAge`: on
 * mount, what's cached and older than this is refreshed in the background (the rail passes 10 s,
 * so coming back from a page shows what changed there without a blank).
 */
export function useNavRetain(workspaces: string[], pages: string[], maxAge = 10_000): number {
  const version = useSyncExternalStore(subscribe, () => navCache.version * 100_003 + kidsCache.version, () => 0);
  const wsSig = [...new Set(workspaces)].sort().map(keyOf).join(",");
  const pageSig = [...new Set(pages)].sort().map(keyOf).join(",");
  useEffect(() => (wsSig ? navCache.retain(wsSig.split(","), maxAge) : undefined), [wsSig, maxAge]);
  useEffect(() => (pageSig ? kidsCache.retain(pageSig.split(","), maxAge) : undefined), [pageSig, maxAge]);
  return version;
}

/**
 * A page's sub-pages, from the shared cache: a request already running is joined, and a list
 * fetched less than `maxAge` ago is reused (the page tree and "Pages inside" mount together).
 * `maxAge: 0` always asks the API.
 */
export function fetchChildren(slug: string, maxAge = 5_000): Promise<ChildPage[]> {
  wire();
  return kidsCache.load(keyOf(slug), maxAge);
}
