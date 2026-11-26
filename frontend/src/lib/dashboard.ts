/**
 * The customizable Home (backend routers/dashboards.py; layout operations in lib/dashboardCore.mjs).
 *
 *   GET    /api/v1/me/dashboard?workspace=<id|auto>   the layout, resolved for you, with the catalog and templates
 *   PUT    /api/v1/me/dashboard                       {workspace, main, side} | {workspace, preset}
 *   DELETE /api/v1/me/dashboard?workspace=<id>        reset
 *   PUT    /api/v1/workspaces/{ws}/dashboard-default  admins
 *
 * The last layout is kept on this device (per person and workspace), so Home draws its cards at once and
 * every card starts its own request without waiting for the layout. Team homes are shared between cards
 * (a team's brief and its "Who's doing what" are one request).
 */
import { request } from "@/lib/workspaces";
import { getTeamHome, type TeamHome, type TeamHomeLocked } from "@/lib/teams";
import type { CatalogEntry, Layout, Widget } from "@/lib/dashboardCore.mjs";
import { toBody } from "@/lib/dashboardCore.mjs";

export type { CatalogEntry, Layout, Widget };

export interface Preset { id: string; label: string; description: string }
export interface Dashboard extends Layout {
  workspace: { id: string; name: string | null; role: string | null } | null;
  source: "mine" | "workspace" | "default";
  updated_at: string | null;
  can_set_default: boolean;
  has_workspace_default: boolean;
  max: number;
  catalog?: CatalogEntry[];
  presets?: Preset[];
}

const URL_ = "/api/v1/me/dashboard";
const enc = encodeURIComponent;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const getDashboard = (workspace: string | "auto" | null) =>
  request<Dashboard>(`${URL_}${workspace ? `?workspace=${enc(workspace)}` : ""}`);
export const saveDashboard = (workspace: string | null, layout: Layout) =>
  request<Dashboard>(URL_, json("PUT", { workspace, ...toBody(layout) }));
export const applyPreset = (workspace: string | null, preset: string) =>
  request<Dashboard>(URL_, json("PUT", { workspace, preset }));
export const resetDashboard = (workspace: string | null) =>
  request<Dashboard>(`${URL_}${workspace ? `?workspace=${enc(workspace)}` : ""}`, { method: "DELETE" });
export const setWorkspaceDefault = (workspace: string, layout: Layout) =>
  request<Dashboard>(`/api/v1/workspaces/${enc(workspace)}/dashboard-default`, json("PUT", toBody(layout)));
export const clearWorkspaceDefault = (workspace: string) =>
  request<Dashboard>(`/api/v1/workspaces/${enc(workspace)}/dashboard-default`, { method: "DELETE" });

/* ── This device's copy ─────────────────────────────────────────────────── */

const KEY = "md_home_layout_v1";
const RAIL_WS = "md_rail_ws";

/** The workspace the sidebar showed last on this device (SideNav's md_rail_ws), else null. */
export function savedWorkspace(): string | null {
  try { return localStorage.getItem(RAIL_WS); } catch { return null; }
}

type Cached = { user: string; ws: string | null; d: Dashboard };
export function cachedDashboard(user: string, ws: string | null | "auto"): Dashboard | null {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || "null") as Cached | null;
    if (!c || c.user !== user) return null;
    if (ws !== "auto" && c.ws !== ws) return null;
    return c.d;
  } catch { return null; }
}
export function cacheDashboard(user: string, d: Dashboard): void {
  try { localStorage.setItem(KEY, JSON.stringify({ user, ws: d.workspace?.id ?? null, d } satisfies Cached)); } catch { /* storage off */ }
}

/* ── Shared team homes ──────────────────────────────────────────────────── */

const teamHomes = new Map<string, { at: number; p: Promise<TeamHome | TeamHomeLocked> }>();
/** A team's home (brief, recent, meetings, memory; General: activity), shared by every card for 30 s. */
export function teamHomeOnce(ws: string, team: string, fresh = false): Promise<TeamHome | TeamHomeLocked> {
  const k = `${ws}:${team}`;
  const hit = teamHomes.get(k);
  if (hit && !fresh && Date.now() - hit.at < 30_000) return hit.p;
  const p = getTeamHome(ws, team);
  teamHomes.set(k, { at: Date.now(), p });
  p.catch(() => teamHomes.delete(k));
  return p;
}

/* ── Backlog items (routers/backlog.py) ─────────────────────────────────── */

export interface BacklogItemRow {
  id: string; block: string; text: string; category: string; category_label: string; status: string; status_label: string;
  owner: { id: string; name: string } | null; company: string | null; mentions: number; href: string | null;
  priority: string; priority_label: string; priority_source: string; priority_why: string | null;
  first_seen: string | null; last_seen: string | null;
}
export const backlogItems = (ws: string, team: string,
  q: { category?: string | null; status?: string | null; priority?: string | null; since?: string | null; sort?: string | null }) => {
  const p = new URLSearchParams();
  if (q.category) p.set("category", q.category);
  if (q.priority) p.set("priority", q.priority);
  if (q.since) p.set("since", q.since);
  if (q.sort) p.set("sort", q.sort);
  if (q.status) p.set("status", q.status);
  else p.set("include_done", "false");
  return request<{ items: BacklogItemRow[]; private: number | null }>(
    `/api/v1/workspaces/${enc(ws)}/teams/${enc(team)}/backlog/items?${p.toString()}`);
};

export const widgetOf = (d: Layout, id: string): Widget | undefined => [...d.main, ...d.side].find((w) => w.id === id);
