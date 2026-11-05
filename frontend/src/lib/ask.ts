/**
 * Ask Markdrop's client (backend routers/ask.py):
 *
 *   GET    /api/v1/ask/home              {status, suggestions, recent}
 *   POST   /api/v1/ask  (SSE)            {question, thread_id?, intent?, page?}
 *          page (a slug) + intent "page": Ask this page with its workspace's meetings (pages/ai/AskPanel)
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
  label: string; n: number; key: string; title: string | null; url: string | null; web_url?: string | null;
  kind: string | null; slug?: string | null; moment?: string | null; text?: string | null;
}

export interface AskTurn {
  question: string;
  intent: AskIntent;
  answer: string | null;
  citations: AskCitation[];
  withheld?: boolean;
  at?: string | null;
}

export interface AskThreadFull { id: string; title: string; updated_at: string | null; turns: AskTurn[] }

export type AskResultItem = SearchItem & { n: number; task?: string | null };

export type AskEvent =
  | { type: "status"; stage: "understanding" | "searching" | "answering"; terms?: string[] }
  | { type: "results"; items: AskResultItem[] }
  | { type: "delta"; text: string }
  | { type: "done"; request_id: string; thread_id: string | null; intent: AskIntent; answer: string; citations: AskCitation[]; ranked: AskResultItem[]; truncated?: boolean }
  | { type: "limit"; reason: string; message: string }
  | { type: "error"; detail: string; code?: string };

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
export async function askMarkdrop(body: { question: string; thread_id?: string | null; intent?: AskIntent | "page" | null; page?: string | null },
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
      }),
    });
  } catch {
    if (signal?.aborted) return;
    onEvent({ type: "error", detail: "Couldn't reach Markdrop. Check your connection and try again." });
    return;
  }
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => null);
    const detail = typeof j?.detail === "string" ? j.detail : res.status === 429 ? "You're asking very fast. Wait a moment." : "Ask Markdrop hit a problem. Try again.";
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
