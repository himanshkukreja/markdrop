/**
 * Person cards and "what changed since I last looked" (AI quality stage 4; backend routers/glance.py).
 *
 *   GET  /api/v1/people/{user_id}/card?workspace=        one member at a glance, as you may see them
 *   POST /api/v1/workspaces/{ws}/visit {space?}          mark a look (workspace Home, a team, a project)
 *   GET  /api/v1/workspaces/{ws}/changes?team=&project=  what changed since you last looked (Home widget)
 *
 * Everything is decided for the viewer on the server; the UI never filters for privacy.
 */
import { request } from "@/lib/workspaces";

export interface PersonCardData {
  id: string;
  name: string;
  avatar_url?: string | null;
  role?: string | null;
  title?: string | null;
  you?: boolean;
  workspace_id: string;
  profile_url: string;
  teams: { id: string; name: string; lead: boolean }[];
  created: { total: number; items: { title: string; kind?: string; url: string | null; updated?: string | null; status?: string | null }[] };
  meetings: { days: number; total: number; items: { title: string; date?: string | null; url: string | null }[] };
  open_items: { total: number; likely_done: number; items: { text: string; on?: string | null; url: string | null; due?: string | null; likely_done?: string | null }[] };
  working_on: string[];
}

const cards = new Map<string, { at: number; p: Promise<PersonCardData> }>();
const TTL = 60_000;

/** A person's card (cached a minute per person and workspace; a failure isn't cached). */
export function getPersonCard(userId: string, workspace?: string | null): Promise<PersonCardData> {
  const key = `${userId}|${workspace ?? ""}`;
  const hit = cards.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
  const p = request<PersonCardData>(`/api/v1/people/${encodeURIComponent(userId)}/card${q}`);
  cards.set(key, { at: Date.now(), p });
  p.catch(() => cards.delete(key));
  return p;
}

export type Space = { team?: string | null; project?: string | null };

function spaceOf(s?: Space): string | null {
  if (s?.project) return `project:${s.project}`;
  if (s?.team) return `team:${s.team}`;
  return null;
}

const marked = new Set<string>();

/** Mark that the person is looking at the workspace (or a team / project): once per page load each. */
export function markVisit(workspace: string, space?: Space): void {
  const sp = spaceOf(space);
  const key = `${workspace}|${sp ?? ""}`;
  if (marked.has(key)) return;
  marked.add(key);
  void request(`/api/v1/workspaces/${encodeURIComponent(workspace)}/visit`, { method: "POST", body: JSON.stringify(sp ? { space: sp } : {}), keepalive: true })
    .catch(() => marked.delete(key));
}

export interface ChangeMeeting { key?: string; title: string; date?: string | null; series?: string | null; url: string | null; summary?: string | null; teams?: string[] }
export interface ChangeDoc { key?: string; title: string; kind?: string; url: string | null; at?: string | null; by?: string | null; status?: string | null }
export interface ChangeDecision { key?: string; text: string; meeting?: string | null; date?: string | null; url: string | null }
export interface ChangeAction { key?: string; text: string; done: boolean; on?: string | null; owner?: string | null; due?: string | null; url: string | null }
export interface ChangeComment { key?: string; on: string; status?: string; by?: string | null; text?: string | null; at?: string | null; url: string | null }
export interface Changes {
  workspace_id: string;
  since: string;
  basis: "visit" | "default" | "given";
  space: string;
  totals: Record<"meetings" | "decisions" | "documents_new" | "documents_updated" | "action_items" | "comments", number>;
  meetings: ChangeMeeting[];
  decisions: ChangeDecision[];
  documents_new: ChangeDoc[];
  documents_updated: ChangeDoc[];
  action_items: ChangeAction[];
  comments: ChangeComment[];
}

export function getChanges(workspace: string, space?: Space & { limit?: number }): Promise<Changes> {
  const p = new URLSearchParams();
  if (space?.team) p.set("team", space.team);
  if (space?.project) p.set("project", space.project);
  if (space?.limit) p.set("limit", String(space.limit));
  const q = p.toString();
  return request<Changes>(`/api/v1/workspaces/${encodeURIComponent(workspace)}/changes${q ? `?${q}` : ""}`);
}
