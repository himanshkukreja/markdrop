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
  /** As on "This week": due Mon–Sun (workspace time) / due before this week within the last two weeks. */
  week_due: number;
  week_overdue: number;
  overdue: number;
  activity: number[];
  projects: Array<{ key: string; name: string }>;
  updated_at: string | null;
  last_source: Status["source"];
  groups: string[];
  /** Comment threads assigned to them (backend services/comments/tasks.py), the ones you can open. */
  comment_tasks?: CommentTask[];
}

export interface CommentTask { thread_id: string; slug: string; title: string; href: string; excerpt: string | null; updated_at: string | null }

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
  totals: { open_items: number; due_week: number; overdue: number; week_due: number; week_overdue: number; blocked: number; on_track: number; quiet: number };
  you: string;
  role: string;
  since: string | null;
  groups: Group[];
  can_manage: boolean;
  this_week: ThisWeek | null;
}

export interface Group { id: string; name: string; member_ids: string[] }
export interface GroupSuggestion { name: string; member_ids: string[]; meetings: number }
export interface WeekPerson { id: string; name: string; avatar_url: string | null }
/** A commitment on the "This week" card: ``days`` is due minus today (workspace time; < 0 late). */
export interface WeekItem { id: string; person: WeekPerson; text: string; due: string; days: number; source: Status["source"] }
export interface WeekHighlight { text: string; kind?: FactKind; person: WeekPerson | null; day?: string; cites?: number[]; sources?: NonNullable<Status["source"]>[] }
/** "This week so far" (services/team_extras.py): Mon–Sun in the workspace's timezone. Highlights happened
 *  this week so far (``window: "week"``), or, before there are any (a Monday morning), last week Mon–Sun
 *  (``window: "last_week"``; ``highlights_from``–``highlights_to`` say which days); ``overdue`` is the last
 *  two weeks only. */
export interface ThisWeek {
  week: string; from: string; to: string; today?: string; window?: "week" | "last_week";
  highlights_from?: string; highlights_to?: string; at: string | null; live: boolean;
  highlights: WeekHighlight[];
  blockers: Array<{ person: WeekPerson; text: string | null; waiting_on: string | null; since: string | null; source: Status["source"] }>;
  due: WeekItem[];
  overdue: WeekItem[];
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
  comment_tasks?: CommentTask[];
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

export const listGroups = (ws: string) => request<{ groups: Group[]; suggestions: GroupSuggestion[] }>(`${base(ws)}/groups`);
export const createGroup = (ws: string, body: { name: string; member_ids: string[] }) =>
  request<Group>(`${base(ws)}/groups`, { method: "POST", body: JSON.stringify(body) });
export const updateGroup = (ws: string, id: string, body: { name: string; member_ids: string[] }) =>
  request<Group>(`${base(ws)}/groups/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) });
export const deleteGroup = (ws: string, id: string) => request(`${base(ws)}/groups/${encodeURIComponent(id)}`, { method: "DELETE" });
export const sendWeekly = (ws: string) =>
  request<{ week: string; delivery: { slack: string | null; emails: number }; highlights: number }>(`${base(ws)}/weekly/send`, { method: "POST" });

export const getBoard = (ws: string) => request<Board | BoardOff>(base(ws));
export const getPerson = (ws: string, uid: string) => request<Person>(`${base(ws)}/people/${encodeURIComponent(uid)}`);
export const getProject = (ws: string, key: string) => request<Project>(`${base(ws)}/projects/${encodeURIComponent(key)}`);
export const setFocus = (ws: string, text: string) =>
  request<{ focus: { text: string; at: string } | null }>(`${base(ws)}/me/focus`, { method: "PUT", body: JSON.stringify({ text }) });
export const setStatus = (ws: string, body: { text: string; emoji?: string | null; until?: string | null }) =>
  request<{ status: OwnStatus | null }>(`${base(ws)}/me/status`, { method: "PUT", body: JSON.stringify(body) });
export const hideLine = (ws: string, id: string, on = true) =>
  request<{ id: string; hidden: boolean }>(`${base(ws)}/facts/${encodeURIComponent(id)}/hide`, { method: on ? "POST" : "DELETE" });
export const markDone = (ws: string, id: string, on = true) =>
  request<{ id: string; done: boolean }>(`${base(ws)}/facts/${encodeURIComponent(id)}/done`, { method: on ? "POST" : "DELETE" });
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

/** "Nov 3–9", "Oct 27 – Nov 2" for a Monday..Sunday pair of YYYY-MM-DD dates. */
export function weekRange(from: string, to: string): string {
  const d = (v: string) => { const [y, m, dd] = v.split("-").map(Number); return new Date(y!, (m ?? 1) - 1, dd ?? 1); };
  const a = d(from), b = d(to);
  const mon = (x: Date) => x.toLocaleDateString("en-US", { month: "short" });
  if (from === to) return `${mon(a)} ${a.getDate()}`;
  return a.getMonth() === b.getMonth() ? `${mon(a)} ${a.getDate()}–${b.getDate()}` : `${mon(a)} ${a.getDate()} – ${mon(b)} ${b.getDate()}`;
}

/** "Today", "Tomorrow", "Fri", "2 days late" for a commitment ``days`` from today. */
export function dueWhen(item: Pick<WeekItem, "due" | "days">): string {
  const n = item.days;
  if (n < 0) return `${-n} day${n === -1 ? "" : "s"} late`;
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  const [y, m, d] = item.due.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, { weekday: "short" });
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
