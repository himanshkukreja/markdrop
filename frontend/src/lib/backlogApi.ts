/**
 * Team backlogs' client (backend routers/backlog.py, services/team_backlog.py): one page per team, filled from the
 * team's calls. The page itself is an ordinary page; these are its counts and the leads' Refresh.
 *
 *   GET   /api/v1/workspaces/{ws}/teams/{team}/backlog            link, counts, private-call count (leads)
 *   POST  /api/v1/workspaces/{ws}/teams/{team}/backlog/refresh    leads: re-read every call now
 *   POST  /api/v1/workspaces/{ws}/teams/{team}/backlog/priorities members: [{id | block, priority}]
 *   PATCH /api/v1/backlog/items/{id}                              {category, status, owner, text, priority}
 */
import { request } from "@/lib/workspaces";

export interface BacklogStatus {
  enabled: boolean;
  exists: boolean;
  slug: string | null;
  href: string | null;
  open: number;
  counts: Record<string, number>;
  /** Leads only: open items only from calls restricted to their attendees (kept off the page). */
  private: number | null;
  lead: boolean;
  updated_at: string | null;
}

export interface BacklogRefresh {
  slug: string | null;
  href: string | null;
  meetings: number;
  added: number;
  merged: number;
  open: number;
  waiting: number;
}

const base = (ws: string, team: string) => `/api/v1/workspaces/${encodeURIComponent(ws)}/teams/${encodeURIComponent(team)}/backlog`;

export const backlogStatus = (ws: string, team: string) => request<BacklogStatus>(base(ws, team));
export interface PrioritiesResult { changed: { id: string; block: string; priority: string; priority_label: string }[]; failed: { id: string; error: string }[] }
/** A person's priorities (they win): `id` is the item's id or its block id. One page rewrite on the server. */
export const setPriorities = (ws: string, team: string, changes: { id: string; priority: string }[]) =>
  request<PrioritiesResult>(`${base(ws, team)}/priorities`, { method: "POST", body: JSON.stringify({ changes }) });
export const refreshBacklog = (ws: string, team: string) => request<BacklogRefresh>(`${base(ws, team)}/refresh`, { method: "POST" });

/** "Added 3 new · 12 open", or "Up to date · 12 open". */
export function refreshMessage(r: BacklogRefresh): string {
  return `${r.added ? `Added ${r.added} new` : "Up to date"} · ${r.open} open`;
}
