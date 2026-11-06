/**
 * Ask's client (backend routers/ask.py). The assistant is "Ask" — "Ask <Workspace>", "Ask my files",
 * "Ask this page" by scope (owner, 2026-11-06):
 *
 *   GET    /api/v1/ask/home              {status, suggestions, recent}
 *   GET    /api/v1/ask/suggestions       ?workspace=: live team questions (only from what every member can
 *                                        read) + the caller's own; {workspace, team, personal, updated_at, refreshing}
 *   POST   /api/v1/ask  (SSE)            {question, thread_id?, intent?, page?, scope?, context?}
 *          scope: the assistant's (components/assistant): doc | meetings | folder | workspace | everything
 *   GET    /api/v1/ask/context           what the assistant offers where you are
 *   GET    /api/v1/ask/threads/{id}      one conversation (turns whose sources closed come back withheld)
 *   DELETE /api/v1/ask/threads[/{id}]    forget one / all
 *
 * Signed-in only. Everything cited is something the asker can open now (the server decides it again
 * before answering and when a conversation is reopened); the UI never filters for privacy.
 */
import { API_BASE, getToken } from "@/lib/api";
import { request } from "@/lib/workspaces";
import { SseParser } from "@/lib/pages-ai/sse";
import type { SearchItem } from "@/lib/search";

export type AskIntent = "ask" | "catch_up" | "my_actions";

export interface AskStatus { enabled: boolean; reason: string | null; message: string | null }
export interface AskSuggestion { label: string; question: string; intent: AskIntent }
export interface AskThreadCard { id: string; title: string; turns: number; updated_at: string | null; via?: string | null }
export interface AskHomeData { status: AskStatus; suggestions: AskSuggestion[]; recent: AskThreadCard[] }

export interface AskCitation {
  label: string; n?: number; key: string; title: string | null; url: string | null; web_url?: string | null;
  kind: string | null; slug?: string | null; moment?: string | null; text?: string | null;
  /** What it says there (a transcript line, a snippet). */
  quote?: string | null;
  /** When and where ("Oct 28, 2026 · Daily Standup"). */
  subtitle?: string | null;
  speaker?: string | null; at?: string | null; meeting_id?: string | null;
  /** "this page", "meeting", "moment", "page", "doc"… */
  source_kind?: string | null;
}

/** What the assistant answers from (backend services/assistant.py). */
export type AssistantScopeKind = "doc" | "meetings" | "folder" | "workspace" | "mine" | "everything";
export interface AssistantScope {
  kind: AssistantScopeKind;
  page?: string | null; workspace?: string | null; folder?: string | null; meeting?: string | null;
  series?: string | null; since?: string | null; until?: string | null;
}
export interface AssistantReader { heading?: string | null; selection?: string | null }
export interface AssistantContext {
  scopes: { kind: AssistantScopeKind; label: string; sub: string | null }[];
  default: AssistantScopeKind;
  page: { slug: string; title: string | null; editor: string; meeting_id?: string | null; meeting_role?: string | null } | null;
  workspace: { id: string; name: string | null } | null;
  /** Every workspace the person belongs to (a chip each, the current one first). */
  workspaces?: { id: string; name: string | null }[];
  folder: { id: string; name: string | null } | null;
  meeting: { id: string; title: string | null; date?: string | null; series?: string | null } | null;
  series: string[];
  can_insert: boolean;
  status: { search: AskStatus; meetings: AskStatus | null };
}

export function getAssistantContext(q: { page?: string | null; workspace?: string | null; folder?: string | null; meeting?: string | null }): Promise<AssistantContext> {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
  return request<AssistantContext>(`/api/v1/ask/context?${p.toString()}`);
}

export interface AskTurn {
  question: string;
  intent: AskIntent | "page" | "meetings";
  /** The assistant's scope for this turn. */
  scope?: { kind: AssistantScopeKind; label: string } | null;
  answer: string | null;
  citations: AskCitation[];
  withheld?: boolean;
  at?: string | null;
}

export interface AskThreadFull { id: string; title: string; updated_at: string | null; turns: AskTurn[] }

export type AskResultItem = SearchItem & { n: number; task?: string | null };

export type AskEvent =
  | { type: "status"; stage: "understanding" | "searching" | "answering"; terms?: string[] }
  | { type: "results"; items: AskResultItem[]; note?: string | null }
  | { type: "delta"; text: string }
  | { type: "done"; request_id: string; thread_id: string | null; intent: AskIntent | "page" | "meetings"; answer: string; citations: AskCitation[]; ranked: AskResultItem[]; truncated?: boolean;
      scope?: { kind: AssistantScopeKind; label: string } | null; engine?: string | null }
  | { type: "limit"; reason: string; message: string }
  | { type: "error"; detail: string; code?: string };

/** A team question (the same for every member of the workspace). */
export interface AskTeamSuggestion { topic: string | null; question: string; label: string }
/** One of the viewer's own (no AI): their action items, their latest meeting… */
export interface AskPersonalSuggestion { label: string; question: string; intent: AskIntent; icon?: string }
export interface AskSuggestions {
  workspace: { id: string; name: string } | null;
  team: AskTeamSuggestion[];
  personal: AskPersonalSuggestion[];
  /** When the team list was built. */
  updated_at: string | null;
  /** Being built for the first time: ask again in a few seconds. */
  refreshing: boolean;
  ai_off?: boolean;
  status: AskStatus;
}

export function getAskSuggestions(workspace?: string | null): Promise<AskSuggestions> {
  return request<AskSuggestions>(`/api/v1/ask/suggestions${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`);
}

export function listAskThreads(limit = 50): Promise<{ threads: AskThreadCard[] }> {
  return request<{ threads: AskThreadCard[] }>(`/api/v1/ask/threads?limit=${limit}`);
}

export function askHome(): Promise<AskHomeData> {
  return request<AskHomeData>("/api/v1/ask/home");
}

export function getAskThread(id: string): Promise<AskThreadFull> {
  return request<AskThreadFull>(`/api/v1/ask/threads/${encodeURIComponent(id)}`);
}

export function deleteAskThread(id: string): Promise<{ deleted: number }> {
  return request(`/api/v1/ask/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function clearAskThreads(): Promise<{ deleted: number }> {
  return request("/api/v1/ask/threads", { method: "DELETE" });
}

/** POST /ask, read as SSE until it ends or `signal` aborts. */
export async function askMarkdrop(body: { question: string; thread_id?: string | null; intent?: AskIntent | "page" | null; page?: string | null;
  scope?: AssistantScope | null; context?: AssistantReader | null },
  onEvent: (e: AskEvent) => void, signal?: AbortSignal): Promise<void> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/ask`, {
      method: "POST",
      signal,
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        question: body.question,
        ...(body.thread_id ? { thread_id: body.thread_id } : {}),
        ...(body.intent ? { intent: body.intent } : {}),
        ...(body.page ? { page: body.page } : {}),
        ...(body.scope ? { scope: Object.fromEntries(Object.entries(body.scope).filter(([, v]) => v != null && v !== "")) } : {}),
        ...(body.context && (body.context.heading || body.context.selection) ? { context: {
          ...(body.context.heading ? { heading: body.context.heading.slice(0, 200) } : {}),
          ...(body.context.selection ? { selection: body.context.selection.slice(0, 1500) } : {}),
        } } : {}),
      }),
    });
  } catch {
    if (signal?.aborted) return;
    onEvent({ type: "error", detail: "Couldn't reach Markdrop. Check your connection and try again." });
    return;
  }
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => null);
    const detail = typeof j?.detail === "string" ? j.detail : res.status === 429 ? "You're asking very fast. Wait a moment." : "Ask hit a problem. Try again.";
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
  } catch {
    if (!signal?.aborted) onEvent({ type: "error", detail: "The answer was interrupted. Try again." });
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
