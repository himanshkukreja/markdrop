/**
 * Personal to-do pages' client (backend routers/todos.py, services/todo_pages.py): one page per person per team,
 * kept up to date from the team's calls (a section per company; ticking syncs with the call).
 *
 *   GET  /api/v1/me/todos                              your to-do pages across your teams (You › My to-dos)
 *   GET  /api/v1/workspaces/{ws}/teams/{team}/todos    the team's: leads see every member's, anyone else theirs
 *   POST /api/v1/todos/tick                            {block, done}
 *   GET  /api/v1/workspaces/{ws}/teams/{team}/todos/mine   do you have a page there (nothing is made)
 *   POST /api/v1/workspaces/{ws}/teams/{team}/todos/mine   "Create my to-dos" / "Refresh to-dos"
 *   POST /api/v1/workspaces/{ws}/teams/{team}/todos/all    leads: "Create for everyone"
 */
import { request } from "@/lib/workspaces";

export interface TodoSection {
  name: string;
  open: number;
  last_call: string | null;
}

export interface TodoCard {
  team: { id: string; name: string | null };
  workspace_id: string;
  workspace?: { id: string; name: string | null };
  user: { id: string; name: string; avatar_url: string | null };
  you: boolean;
  slug: string | null;
  href: string | null;
  title: string | null;
  open: number;
  sections: TodoSection[];
  updated_at: string | null;
}

export interface TeamTodos {
  team: { id: string; name: string | null };
  lead: boolean;
  member?: boolean;
  general?: boolean;
  pages: TodoCard[];
}

/** A team you're in where you have no to-do page yet (You › My to-dos shows "Create my to-dos"). */
export interface MissingTodo {
  team: { id: string; name: string | null; slug?: string | null };
  workspace_id: string;
  workspace?: { id: string; name: string | null };
}

export interface TodoStatus { exists: boolean; slug: string | null; href: string | null; open: number; updated_at: string | null }
export interface TodoRefresh { slug: string | null; href: string | null; open: number; added: number; created: boolean }

export const myTodos = (workspace?: string) =>
  request<{ pages: TodoCard[]; missing?: MissingTodo[] }>(`/api/v1/me/todos${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`);

export const teamTodos = (ws: string, team: string) =>
  request<TeamTodos>(`/api/v1/workspaces/${encodeURIComponent(ws)}/teams/${encodeURIComponent(team)}/todos`);

export const tickTodo = (block: string, done = true) =>
  request<{ done: boolean; slug: string; block: string }>(`/api/v1/todos/tick`, { method: "POST", body: JSON.stringify({ block, done }) });

const teamPath = (ws: string, team: string) => `/api/v1/workspaces/${encodeURIComponent(ws)}/teams/${encodeURIComponent(team)}/todos`;

export const myTodoStatus = (ws: string, team: string) => request<TodoStatus>(`${teamPath(ws, team)}/mine`);

export const refreshMyTodos = (ws: string, team: string) => request<TodoRefresh>(`${teamPath(ws, team)}/mine`, { method: "POST" });

export const createTeamTodos = (ws: string, team: string) =>
  request<{ created: number; skipped: number; members: number }>(`${teamPath(ws, team)}/all`, { method: "POST" });

/** The toast after Create / Refresh: "Added 2 new · 5 open", or "Up to date · 5 open". */
export function refreshMessage(r: Pick<TodoRefresh, "added" | "open">): string {
  return r.added > 0 ? `Added ${r.added} new · ${r.open} open` : `Up to date · ${r.open} open`;
}

/** "3 open · Acme, Globex +2" */
export function todoSummary(c: Pick<TodoCard, "open" | "sections">): string {
  const open = c.sections.filter((s) => s.open > 0).map((s) => s.name);
  if (!c.open) return "Nothing open";
  const names = open.slice(0, 2).join(", ") + (open.length > 2 ? ` +${open.length - 2}` : "");
  return `${c.open} open${names ? ` · ${names}` : ""}`;
}
