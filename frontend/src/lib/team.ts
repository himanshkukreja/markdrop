/**
 * Team's client (backend routers/team.py; .work/workspace-memory/SPEC.md):
 *
 *   GET    /api/v1/team/{ws}                       the board ({enabled:false, can_enable} when it's off)
 *   GET    /api/v1/team/{ws}/people/{userId}       a person's page
 *   GET    /api/v1/team/{ws}/projects/{key}        a project's page
 *   PUT    /api/v1/team/{ws}/me/focus              {text}
 *   PUT    /api/v1/team/{ws}/me/status             {text, emoji?, until?}
 *   POST   /api/v1/team/{ws}/facts/{id}/hide       DELETE: undo
 *   POST   /api/v1/team/{ws}/facts/{id}/correct    {text?}   DELETE: undo
 *
 * Every line arrives already filtered for the viewer (the server decides it from the meeting or page it
 * came from). Kept out of lib/api.ts (that one loads on public pages).
 */
import { request } from "@/lib/workspaces";

export type FactKind = "working_on" | "update" | "blocker" | "decision" | "action_item" | "target" | "status" | "role";
export type StatusState = "self" | "away" | "blocked" | "waiting" | "on_track" | "quiet";
export type DueState = "overdue" | "due_soon" | "upcoming";

export interface SourceLink {
  kind: "meeting" | "page" | "doc" | string;
  title: string;
  slug?: string;
  href: string;
  url?: string;
  date: string | null;
  series?: string | null;
  moment?: { href: string; url: string } | null;
}

export interface Line {
  id: string;
  kind: FactKind;
  label: string;
  text: string;
  original?: string;
  corrected: boolean;
  wrong: boolean;
  when: string | null;
  day: string;
  project: { key: string; name: string } | null;
  sources: SourceLink[];
  hidden: boolean;
  can_correct: boolean;
  subject: string;
  due?: string;
  due_state?: DueState | null;
  waiting_on?: { id: string | null; name: string } | null;
  person?: { id: string; name: string; avatar_url: string | null };
}

export interface Status {
  state: StatusState;
  label: string;
  emoji?: string | null;
  reason: string | null;
  fact: string | null;
  since: string | null;
  until?: string | null;
  waiting_on?: { id: string | null; name: string } | null;
  source?: { title: string; href: string; kind: string; date: string | null } | null;
}

export interface OwnStatus { text: string; emoji: string | null; until: string | null; at: string | null; away: boolean }
export interface NowLine { text: string; focus: boolean; when: string | null; fact: string | null }
export interface Target { id: string; text: string; due: string; state: DueState; source: Status["source"] }

export interface Card {
  id: string;
  name: string;
  avatar_url: string | null;
  role: string | null;
  title: string | null;
  you: boolean;
  status: Status;
  own_status: OwnStatus | null;
  now: NowLine | null;
  targets: Target[];
  open_items: number;
  due_week: number;
  overdue: number;
  activity: number[];
  projects: Array<{ key: string; name: string }>;
  updated_at: string | null;
  last_source: Status["source"];
  groups: string[];
}

export interface ProjectRow {
  key: string;
  name: string;
  status: string | null;
  people: Array<{ id: string; name: string }>;
  people_count: number;
  facts: number;
  blockers: number;
  updated_at: string | null;
}

export interface Lane {
  key: string;
  name: string;
  status: string | null;
  updated_at: string | null;
  people: Array<{ id: string; name: string; avatar_url: string | null; facts: number; latest: string | null; kind: FactKind | null; when: string | null }>;
}

export interface Blocker {
  person: { id: string; name: string; avatar_url: string | null };
  text: string;
  waiting_on: { id: string | null; name: string } | null;
  since: string | null;
  state: "blocked" | "waiting";
  source: Status["source"];
}

export interface Board {
  enabled: true;
  ai_on: boolean;
  workspace: { id: string; name: string };
  paused: { reason: string | null; at?: string | null; until?: string | null } | null;
  gathering: boolean;
  today: string;
  week_end: string;
  people: Card[];
  former: Array<{ id: string; name: string; archived: true }>;
  projects: ProjectRow[];
  lanes: Lane[];
  blockers: Blocker[];
  totals: { open_items: number; due_week: number; overdue: number; blocked: number; on_track: number; quiet: number };
  you: string;
  role: string;
  since: string | null;
}

export interface BoardOff { enabled: false; can_enable: boolean; role: string; workspace: { id: string; name: string } }

export interface Person {
  person: { id: string; name: string; avatar_url: string | null; role: string | null; title: string | null; you: boolean; archived: boolean };
  status: Status;
  own_status: OwnStatus | null;
  quiet_days: number | null;
  focus: { text: string; at: string | null } | null;
  now: NowLine | null;
  working_on: Line[];
  targets: Line[];
  updates: Line[];
  action_items: Line[];
  decisions: Line[];
  timeline: Array<{ day: string; items: Line[] }>;
  activity: number[];
  documents: Array<{ slug: string; title: string; href: string; updated_at: string | null; kind: string; mine: boolean }>;
  meetings: Array<{ slug: string; title: string; date: string | null; series: string | null; href: string }>;
  hidden: Line[];
  updated_at: string | null;
  last_source: Status["source"];
}

export interface Project {
  project: { key: string; name: string; first_seen: string | null; updated_at: string | null };
  status: Line | null;
  people: Array<{ id: string; name: string; avatar_url: string | null; facts: number }>;
  working_on: Line[];
  decisions: Line[];
  open_items: Line[];
  updates: Line[];
}

const base = (ws: string) => `/api/v1/team/${encodeURIComponent(ws)}`;

export const teamHref = (ws: string) => `/team/${encodeURIComponent(ws)}`;
export const personHref = (ws: string, uid: string) => `${teamHref(ws)}/people/${encodeURIComponent(uid)}`;
export const projectHref = (ws: string, key: string) => `${teamHref(ws)}/projects/${encodeURIComponent(key)}`;

export const getBoard = (ws: string) => request<Board | BoardOff>(base(ws));
export const getPerson = (ws: string, uid: string) => request<Person>(`${base(ws)}/people/${encodeURIComponent(uid)}`);
export const getProject = (ws: string, key: string) => request<Project>(`${base(ws)}/projects/${encodeURIComponent(key)}`);
export const setFocus = (ws: string, text: string) =>
  request<{ focus: { text: string; at: string } | null }>(`${base(ws)}/me/focus`, { method: "PUT", body: JSON.stringify({ text }) });
export const setStatus = (ws: string, body: { text: string; emoji?: string | null; until?: string | null }) =>
  request<{ status: OwnStatus | null }>(`${base(ws)}/me/status`, { method: "PUT", body: JSON.stringify(body) });
export const hideLine = (ws: string, id: string, on = true) =>
  request<{ id: string; hidden: boolean }>(`${base(ws)}/facts/${encodeURIComponent(id)}/hide`, { method: on ? "POST" : "DELETE" });
export const correctLine = (ws: string, id: string, text: string | null) =>
  text === null
    ? request(`${base(ws)}/facts/${encodeURIComponent(id)}/correct`, { method: "DELETE" })
    : request(`${base(ws)}/facts/${encodeURIComponent(id)}/correct`, { method: "POST", body: JSON.stringify({ text }) });

/** "Today", "Yesterday", "Nov 4" (this year) or "Nov 4, 2025" for a YYYY-MM-DD or ISO time. */
export function fmtDay(value: string | null | undefined, today = new Date()): string {
  if (!value) return "";
  const [y, m, d] = value.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return "";
  const date = new Date(y, m - 1, d);
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = Math.round((t0.getTime() - date.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff === -1) return "Tomorrow";
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (y !== today.getFullYear()) opts.year = "numeric";
  return date.toLocaleDateString(undefined, opts);
}

/** "Due Thu, Nov 5" / "Overdue · Nov 3" for a target chip. */
export function dueLabel(due: string, state: DueState | null | undefined, today = new Date()): string {
  const [y, m, d] = due.split("-").map(Number);
  const date = new Date(y!, (m ?? 1) - 1, d ?? 1);
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((date.getTime() - t0.getTime()) / 86400000);
  const day = days === 0 ? "today" : days === 1 ? "tomorrow" : date.toLocaleDateString(undefined, days > 0 && days < 7 ? { weekday: "short" } : { month: "short", day: "numeric" });
  return state === "overdue" ? `Overdue · ${fmtDay(due, today)}` : `Due ${day}`;
}

export const STATUS_ORDER: StatusState[] = ["blocked", "waiting", "on_track", "self", "away", "quiet"];
export const STATUS_LABEL: Record<StatusState, string> = {
  blocked: "Blocked", waiting: "Waiting on someone", on_track: "On track", self: "Own status", away: "Away", quiet: "Quiet lately",
};
