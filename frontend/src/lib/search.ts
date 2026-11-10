/**
 * Global search's client (backend routers/search.py):
 *
 *   GET  /api/v1/search?q=&scope=&kind=&owner=&updated=&current=&cursor=&limit=   fuzzy, instant
 *   GET  /api/v1/search/ai-status?scope=                                          can AI search run?
 *   POST /api/v1/search/ask  (SSE)                                                AI search (Haiku 5.5)
 *
 * Signed-in only. Every result is already something the caller can open (the server's three walls);
 * the UI never filters for privacy. Kept out of lib/api.ts (that one loads on public pages).
 */
import { API_BASE, getToken } from "@/lib/api";
import { openHref, request } from "@/lib/workspaces";
import { SseParser } from "@/lib/pages-ai/sse";
import { pushRecent, RECENT_KEY } from "@/lib/searchCore.mjs";

export type SearchKind = "page" | "doc" | "file" | "folder" | "workspace" | "guide";
export type Marks = Array<[number, number]>;

export interface SearchItem {
  key: string;
  kind: SearchKind;
  group: SearchKind | "trash";
  /** Documents, pages and files: their address (what `fetch` and links take). */
  slug?: string;
  id?: string;
  title: string | null;
  title_marks?: Marks;
  encrypted?: boolean;
  has_password?: boolean;
  icon?: string | null;
  mime?: string | null;
  type_label?: string | null;
  workspace?: { id: string; name: string } | null;
  /** Teams: the teams it's in (empty / absent: company-wide). */
  teams?: { id: string; name: string; color?: string }[];
  folder?: { id?: string; name?: string; path: string[] } | null;
  owner?: { name: string | null; is_you: boolean } | null;
  guide?: { id: string; name: string };
  path?: string | null;
  role?: string;
  updated_at?: string | null;
  snippet?: { text: string; marks: Marks } | null;
  /** Where the words matched: title, heading or body. */
  match?: "title" | "heading" | "body";
  url: string;
  score?: number;
  /** AI search: the item's number in the answer's citations. */
  n?: number;
}

export interface TrashHit {
  key: string;
  kind: string;
  group: "trash";
  title: string;
  title_marks?: Marks;
  in_trash: true;
  deleted_at?: string | null;
  days_left?: number;
  workspace?: { id: string; name: string | null } | null;
  url: string;
}

export interface SearchGroup {
  key: SearchKind;
  label: string;
  items: SearchItem[];
  more: boolean;
}

export interface SearchResponse {
  query: string;
  items: SearchItem[];
  groups: SearchGroup[];
  trash: TrashHit[];
  next_cursor: string | null;
  total: number | null;
  took_ms: number;
  ai_suggested: boolean;
  /** This search's anonymous log row (first page in a workspace), for searchClicked; else null. */
  log_id?: string | null;
}

export interface SearchParams {
  q: string;
  /** "all" (default) or a workspace id. */
  scope?: string | null;
  /** Teams: "company" | "team:<id>" | "project:<id>" (needs a workspace scope). */
  space?: string | null;
  kind?: SearchKind | SearchKind[] | null;
  owner?: "anyone" | "me";
  updated?: "any" | "week" | "month";
  /** The workspace the person is in: ranked higher. */
  current?: string | null;
  cursor?: string | null;
  limit?: number;
  trash?: boolean;
  /** A random id for this search box's session (newSearchSid): a refinement of the last query
   *  overwrites its log row instead of adding one per keystroke. Never tied to the person. */
  sid?: string | null;
}

export function searchQuery(p: SearchParams): string {
  const u = new URLSearchParams();
  u.set("q", p.q);
  if (p.scope && p.scope !== "all") u.set("scope", `workspace:${p.scope}`);
  if (p.space && p.scope && p.scope !== "all") u.set("space", p.space);
  const kinds = Array.isArray(p.kind) ? p.kind : p.kind ? [p.kind] : [];
  if (kinds.length) u.set("kind", kinds.join(","));
  if (p.owner && p.owner !== "anyone") u.set("owner", p.owner);
  if (p.updated && p.updated !== "any") u.set("updated", p.updated);
  if (p.current) u.set("current", p.current);
  if (p.cursor) u.set("cursor", p.cursor);
  if (p.limit) u.set("limit", String(p.limit));
  if (p.trash === false) u.set("trash", "false");
  if (p.sid) u.set("sid", p.sid);
  return u.toString();
}

export async function search(p: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
  const r = await request<Partial<SearchResponse>>(`/api/v1/search?${searchQuery(p)}`, { signal });
  return {
    query: r.query ?? p.q, items: r.items ?? [], groups: r.groups ?? [], trash: r.trash ?? [],
    next_cursor: r.next_cursor ?? null, total: r.total ?? null, took_ms: r.took_ms ?? 0, ai_suggested: !!r.ai_suggested,
    log_id: r.log_id ?? null,
  };
}

/** A random id for one search-box session (content gaps' log: services/search_log.py). */
export function newSearchSid(): string {
  const a = new Uint8Array(12);
  try { crypto.getRandomValues(a); } catch { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); }
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A result was opened from the search logged as `logId` (fire and forget). */
export function searchClicked(logId: string | null | undefined): void {
  if (!logId) return;
  void request("/api/v1/search/click", { method: "POST", body: JSON.stringify({ log_id: logId }), keepalive: true }).catch(() => {});
}

export interface AiStatus { enabled: boolean; reason: string | null; message: string | null }

export async function searchAiStatus(scope?: string | null): Promise<AiStatus> {
  const q = scope && scope !== "all" ? `?scope=${encodeURIComponent(`workspace:${scope}`)}` : "";
  return request<AiStatus>(`/api/v1/search/ai-status${q}`);
}

export interface Citation { n: number; key: string; title: string | null; url: string | null; kind: string; slug?: string | null }

export type AskEvent =
  | { type: "status"; stage: "expanding" | "searching" | "answering"; terms?: string[] }
  | { type: "results"; items: SearchItem[] }
  | { type: "delta"; text: string }
  | { type: "done"; answer: string; citations: Citation[]; ranked: Citation[]; usage?: Record<string, number>; truncated?: boolean }
  | { type: "limit"; reason: string; message: string }
  | { type: "error"; detail: string; code?: string };

/** POST /search/ask, read as SSE until it ends or `signal` aborts. */
export async function askSearch(body: { question: string; scope?: string | null; current?: string | null },
  onEvent: (e: AskEvent) => void, signal?: AbortSignal): Promise<void> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/search/ask`, {
      method: "POST",
      signal,
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        question: body.question,
        ...(body.scope && body.scope !== "all" ? { scope: `workspace:${body.scope}` } : {}),
        ...(body.current ? { current: body.current } : {}),
      }),
    });
  } catch (e) {
    if (signal?.aborted) return;
    void e;
    onEvent({ type: "error", detail: "Couldn't reach Markdrop. Check your connection and try again." });
    return;
  }
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => null);
    const detail = typeof j?.detail === "string" ? j.detail : res.status === 429 ? "You're searching very fast. Wait a moment." : "AI search hit a problem. Try again.";
    onEvent({ type: "error", detail });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser((m) => {
    try {
      const data = JSON.parse(m.data);
      if (data && typeof data === "object" && typeof (data.type ?? m.event) === "string") onEvent({ ...data, type: data.type ?? m.event } as AskEvent);
    } catch { /* a keep-alive or a broken line */ }
  });
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.end();
  } catch (e) {
    if (!signal?.aborted) onEvent({ type: "error", detail: "AI search was interrupted. Try again." });
    void e;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

// ── Recent searches (this browser only; a convenience, never anything shared) ──

export function recentSearches(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function rememberSearch(q: string): string[] {
  const next = pushRecent(recentSearches(), q);
  try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}

export function forgetSearches(): void {
  try { window.localStorage.removeItem(RECENT_KEY); } catch { /* private mode */ }
}

/** Where a result opens. Documents, pages and files go where a click on their row goes (lib/workspaces
 *  openHref): their page here (markdrop.in, never the workspace's own domain), keeping a section's
 *  #anchor. Folders, workspaces and Guides pages are app paths. `external`: another origin (new tab). */
export function hrefOf(item: Pick<SearchItem, "url" | "slug" | "kind"> & { encrypted?: boolean | null }): { href: string; external: boolean } {
  const url = item.url || "/";
  if (url.startsWith("/")) return { href: url, external: false };
  if (item.slug && (item.kind === "page" || item.kind === "doc" || item.kind === "file")) {
    const hash = url.includes("#") ? url.slice(url.indexOf("#")) : "";
    const href = openHref(item.slug, url.split("#")[0], item.encrypted);
    if (href.startsWith("/")) return { href: `${href}${hash}`, external: false };
    return { href: `${href}${hash}`, external: true };
  }
  try {
    const u = new URL(url);
    if (typeof window !== "undefined" && u.host === window.location.host) return { href: `${u.pathname}${u.search}${u.hash}`, external: false };
  } catch { /* not a URL */ }
  return { href: url, external: true };
}
