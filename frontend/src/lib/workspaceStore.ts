"use client";

/**
 * One shared copy of each workspace's folder tree, for every surface that shows it: the rail,
 * the folder view, the "Move to…" picker, the Share dialog's Location row and the location chips
 * on personal rows. Before this, each surface fetched its own folders once and never again, so a
 * folder made in one place didn't appear in the rail until a reload (P2 "sidebar never reloads").
 *
 * The rule is simple: whoever changes a workspace calls `workspaceChanged(id)`. That refetches the
 * tree (every subscriber re-renders with the new counts) and fires a window event that item lists
 * listen to (`useWorkspaceChanged`). No polling, no cross-tab sync.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getWorkspaceTree, type TreeFolder, type WorkspaceTree } from "@/lib/workspaces";

interface Entry {
  tree: WorkspaceTree | null;
  error: unknown;
  loading: boolean;
  /** Bumped on every successful load (subscribers compare it to decide whether to refetch items). */
  version: number;
}

const EMPTY: Entry = { tree: null, error: null, loading: false, version: 0 };
const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

const CHANGE_EVENT = "md:workspace-change";
const DOCS_EVENT = "md:docs-change";

function emit() {
  for (const l of listeners) l();
}

function set(id: string, patch: Partial<Entry>) {
  entries.set(id, { ...(entries.get(id) ?? EMPTY), ...patch });
  emit();
}

/** Fetch (or refetch) a workspace's tree. Concurrent calls share one request. */
export function loadTree(id: string): Promise<void> {
  const running = inflight.get(id);
  if (running) return running;
  set(id, { loading: true });
  const p = getWorkspaceTree(id)
    .then((tree) => set(id, { tree, error: null, loading: false, version: (entries.get(id)?.version ?? 0) + 1 }))
    .catch((error) => set(id, { error, loading: false }))
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The tree for `id` (fetched on first use), and a reload. `id` null = nothing. */
export function useWorkspaceTree(id: string | null | undefined) {
  const entry = useSyncExternalStore(
    subscribe,
    () => (id ? entries.get(id) ?? EMPTY : EMPTY),
    () => EMPTY,
  );
  useEffect(() => {
    if (!id) return;
    const e = entries.get(id);
    if (!e || (!e.tree && !e.loading && !e.error)) void loadTree(id);
  }, [id]);
  const reload = useCallback(() => (id ? loadTree(id) : Promise.resolve()), [id]);
  return { ...entry, reload };
}

/** Prime several trees at once (e.g. the workspaces on a page of personal rows). */
export function useWorkspaceTrees(ids: string[]) {
  const key = [...new Set(ids)].sort().join(",");
  const snapshot = useSyncExternalStore(
    subscribe,
    () => snapshotFor(key),
    () => EMPTY_MAP,
  );
  useEffect(() => {
    for (const id of key ? key.split(",") : []) {
      const e = entries.get(id);
      if (!e || (!e.tree && !e.loading && !e.error)) void loadTree(id);
    }
  }, [key]);
  return snapshot;
}

/** Per workspace: the tree, null while unknown, or false when it failed to load. */
export type TreeSlot = WorkspaceTree | null | false;
const EMPTY_MAP: Record<string, TreeSlot> = {};
const slot = (id: string): TreeSlot => { const e = entries.get(id); return e?.tree ?? (e?.error && !e.loading ? false : null); };
// One cached snapshot per key: several components subscribe with different keys at once, and
// useSyncExternalStore needs each one's snapshot to stay identical while nothing changed.
const snaps = new Map<string, Record<string, TreeSlot>>();
function snapshotFor(key: string): Record<string, TreeSlot> {
  if (!key) return EMPTY_MAP;
  const ids = key.split(",");
  const prev = snaps.get(key);
  if (prev && ids.every((id) => prev[id] === slot(id))) return prev;
  const next: Record<string, TreeSlot> = {};
  for (const id of ids) next[id] = slot(id);
  if (snaps.size > 50) snaps.clear();
  snaps.set(key, next);
  return next;
}

/**
 * Something in workspace `id` changed (a folder was made, renamed, moved or deleted; items were
 * moved, added or removed; a share was turned on or off). Refreshes the shared tree and tells
 * every item list showing that workspace to reload.
 */
export function workspaceChanged(id: string) {
  void loadTree(id);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { id } }));
}

/** Personal documents changed (moved into or out of a workspace, access changed): rail counts and
 *  the personal list reload. */
export function documentsChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DOCS_EVENT));
}

/** Run `cb` whenever `workspaceChanged(id)` is called (any id when `id` is "*"). */
export function useWorkspaceChanged(id: string | null | undefined, cb: () => void) {
  useEffect(() => {
    if (!id) return;
    const on = (e: Event) => {
      const changed = (e as CustomEvent<{ id: string }>).detail?.id;
      if (id === "*" || changed === id) cb();
    };
    window.addEventListener(CHANGE_EVENT, on);
    return () => window.removeEventListener(CHANGE_EVENT, on);
  }, [id, cb]);
}

export function useDocumentsChanged(cb: () => void) {
  useEffect(() => {
    window.addEventListener(DOCS_EVENT, cb);
    return () => window.removeEventListener(DOCS_EVENT, cb);
  }, [cb]);
}

/* ── Tree helpers ─────────────────────────────────────────────────────── */

/** Children by parent id (null = the top level), each sorted by name. */
export function childrenMap(folders: TreeFolder[]): Map<string | null, TreeFolder[]> {
  const ids = new Set(folders.map((f) => f.id));
  const m = new Map<string | null, TreeFolder[]>();
  for (const f of folders) {
    // A folder whose parent isn't in the list (shouldn't happen) shows at the top, never vanishes.
    const p = f.parent_id && ids.has(f.parent_id) ? f.parent_id : null;
    if (!m.has(p)) m.set(p, []);
    m.get(p)!.push(f);
  }
  for (const list of m.values()) list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return m;
}

/** The folder and its ancestors, root first. */
export function ancestry(folders: TreeFolder[], id: string | null | undefined): TreeFolder[] {
  if (!id) return [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: TreeFolder[] = [];
  let cur = byId.get(id);
  let guard = 0;
  while (cur && guard++ < 32) {
    out.unshift(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return out;
}

/** Every folder id under `id` (not including it). */
export function descendants(folders: TreeFolder[], id: string): Set<string> {
  const kids = childrenMap(folders);
  const out = new Set<string>();
  const walk = (p: string) => {
    for (const c of kids.get(p) ?? []) {
      if (out.has(c.id)) continue;
      out.add(c.id);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

/** How many levels a folder's subtree spans (a leaf is 1). */
export function subtreeHeight(folders: TreeFolder[], id: string): number {
  const kids = childrenMap(folders);
  const h = (p: string, guard: number): number =>
    guard > 32 ? 1 : 1 + Math.max(0, ...(kids.get(p) ?? []).map((c) => h(c.id, guard + 1)));
  return h(id, 0);
}

/** "Acme › Guides › Q3" style label parts for a folder id. */
export function folderTrail(tree: WorkspaceTree | null | undefined, folderId: string | null | undefined): string[] {
  if (!tree) return [];
  return ancestry(tree.folders, folderId).map((f) => f.name);
}
