/**
 * Comments on pages and markdown documents (backend routers/comments.py; CONTRACT §5).
 * Threads anchored to selected text, a whole block, or the page. The server decides who may see, write,
 * resolve and manage them; this file only carries what it says.
 */
import { API_BASE, getToken } from "@/lib/api";

export interface Person {
  id: string | null;
  name: string;
  picture: string | null;
}

export interface Quote {
  exact: string;
  prefix?: string | null;
  suffix?: string | null;
}

export type AnchorIn =
  | { type: "text"; block_id?: string | null; block_text?: string | null; quote: Quote; start?: number | null }
  | { type: "block"; block_id?: string | null; block_text: string }
  | { type: "page" };

export interface Anchor {
  type: "text" | "block" | "page";
  block_id: string | null;
  quote: Quote | null;
  block_text: string | null;
  start: number | null;
}

export interface Reaction {
  emoji: string;
  count: number;
  mine: boolean;
  names: string[];
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  url?: string | null;
}

export interface Message {
  id: string;
  thread_id: string;
  author: Person;
  body: string;
  mentions: Person[];
  attachments: Attachment[];
  reactions: Reaction[];
  created_at: string;
  edited_at: string | null;
  deleted: boolean;
  via_ai: boolean;
  ai: boolean;
  kind: "comment" | "system";
  can: { edit: boolean; delete: boolean };
}

export interface Suggestion {
  text: string;
  state: "open" | "accepted" | "rejected" | "stale";
  by: Person;
  at: string;
  decided_by: Person | null;
  decided_at: string | null;
  version_id: string | null;
}

export interface ThreadHistory {
  action: string;
  by: Person | null;
  at: string;
  to: Person | null;
  version_id: string | null;
}

export interface Thread {
  id: string;
  anchor: Anchor;
  original: { exact: string | null; block_text: string | null };
  anchor_status: "attached" | "changed";
  status: "open" | "resolved";
  created_by: Person;
  created_at: string;
  updated_at: string;
  resolved_by: Person | null;
  resolved_at: string | null;
  assignee: Person | null;
  assigned_at: string | null;
  message_count: number;
  messages: Message[];
  suggestion: Suggestion | null;
  history: ThreadHistory[];
  can: { reply: boolean; resolve: boolean; reopen: boolean; assign: boolean; accept: boolean; delete: boolean };
}

export interface CommentPermsDto {
  eligible: boolean;
  enabled: boolean;
  view: boolean;
  comment: boolean;
  resolve_any: boolean;
  accept: boolean;
  assign: boolean;
  settings: boolean;
  moderate: boolean;
  reason: "signin" | "encrypted" | "ownerless" | "off" | "workspace_off" | "no_access" | "not_supported" | null;
}

export interface CommentsList {
  enabled: boolean;
  public: boolean;
  can: CommentPermsDto;
  counts: { open: number; resolved: number };
  rev: number;
  threads: Thread[];
}

/** `DocumentResponse.comments`: null when the item can't have comments (or the reader may not know). */
export interface DocComments {
  enabled: boolean;
  public: boolean;
  open: number | null;
  can_view: boolean;
  can_comment: boolean;
  reason: CommentPermsDto["reason"];
  /** The owner may change the switches. */
  settings?: boolean;
}

export interface MentionCandidate {
  id: string;
  name: string;
  picture: string | null;
  email?: string | null;
  has_access: boolean;
  you?: boolean;
}

export interface PeopleResult {
  people: MentionCandidate[];
  invite: null | { email: string; has_access: false; can_share: boolean };
}

export interface MyThread {
  thread_id: string;
  slug: string;
  title: string;
  href: string;
  url: string;
  excerpt: string | null;
  status: "open" | "resolved";
  assignee: Person | null;
  last: { author: Person; body_excerpt: string; at: string } | null;
  waiting_reason: "assigned" | "mentioned" | "reply";
}

export class CommentsApiError extends Error {
  constructor(message: string, public status: number, public code: string | null = null, public body: Record<string, unknown> = {}) {
    super(message);
    this.name = "CommentsApiError";
  }
}

const enc = encodeURIComponent;

export interface CallOpts {
  readPassword?: string | null;
  workspace?: string | null;
}

async function call<T>(path: string, init: RequestInit = {}, opts: CallOpts = {}): Promise<T> {
  const t = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      cache: "no-store",
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(t ? { Authorization: `Bearer ${t}` } : {}),
        ...(opts.readPassword ? { "X-Read-Password": opts.readPassword } : {}),
        ...(opts.workspace ? { "X-Markdrop-Workspace": opts.workspace } : {}),
      },
    });
  } catch {
    throw new CommentsApiError("Couldn't reach Markdrop. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const detail = body?.detail ?? body?.error;
    throw new CommentsApiError(
      typeof detail === "string" ? detail : `Request failed (${res.status})`,
      res.status,
      typeof body?.code === "string" ? body.code : null,
      body ?? {},
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const base = (slug: string) => `/api/v1/documents/${enc(slug)}/comments`;

export const listComments = (slug: string, opts: CallOpts & { status?: "open" | "resolved" | "all"; mine?: boolean } = {}) => {
  const q = new URLSearchParams();
  if (opts.status && opts.status !== "all") q.set("status", opts.status);
  if (opts.mine) q.set("mine", "true");
  const s = q.toString();
  return call<CommentsList>(`${base(slug)}${s ? `?${s}` : ""}`, {}, opts);
};

export const getThread = (slug: string, id: string, opts: CallOpts = {}) =>
  call<Thread>(`${base(slug)}/${enc(id)}`, {}, opts);

export interface NewThread {
  anchor: AnchorIn;
  body: string;
  mentions?: string[];
  assignee?: string | null;
  attachments?: string[];
  suggestion?: string | null;
}

export const createThread = (slug: string, data: NewThread, opts: CallOpts = {}) =>
  call<Thread>(base(slug), { method: "POST", body: JSON.stringify(data) }, opts);

export const replyThread = (slug: string, id: string, data: { body: string; mentions?: string[]; attachments?: string[]; suggestion?: string | null }, opts: CallOpts = {}) =>
  call<{ thread: Thread; message: Message }>(`${base(slug)}/${enc(id)}/replies`, { method: "POST", body: JSON.stringify(data) }, opts);

export const editMessage = (slug: string, id: string, mid: string, data: { body: string; mentions?: string[] }, opts: CallOpts = {}) =>
  call<Message>(`${base(slug)}/${enc(id)}/messages/${enc(mid)}`, { method: "PATCH", body: JSON.stringify(data) }, opts);

export const deleteMessage = (slug: string, id: string, mid: string, opts: CallOpts = {}) =>
  call<void>(`${base(slug)}/${enc(id)}/messages/${enc(mid)}`, { method: "DELETE" }, opts);

export const resolveThread = (slug: string, id: string, opts: CallOpts = {}) =>
  call<Thread>(`${base(slug)}/${enc(id)}/resolve`, { method: "POST" }, opts);

export const reopenThread = (slug: string, id: string, opts: CallOpts = {}) =>
  call<Thread>(`${base(slug)}/${enc(id)}/reopen`, { method: "POST" }, opts);

export const reactMessage = (slug: string, id: string, mid: string, emoji: string, on?: boolean, opts: CallOpts = {}) =>
  call<Message>(`${base(slug)}/${enc(id)}/messages/${enc(mid)}/reactions`, { method: "POST", body: JSON.stringify({ emoji, ...(on === undefined ? {} : { on }) }) }, opts);

export const assignThread = (slug: string, id: string, userId: string | null, opts: CallOpts = {}) =>
  call<Thread>(`${base(slug)}/${enc(id)}/assignee`, { method: "PUT", body: JSON.stringify({ user_id: userId }) }, opts);

export const commentPeople = (slug: string, q: string, opts: CallOpts = {}) =>
  call<PeopleResult>(`${base(slug)}/people${q ? `?q=${enc(q)}` : ""}`, {}, opts);

export const updateCommentSettings = (slug: string, data: { enabled?: boolean; public?: boolean }) =>
  call<{ enabled: boolean; public: boolean; workspace_enabled: boolean }>(`${base(slug)}/settings`, { method: "PUT", body: JSON.stringify(data) });

export const myComments = (view: "assigned" | "waiting" | "mentions" = "waiting", limit = 20) =>
  call<{ items: MyThread[] }>(`/api/v1/comments/mine?view=${view}&limit=${limit}`);

/** `#c-<thread id>`: a link that opens the comments panel on that thread. */
export const THREAD_HASH = /^#c-([0-9a-f]{24})$/;
export const threadHash = (id: string) => `#c-${id}`;
