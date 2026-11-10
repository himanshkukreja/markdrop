"use client";

/**
 * Favorites (backend services/favorites.py): a person's starred pages, files, projects and teams per workspace,
 * shown at the top of the sidebar. `GET|PUT /api/v1/workspaces/{ws}/favorites`.
 *
 * The sidebar keeps one copy per workspace here (refetched on focus and after a change), like lib/teamsStore.
 */
import { useEffect, useSyncExternalStore } from "react";
import { request } from "@/lib/workspaces";

export type FavoriteKind = "doc" | "project" | "team";
export interface Favorite {
  kind: FavoriteKind;
  /** doc: slug; team / project: id. */
  ref: string;
  title: string | null;
  href: string;
  icon?: string | null;
  color?: string | null;
  general?: boolean;
  editor?: string | null;
  doc_kind?: "page" | "markdown" | "artifact";
  mime?: string | null;
  filename?: string | null;
  renderer?: string | null;
}

const base = (ws: string) => `/api/v1/workspaces/${encodeURIComponent(ws)}/favorites`;
export const getFavorites = (ws: string) => request<{ favorites: Favorite[] }>(base(ws));
export const putFavorite = (ws: string, kind: FavoriteKind, ref: string, on: boolean) =>
  request<{ favorites: Favorite[] }>(base(ws), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, ref, on }) });

type Slot = Favorite[] | null | false;
const slots = new Map<string, Slot>();
const fetchedAt = new Map<string, number>();
const subs = new Set<() => void>();
let version = 0;
const emit = () => { version++; for (const s of subs) s(); };

export function favoritesSlot(ws: string): Slot | undefined { return slots.get(ws); }
export function isFavorite(ws: string, kind: FavoriteKind, ref: string): boolean {
  const s = slots.get(ws);
  return !!s && s.some((f) => f.kind === kind && f.ref === ref);
}

export function refreshFavorites(ws: string, maxAge = 0): void {
  if (slots.get(ws) && Date.now() - (fetchedAt.get(ws) ?? 0) < maxAge) return;
  if (!slots.has(ws)) { slots.set(ws, null); emit(); }
  fetchedAt.set(ws, Date.now());
  getFavorites(ws).then((r) => slots.set(ws, r.favorites)).catch(() => { if (!slots.get(ws)) slots.set(ws, false); }).finally(emit);
}

/** Star / unstar; the sidebar updates at once (optimistic), then with the server's list. */
export async function toggleFavorite(ws: string, kind: FavoriteKind, ref: string, on: boolean, draft?: Partial<Favorite>): Promise<void> {
  const before = slots.get(ws);
  const list = before || [];
  slots.set(ws, on ? [...list.filter((f) => !(f.kind === kind && f.ref === ref)), { kind, ref, title: null, href: "#", ...draft }]
    : list.filter((f) => !(f.kind === kind && f.ref === ref)));
  emit();
  try {
    const r = await putFavorite(ws, kind, ref, on);
    slots.set(ws, r.favorites);
  } catch (e) {
    slots.set(ws, before ?? null);
    throw e;
  } finally {
    emit();
  }
}

/** Keeps a workspace's favorites loaded (10 s on mount / navigation, 60 s on focus); returns a version. */
export function useFavorites(ws: string | null, navKey?: string): number {
  const v = useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => version, () => 0);
  useEffect(() => {
    if (!ws) return;
    refreshFavorites(ws, 10_000);
    const onFocus = () => { if (document.visibilityState !== "hidden") refreshFavorites(ws, 60_000); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [ws, navKey]);
  return v;
}
