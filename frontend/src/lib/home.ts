/**
 * The signed-in home (/dashboard): `GET /api/v1/home` (backend services/home.py) and ticking a to-do.
 * Every list is already decided for the caller by the server; the UI never filters for privacy.
 * Kept out of lib/api.ts (that one loads on public pages).
 */
import { request } from "@/lib/workspaces";
import type { AppNotification } from "@/lib/notifications";

export interface HomeAction {
  text: string;
  slug: string;
  block: string | null;
  title: string;
  url: string;
  workspace: { id: string; name: string } | null;
  meeting: boolean;
  updated_at: string | null;
  /** When the to-do was set: the meeting's date for meeting notes, else the page's last change (YYYY-MM-DD). The list is newest first by it. */
  date?: string | null;
  can_tick: boolean;
  /** A comment thread assigned to you (backend services/comments/tasks.py): ticking resolves it. */
  kind?: "comment";
  thread_id?: string;
  quote?: string | null;
}

export interface HomeMeeting {
  id: string;
  workspace_id: string;
  workspace_name: string;
  title: string | null;
  page_title: string | null;
  slug: string;
  date: string | null;
  time: string | null;
  duration_s: number | null;
  type: string | null;
  series: string | null;
  attendees: Array<{ name: string }>;
  attendee_count: number;
  action_items: number;
  summary?: string | null;
  decisions?: number;
  open_questions?: number;
  cover?: string | null;
  restricted: boolean;
  ai: { state: string | null };
}

export interface HomePerson { name: string | null; picture: string | null; is_you: boolean }

export interface HomeWorkspace {
  id: string;
  name: string;
  role: "owner" | "admin" | "member" | "viewer";
  branding: { logo_url: string | null; site_name: string | null; accent_color: string | null; logo_well?: string | null };
  member_count: number;
  item_count: number;
  meetings: number;
  can_import: boolean;
  people: HomePerson[];
}

export interface HomeRequest {
  id: string;
  requester: { email: string; name: string | null };
  role_requested?: "viewer" | "editor";
  created_at: string;
  document: { slug: string; title: string | null };
}

export interface HomeData {
  attention: { notifications: AppNotification[]; unread: number; requests: HomeRequest[]; requests_count: number };
  /** hidden: open to-dos past the 30 sent (the count still includes them). */
  actions: { items: HomeAction[]; more: boolean; hidden?: number };
  meetings: { items: HomeMeeting[]; today: string };
  workspaces: HomeWorkspace[];
  meet: { connected: boolean; workspace_id: string | null };
  /** Comment threads waiting on you: assigned to you, mentioning you, or answered on yours. */
  comments?: { waiting: import("@/lib/comments").MyThread[]; waiting_count: number };
}

export function getHome(): Promise<HomeData> {
  return request<HomeData>("/api/v1/home");
}

/** Mark one of your to-dos done (`done: false`: open it again). Throws (with the server's words) on
 *  403 / 404 / 409 / 423. */
export function tickAction(slug: string, block: string, done = true): Promise<{ done: boolean }> {
  return request<{ done: boolean }>("/api/v1/home/actions/tick", { method: "POST", body: JSON.stringify({ slug, block, done }) });
}
