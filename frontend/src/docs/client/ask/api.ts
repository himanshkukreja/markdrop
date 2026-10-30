/**
 * Ask AI's three calls: availability, the answer stream, and answer feedback, against the site's
 * Ask AI backend (site.json `ai.api`), naming the site (`ai.site`) in every request. The docs host
 * is a different origin from the app, so there is no app session here: on Markdrop's own docs
 * (`integrations.markdropApp`) a bearer is sent only if one was stored for this origin (none is
 * today), and the personal tools stay off; other sites never send one.
 */
import { readSse, type SseMessage } from "./sse";

/** Where and as which site to ask: from DocsClientSite.ai, set by AskRoot (configureAsk). */
export interface AskApi {
  /** Backend origin, no trailing slash. */
  api: string;
  site: string;
  appSession: boolean;
}

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

function bearer(cfg: AskApi): Record<string, string> {
  if (!cfg.appSession) return {};
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
export function fetchStatus(cfg: AskApi): Promise<Availability> {
  statusPromise ??= fetch(`${cfg.api}/api/v1/docs/ai/status`, { headers: { Accept: "application/json", "X-Docs-Site": cfg.site }, cache: "no-store" })
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

export async function streamAsk(cfg: AskApi, body: AskBody, signal: AbortSignal, onMessage: (m: SseMessage) => void): Promise<void> {
  const res = await fetch(`${cfg.api}/api/v1/docs/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", "X-Docs-Site": cfg.site, ...bearer(cfg) },
    body: JSON.stringify({ ...body, site: cfg.site }),
    signal,
    cache: "no-store",
  });
  if (!res.ok || !res.body) throw new AskHttpError(res.status);
  await readSse(res.body, onMessage, signal);
}

/** Fire and forget: feedback never shows an error. */
export function sendAnswerFeedback(cfg: AskApi, requestId: string, helpful: boolean, comment?: string) {
  try {
    void fetch(`${cfg.api}/api/v1/docs/ask/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId, helpful, comment: comment || undefined, site: cfg.site }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never surfaces */
  }
}
