"use client";

/**
 * The sidebar's copy of `GET /teams` per workspace (contract §7: no workspace socket — it refetches on window
 * focus, on navigation and after any teams mutation in the app, lib/teams `teamsChanged`). A slot is
 * undefined (never asked), null (loading the first time), false (failed: the rail shows the workspace as
 * before teams) or the data. Stale data stays on screen while it refreshes, so the rail never blanks.
 */
import { useEffect, useSyncExternalStore } from "react";
import { getTeams, TEAMS_EVENT, type TeamsSidebar } from "@/lib/teams";

type Slot = TeamsSidebar | null | false;
const slots = new Map<string, Slot>();
const fetchedAt = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();
const subs = new Set<() => void>();
let version = 0;
const emit = () => { version++; for (const s of subs) s(); };

export function teamsSlot(ws: string): Slot | undefined { return slots.get(ws); }

export function refreshTeams(ws: string, maxAge = 0): Promise<void> {
  const at = fetchedAt.get(ws) ?? 0;
  if (slots.get(ws) && Date.now() - at < maxAge) return Promise.resolve();
  const running = inflight.get(ws);
  if (running) return running;
  if (!slots.has(ws)) { slots.set(ws, null); emit(); }
  const p = getTeams(ws)
    .then((d) => { slots.set(ws, d); })
    .catch(() => { if (!slots.get(ws)) slots.set(ws, false); })
    .finally(() => { fetchedAt.set(ws, Date.now()); inflight.delete(ws); emit(); });
  inflight.set(ws, p);
  return p;
}

if (typeof window !== "undefined") {
  window.addEventListener(TEAMS_EVENT, (e) => {
    const ws = (e as CustomEvent<{ ws?: string }>).detail?.ws;
    for (const id of ws ? [ws] : [...slots.keys()]) void refreshTeams(id);
  });
}

/** Keeps the given workspaces' teams loaded (refetch after 10 s on mount / navigation, after 60 s on focus). */
export function useTeamsSidebar(wsIds: string[], navKey?: string): number {
  const v = useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => version, () => 0);
  const sig = wsIds.join(",");
  useEffect(() => {
    const ids = sig ? sig.split(",") : [];
    for (const id of ids) void refreshTeams(id, 10_000);
    const onFocus = () => { if (document.visibilityState !== "hidden") for (const id of ids) void refreshTeams(id, 60_000); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, [sig, navKey]);
  return v;
}
