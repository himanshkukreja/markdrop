"use client";

/**
 * The Meetings hub's list, a page at a time (GET /api/v1/meetings: cursor pages of 30 cards; the server
 * sorts, filters and searches, and decides access). The first page renders as soon as it arrives; the
 * next one is fetched while the browser is idle and shown when the reader scrolls near the end
 * (MeetingsHub's sentinel) or presses "Load more".
 *
 * Back navigation: the loaded pages, the filters and the scroll position are kept in memory per workspace
 * (SNAP / LAST_QUERY, for this tab's session), so coming back from a meeting shows the same list at the
 * same place at once; the first pages are then revalidated quietly (an ETag'd request: a 304 when nothing
 * changed).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listMeetings, MEETINGS_PAGE, type HiddenMeeting, type MeetingCard, type MeetingSort, type MeetingsPage } from "@/lib/meetings";

export interface MeetingsListQuery { q: string; series: string | null; sort: MeetingSort }

interface Snap { items: MeetingCard[]; hidden: HiddenMeeting[]; total: number | null; next: string | null; at: number; scrollY: number }

const SNAP = new Map<string, Snap>();
const LAST_QUERY = new Map<string, MeetingsListQuery>();
const FRESH_MS = 10 * 60_000;
const HEAD_MAX = 100;

const keyOf = (ws: string, q: MeetingsListQuery) => JSON.stringify([ws, q.sort, q.series, q.q.trim().toLowerCase()]);

/** The filters this tab last used on a workspace's hub (restored on back navigation). */
export function lastQuery(ws: string): MeetingsListQuery | undefined {
  return LAST_QUERY.get(ws);
}

interface State {
  key: string;
  items: MeetingCard[] | null;
  hidden: HiddenMeeting[];
  total: number | null;
  next: string | null;
  error: string | null;
  loadingMore: boolean;
  moreError: boolean;
  /** Showing the previous filter's list while this one loads. */
  stale: boolean;
}

function fromSnap(key: string, s: Snap): State {
  return { key, items: s.items, hidden: s.hidden, total: s.total, next: s.next, error: null, loadingMore: false, moreError: false, stale: false };
}

/** The current list with ``page`` (a fresh first page covering at least the loaded head) laid over it. */
function mergeHead(cur: MeetingCard[], page: MeetingsPage, curNext: string | null): { items: MeetingCard[]; next: string | null } {
  if (!page.next_cursor) return { items: page.meetings, next: null };
  const ids = new Set(page.meetings.map((m) => m.id));
  let last = -1;
  cur.forEach((m, i) => { if (ids.has(m.id)) last = i; });
  if (last < 0) return { items: page.meetings, next: page.next_cursor };
  const tail = cur.slice(last + 1).filter((m) => !ids.has(m.id));
  return tail.length ? { items: [...page.meetings, ...tail], next: curNext } : { items: page.meetings, next: page.next_cursor };
}

export function useMeetingsList(workspaceId: string, enabled: boolean, query: MeetingsListQuery) {
  const key = keyOf(workspaceId, query);
  // Restored from this tab's memory (back navigation): rendered at once, at the same scroll position.
  const restored = useMemo(() => {
    const s = SNAP.get(key);
    return s && Date.now() - s.at < FRESH_MS ? s : null;
    // Only the first render's key decides what was restored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [st, setSt] = useState<State>(() => restored ? fromSnap(key, restored)
    : { key, items: null, hidden: [], total: null, next: null, error: null, loadingMore: false, moreError: false, stale: false });
  const stRef = useRef(st);
  stRef.current = st;
  const seq = useRef(0);
  const prefetched = useRef<{ key: string; cursor: string; p: Promise<MeetingsPage> } | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => { LAST_QUERY.set(workspaceId, query); }, [workspaceId, query]);

  // Remember the list (and where the reader is) for back navigation.
  useEffect(() => {
    if (!st.items || st.stale || st.key !== key) return;
    SNAP.set(key, { items: st.items, hidden: st.hidden, total: st.total, next: st.next, at: Date.now(), scrollY: SNAP.get(key)?.scrollY ?? 0 });
  }, [st, key]);
  useEffect(() => {
    let raf = 0;
    const save = () => {
      raf = 0;
      const s = SNAP.get(key);
      if (s) s.scrollY = window.scrollY;
    };
    const onScroll = () => { if (!raf) raf = window.requestAnimationFrame(save); };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); if (raf) window.cancelAnimationFrame(raf); };
  }, [key]);

  /** The loaded head again (at least a page, at most HEAD_MAX), laid over the list: new summaries,
   * new meetings, deletions. Quiet: errors keep what's shown. */
  const refreshHead = useCallback(async () => {
    const my = seq.current;
    const cur = stRef.current;
    const limit = Math.min(HEAD_MAX, Math.max(MEETINGS_PAGE, cur.items?.length ?? 0));
    try {
      const page = await listMeetings(workspaceId, { ...queryRef.current, limit });
      if (my !== seq.current) return;
      setSt((s) => {
        if (s.key !== key || !s.items) return s;
        const m = mergeHead(s.items, page, s.next);
        return { ...s, items: m.items, next: m.next, hidden: page.hidden, total: page.total ?? s.total, error: null };
      });
    } catch { /* keep what's shown */ }
  }, [workspaceId, key]);

  /** The first page from scratch (after an import, a delete, a filter change). */
  const reload = useCallback((signal?: AbortSignal) => {
    const my = ++seq.current;
    prefetched.current = null;
    setSt((s) => ({ ...s, key, stale: s.key !== key && s.items !== null, error: null, moreError: false,
      ...(s.key !== key && s.items === null ? { items: null } : {}) }));
    return listMeetings(workspaceId, { ...queryRef.current, limit: MEETINGS_PAGE }, { signal })
      .then((p) => {
        if (my !== seq.current) return;
        setSt({ key, items: p.meetings, hidden: p.hidden, total: p.total, next: p.next_cursor, error: null, loadingMore: false, moreError: false, stale: false });
      })
      .catch((e: unknown) => {
        if (my !== seq.current || (e instanceof DOMException && e.name === "AbortError")) return;
        setSt((s) => ({ ...s, key, stale: false, items: s.items ?? [], error: e instanceof Error ? e.message : "Couldn't load the meetings." }));
      });
  }, [workspaceId, key]);

  useEffect(() => {
    if (!enabled) return;
    const s = SNAP.get(key);
    if (s && Date.now() - s.at < FRESH_MS) {
      // Shown from memory; revalidated quietly.
      ++seq.current;
      prefetched.current = null;
      setSt(fromSnap(key, s));
      void refreshHead();
      return;
    }
    const ctrl = new AbortController();
    void reload(ctrl.signal);
    return () => ctrl.abort();
  }, [enabled, key, reload, refreshHead]);

  const fetchPage = useCallback((cursor: string) => {
    const pre = prefetched.current;
    if (pre && pre.key === key && pre.cursor === cursor) {
      prefetched.current = null;
      return pre.p.catch(() => listMeetings(workspaceId, { ...queryRef.current, cursor }));
    }
    return listMeetings(workspaceId, { ...queryRef.current, cursor });
  }, [workspaceId, key]);

  const loadMore = useCallback(() => {
    const cur = stRef.current;
    if (!cur.next || cur.loadingMore || cur.stale || cur.key !== key) return;
    const cursor = cur.next;
    const my = seq.current;
    setSt((s) => ({ ...s, loadingMore: true, moreError: false }));
    fetchPage(cursor).then((p) => {
      if (my !== seq.current) return;
      setSt((s) => {
        if (s.next !== cursor || !s.items) return { ...s, loadingMore: false };
        const have = new Set(s.items.map((m) => m.id));
        return { ...s, items: [...s.items, ...p.meetings.filter((m) => !have.has(m.id))], next: p.next_cursor, loadingMore: false };
      });
    }).catch(() => {
      if (my === seq.current) setSt((s) => ({ ...s, loadingMore: false, moreError: true }));
    });
  }, [key, fetchPage]);

  // The next page, fetched while the browser is idle (shown when the reader gets there).
  useEffect(() => {
    const cursor = st.next;
    if (!enabled || !cursor || st.stale || st.loadingMore) return;
    if (prefetched.current?.key === key && prefetched.current.cursor === cursor) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    const go = () => {
      const p = listMeetings(workspaceId, { ...queryRef.current, cursor });
      p.catch(() => { /* loadMore asks again */ });
      prefetched.current = { key, cursor, p };
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(go, { timeout: 3000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(go, 800);
    return () => window.clearTimeout(t);
  }, [enabled, key, st.next, st.stale, st.loadingMore, workspaceId]);

  /** Take one meeting out of what's shown (deleted here). */
  const drop = useCallback((id: string) => {
    setSt((s) => ({ ...s, items: s.items?.filter((m) => m.id !== id) ?? null, hidden: s.hidden.filter((h) => h.id !== id),
      total: s.total !== null && s.items?.some((m) => m.id === id) ? s.total - 1 : s.total }));
  }, []);

  return {
    items: st.key === key || st.stale ? st.items : null,
    hidden: st.hidden, total: st.total, next: st.next, error: st.error,
    loadingMore: st.loadingMore, moreError: st.moreError, stale: st.stale,
    restoredScrollY: restored?.scrollY ?? 0,
    loadMore, refreshHead, reload, drop,
  };
}
