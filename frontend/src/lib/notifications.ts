/**
 * The signed-in person's notifications (backend services/notifications.py, routers/notifications.py):
 * someone mentioned them on a page, asked for their sign-off, or shared a page with them.
 *
 * The server decides what each row may show: a page the reader can no longer open comes back with
 * `available: false` and no title, link or excerpt, and opening it is refused (403).
 */
import { API_BASE } from "@/lib/api";

const TOKEN_KEY = "markdrop_token";

function authHeaders(): Record<string, string> {
  const t = typeof window === "undefined" ? null : localStorage.getItem(TOKEN_KEY);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export class NotificationError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new NotificationError(typeof body?.detail === "string" ? body.detail : `Request failed (${res.status})`, res.status);
  }
  return res.json();
}

export type NotificationKind = "mention" | "signoff_requested" | "shared";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  read: boolean;
  created_at: string;
  actor: { id: string | null; name: string; picture: string | null };
  /** Written by an AI app on the actor's behalf (MCP). */
  via_ai: boolean;
  /** The whole sentence, e.g. `Ada mentioned you in “Launch plan”`. */
  text: string;
  /** False when the reader can't open the page now: no page, href, excerpt, label or message. */
  available: boolean;
  page: { slug: string; title: string } | null;
  block: string | null;
  /** `/<slug>#b-…`, relative to the app. */
  href: string | null;
  excerpt: string | null;
  label: string | null;
  message: string | null;
}

export interface NotificationPage {
  items: AppNotification[];
  unread_count: number;
  next_before: string | null;
}

export const listNotifications = (opts: { unreadOnly?: boolean; limit?: number; before?: string } = {}) => {
  const q = new URLSearchParams();
  if (opts.unreadOnly) q.set("unread_only", "true");
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.before) q.set("before", opts.before);
  const s = q.toString();
  return request<NotificationPage>(`/api/v1/notifications${s ? `?${s}` : ""}`);
};

export const unreadCount = () =>
  request<{ unread_count: number }>("/api/v1/notifications/unread-count").then((r) => r.unread_count);

export const markRead = (ids: string[] | "all") =>
  request<{ marked: number; unread_count: number }>("/api/v1/notifications/read", {
    method: "POST",
    body: JSON.stringify(ids === "all" ? { all: true } : { ids }),
  });

/** Marks it read and says where to go; a page closed to the reader now is a 403 NotificationError. */
export const openNotification = (id: string) =>
  request<{ href: string; slug: string; block: string | null }>(`/api/v1/notifications/${encodeURIComponent(id)}/open`, {
    method: "POST",
  });
