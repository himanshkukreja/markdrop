/**
 * Ask AI's three calls: availability, the answer stream, and answer feedback. The docs host is a
 * different origin from markdrop.in, so there is no Markdrop session here: a bearer is sent only
 * if one was stored for this origin (none is today), and the personal tools stay off.
 */
import { readSse, type SseMessage } from "./sse";

export const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "https://api.markdrop.in").replace(/\/+$/, "");

export type Phase = "searching" | "reading" | "checking" | "writing";

export interface AskStatus {
  phase: Phase | string;
  label: string;
}

export interface Source {
  n: number;
  id: string;
  title: string;
  section?: string | null;
  page: string;
  page_title?: string;
  url: string;
}

export interface OpenIn {
  label: string;
  href: string;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AskBody {
  question: string;
  history: HistoryMessage[];
  page_path: string | null;
  conversation_id: string | null;
}

/** Thrown for a non-2xx answer (rate limit, validation) before any event arrived. */
export class AskHttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

function bearer(): Record<string, string> {
  try {
    const t = localStorage.getItem("markdrop_token");
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

export type Availability = { available: true } | { available: false; reason: string } | { available: null };

let statusPromise: Promise<Availability> | null = null;

/** GET /docs/ai/status, once per page load. A network failure is "unknown": the composer stays, and an ask surfaces the error. */
export function fetchStatus(): Promise<Availability> {
  statusPromise ??= fetch(`${API_BASE}/api/v1/docs/ai/status`, { headers: { Accept: "application/json" }, cache: "no-store" })
    .then(async (r) => {
      if (!r.ok) return { available: null } as Availability;
      const j = (await r.json()) as { available?: boolean; reason?: string };
      return j.available ? ({ available: true } as Availability) : ({ available: false, reason: j.reason || "disabled" } as Availability);
    })
    .catch(() => {
      statusPromise = null;
      return { available: null } as Availability;
    });
  return statusPromise;
}

export async function streamAsk(body: AskBody, signal: AbortSignal, onMessage: (m: SseMessage) => void): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/docs/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...bearer() },
    body: JSON.stringify(body),
    signal,
    cache: "no-store",
  });
  if (!res.ok || !res.body) throw new AskHttpError(res.status);
  await readSse(res.body, onMessage, signal);
}

/** Fire and forget: feedback never shows an error. */
export function sendAnswerFeedback(requestId: string, helpful: boolean, comment?: string) {
  try {
    void fetch(`${API_BASE}/api/v1/docs/ask/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId, helpful, comment: comment || undefined }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never surfaces */
  }
}
