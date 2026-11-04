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
 * or signing out, never shows the previous one's rows. Stale-while-revalidate: what's cached
 * shows at once and is refreshed in the background when it is older than the caller allows, when
 * the window regains focus after a minute, and whenever something changed it:
 * `workspaceChanged(id)` (lib/workspaceStore) and the page events lib/pages fires after a page is
 * created, moved or deleted.
 *
 * - the first page of a folder view's rows (`GET /workspaces/{id}/items`), per workspace, place
 *   (folder id, "root" or "all"), search and kind: a folder you've seen opens at once, and hover /
 *   focus on a folder link (lib/folderNav) fetches its rows before the click. A save (and a change the reading view sees live) patches the page's
 * title and icon in place (`patchPage`), in the outlines, sub-page lists and folder views alike, with
 * no request. The person's other tabs get the same events (lib/navBus). What someone else changes
 * shows when the window comes back (rows older than a few seconds) and, while a folder view is on
 * screen, from a light poll (`useFolderItems`). A refresh that finds nothing new changes nothing on
 * screen (the cached value stays the same object), and never empties what is on screen.
 */
import { useEffect, useSyncExternalStore } from "react";
import { getWorkspaceNav, listWorkspaceItems, type ItemsPage, type WorkspaceNav } from "@/lib/workspaces";
import { setFolderWarmer } from "@/lib/folderNav";
import { listChildren, PagesApiError, type ChildPage } from "@/lib/pages";
import { getToken } from "@/lib/api";
import { listenRemote } from "@/lib/navBus";
import { refreshTree } from "@/lib/workspaceStore";

/** lib/workspaceStore's event (a workspace's folders or items changed). */
const WS_CHANGE_EVENT = "md:workspace-change";
/** Fired by lib/pages after a page is created, saved, moved or deleted. */
export const PAGES_EVENT = "md:pages-change";
const FOCUS_MAX_AGE = 60_000;
/** A folder view's rows on screen refresh when the window comes back and they're older than this
 *  (a rename in another tab or by someone else shows as you return), and are polled this often
 *  while the tab is visible. */
export const ITEMS_FOCUS_MAX_AGE = 5_000;
export const ITEMS_POLL_MS = 30_000;

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

  /** `cap`: at most this many entries; the least recently loaded ones nobody shows go first. */
  constructor(private fetcher: (key: string) => Promise<T>, private cap = Infinity) {}

  private trim() {
    if (this.entries.size <= this.cap) return;
    const idle = [...this.entries].filter(([k]) => !this.active.has(k) && !this.inflight.has(k)).sort((a, b) => a[1].at - b[1].at);
    for (const [k] of idle.slice(0, this.entries.size - this.cap)) this.entries.delete(k);
  }

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
      .then((fresh) => {
        // Nothing new: keep the same object, so nothing on screen re-renders (or drops what it
        // added, like a folder view's "Load more" rows).
        const prev = this.entries.get(key)?.data;
        const data = prev && same(prev, fresh) ? prev : fresh;
        this.entries.set(key, { data, error: false, at: Date.now(), stale: false });
        this.trim();
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

  /** Whether any request is running (a folder opening, say). */
  busy(): boolean {
    return this.inflight.size > 0;
  }

  /** Rewrite cached values in place (`edit` returns the same value when nothing changed); keys it
   *  can't patch (`refetch`) refresh like `invalidate`. Returns whether anything changed. */
  patch(edit: (data: T) => T | "refetch"): boolean {
    let changed = false;
    const refetch: string[] = [];
    for (const [k, e] of this.entries) {
      if (!e.data) continue;
      const next = edit(e.data);
      if (next === "refetch") refetch.push(k);
      else if (next !== e.data) {
        e.data = next;
        changed = true;
      }
    }
    if (refetch.length) this.invalidate((k) => refetch.includes(k));
    return changed;
  }

  bump() {
    this.version++;
    for (const l of listeners) l();
  }
}

/** Same JSON (API responses are plain data). */
function same(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
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

/** Rows per folder-view page (FolderView asks for more with the cursor). */
export const ITEMS_PAGE = 50;
const PART = "\u0001";
const itemsCache = new Cache<ItemsPage>((key) => {
  const [ws, folder, q, kind] = idOf(key).split(PART);
  return listWorkspaceItems(ws!, { folder: folder!, q: q || undefined, kind: kind || undefined, limit: ITEMS_PAGE });
}, 80);
const itemsWs = (key: string) => idOf(key).split(PART)[0];

/** The cache key of a folder view's first page: `folder` is a folder id, "root" or "all". */
export const itemsKey = (ws: string, folder: string, q = "", kind = "") => keyOf([ws, folder, q, kind].join(PART));

let wired = false;
function wire() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  // Hover / focus on a folder link anywhere warms its rows (lib/folderNav; 30 s is fresh enough).
  setFolderWarmer((t) => { void itemsCache.load(itemsKey(t.workspaceId, t.folderId ?? "root"), 30_000).catch(() => {}); });
  // What the person's other tabs change arrives as the same events (lib/navBus).
  listenRemote();
  window.addEventListener(WS_CHANGE_EVENT, (e) => {
    const d = (e as CustomEvent<{ id?: string; remote?: boolean }>).detail;
    const id = d?.id;
    // Another tab's change: this tab's copy of the folder tree refreshes too (here,
    // workspaceChanged already did that).
    if (d?.remote && id) refreshTree(id, 0);
    navCache.invalidate((k) => !id || idOf(k) === id);
    // Folder views on screen reload; the others are marked stale (shown, then refreshed).
    itemsCache.invalidate((k) => !id || itemsWs(k) === id);
    // Sub-pages aren't keyed by workspace: a move or delete anywhere may touch any of them.
    kidsCache.invalidate();
  });
  window.addEventListener(PAGES_EVENT, (e) => {
    const d = (e as CustomEvent<PageChange>).detail ?? {};
    // A save (or a change seen live) carries the page's title and icon: patch its rows, no request.
    if (d.slug) {
      patchPage(d.slug, { title: d.title, icon: d.icon });
      return;
    }
    // Anything else refreshes what's shown; "soft" only marks stale.
    navCache.invalidate(undefined, !!d.soft);
    itemsCache.invalidate(undefined, !!d.soft);
    kidsCache.invalidate(undefined, !!d.soft);
  });
  const refresh = () => {
    if (document.visibilityState === "hidden") return;
    navCache.refreshActive(FOCUS_MAX_AGE);
    kidsCache.refreshActive(FOCUS_MAX_AGE);
    itemsCache.refreshActive(ITEMS_FOCUS_MAX_AGE);
  };
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
}

interface PageChange {
  soft?: boolean;
  slug?: string;
  title?: string | null;
  icon?: string | null;
  remote?: boolean;
}

/** The fields of a cached row that a save can change. */
type Named = { slug: string; title: string | null; icon?: string | null; icon_url?: string | null };

/** `row` with `title` / `icon` applied (the same object when nothing changes); "refetch" when the
 *  icon became an image (only the API can sign its link). */
function patched<R extends Named>(row: R, p: { title?: string | null; icon?: string | null }): R | "refetch" {
  const title = p.title === undefined ? row.title : p.title;
  const icon = p.icon === undefined ? row.icon ?? null : p.icon;
  if (title === row.title && icon === (row.icon ?? null)) return row;
  if (icon !== (row.icon ?? null) && icon?.startsWith("asset:")) return "refetch";
  const next: R = { ...row, title };
  if (icon !== (row.icon ?? null)) {
    next.icon = icon;
    next.icon_url = null;
  }
  return next;
}

/** Patch `slug`'s title / icon wherever a list holds it (outlines, sub-page lists): the rail and the
 *  page tree show a rename at once, with no request. Undefined fields are left alone. */
export function patchPage(slug: string, p: { title?: string | null; icon?: string | null }) {
  const inList = <R extends Named>(list: R[]): R[] | "refetch" => {
    const i = list.findIndex((r) => r.slug === slug);
    if (i < 0) return list;
    const row = patched(list[i]!, p);
    if (row === "refetch" || row === list[i]) return row === "refetch" ? row : list;
    const out = list.slice();
    out[i] = row;
    return out;
  };
  const a = navCache.patch((nav) => {
    const items = inList(nav.items);
    return items === "refetch" ? items : items === nav.items ? nav : { ...nav, items };
  });
  const b = kidsCache.patch(inList);
  // Folder views' rows too (a "Load more" page's rows are FolderView's own: it patches them on
  // the same event).
  const c = itemsCache.patch((page) => {
    const items = inList(page.items);
    return items === "refetch" ? items : items === page.items ? page : { ...page, items };
  });
  if (a || b) navCache.bump();
  if (c) itemsCache.bump();
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

/** A number that changes whenever anything cached changes (read the lists with `childrenSlot`),
 *  without keeping anything loaded (the page tree holds its own branches). */
export function useNavVersion(): number {
  return useSyncExternalStore(subscribe, () => navCache.version * 100_003 + kidsCache.version, () => 0);
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

/* ── Folder views ──────────────────────────────────────────────────────── */

export interface ItemsSlot {
  /** The first page, as cached (possibly being refreshed); null before it ever loaded. */
  data: ItemsPage | null;
  /** The last request failed (what's cached, if anything, still shows). */
  error: unknown;
  /** A request is running. */
  loading: boolean;
}

const EMPTY_ITEMS: ItemsSlot = { data: null, error: null, loading: false };
const itemSlots = new Map<string, ItemsSlot>();
/** One stable object per key while nothing about it changed (useSyncExternalStore needs that). */
function itemsSlotOf(key: string | null): ItemsSlot {
  if (!key) return EMPTY_ITEMS;
  const e = itemsCache.peek(key);
  const loading = itemsCache.loading(key);
  const data = e?.data ?? null;
  const error = e?.error && !loading ? e.error : null;
  const prev = itemSlots.get(key);
  if (prev && prev.data === data && prev.error === error && prev.loading === loading) return prev;
  const next = { data, error, loading };
  itemSlots.set(key, next);
  if (itemSlots.size > 200) itemSlots.clear();
  return next;
}

/**
 * The first page of a folder view's rows (`key` from `itemsKey`; null = nothing): what's cached
 * shows at once and is refreshed in the background when older than `maxAge`; kept fresh while
 * mounted (workspace changes, focus, and with `poll` a light poll while the tab is visible: what
 * other people rename shows without a reload). `reload()` asks the API again.
 */
export function useFolderItems(key: string | null, maxAge = 15_000, poll = false): ItemsSlot & { reload: () => Promise<unknown> } {
  const slot = useSyncExternalStore(subscribe, () => itemsSlotOf(key), () => EMPTY_ITEMS);
  useEffect(() => (key ? itemsCache.retain([key], maxAge) : undefined), [key, maxAge]);
  useEffect(() => {
    if (!key || !poll) return;
    const t = window.setInterval(() => {
      // Never while hidden, and never alongside a folder that's opening (slow networks).
      if (document.visibilityState === "hidden" || itemsCache.busy()) return;
      void itemsCache.load(key, ITEMS_POLL_MS - 1_000).catch(() => {});
    }, ITEMS_POLL_MS);
    return () => window.clearInterval(t);
  }, [key, poll]);
  return { ...slot, reload: () => (key ? itemsCache.load(key, 0).catch(() => {}) : Promise.resolve()) };
}

/** Fetch a folder's first page ahead of time (hover, focus, an in-place switch). */
export function prefetchFolderItems(ws: string, folder: string, maxAge = 30_000): void {
  wire();
  void itemsCache.load(itemsKey(ws, folder), maxAge).catch(() => {});
}
