/**
 * Page AI for readers: "Ask this page", the status that decides what to show, and Translate
 * (SPEC.md "API contract"). The editor's writing tools have their own client (client.ts).
 *
 * Every call goes through the reader's session at API_BASE. On a workspace's own domain that
 * session is the domain's tenant token (localStorage on that origin) and the API is the same;
 * the backend lets the token through for `status` and `ask` only (`_TENANT_ALLOWED`), so Ask works
 * there for signed-in readers and Translate (an editor's action) isn't offered.
 *
 * Kept out of lib/api.ts and lib/pages.ts: the panel that streams answers loads on first click.
 */
import { API_BASE, getToken } from "@/lib/api";
import { httpMessage, limitMessage } from "./ask-core";
import { readAiStream, type AiEvent } from "./sse";

export interface PageAiStatus {
  /** AI is on for this page (configured, not encrypted, the workspace hasn't turned it off). */
  enabled: boolean;
  /** Why not: "workspace_off", "off", "not_configured", "encrypted"… */
  reason?: string | null;
  /** May use the writing tools (editors). */
  can_write: boolean;
  /** May ask questions (signed-in readers who can open the page). */
  can_ask: boolean;
  /** The model takes images (alt text). */
  vision?: boolean;
}

/** A refusal: the HTTP status (0: no connection), what to tell the reader, and the limit reason. */
export class PageAiError extends Error {
  status: number;
  reason: string | null;
  constructor(message: string, status: number, reason: string | null = null) {
    super(message);
    this.name = "PageAiError";
    this.status = status;
    this.reason = reason;
  }
}

function headers(extra?: Record<string, string>): Record<string, string> {
  const t = getToken();
  return { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(extra ?? {}) };
}

/** A failed response → PageAiError, with the limit reason when the body has one. */
async function refusal(res: Response): Promise<PageAiError> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const detail = body?.detail;
  const info = detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : body ?? {};
  const reason = typeof info.reason === "string" ? info.reason : typeof body?.reason === "string" ? (body.reason as string) : null;
  if (reason) return new PageAiError(limitMessage(reason), res.status, reason);
  return new PageAiError(httpMessage(res.status, typeof detail === "string" ? detail : null), res.status);
}

const enc = encodeURIComponent;

/* ── status ──────────────────────────────────────────────────────────────── */

const statusCache = new Map<string, Promise<PageAiStatus | null>>();

/**
 * GET /ai/pages/status?slug=, once per page and session token. Null when it can't be read
 * (signed out, an older API, offline): the UI then shows no AI at all.
 */
export function fetchPageAiStatus(slug: string): Promise<PageAiStatus | null> {
  const key = `${slug}\n${getToken() ?? ""}`;
  let p = statusCache.get(key);
  if (!p) {
    p = fetch(`${API_BASE}/api/v1/ai/pages/status?slug=${enc(slug)}`, { headers: headers({ Accept: "application/json" }), cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) return null;
        const j = (await r.json()) as Partial<PageAiStatus>;
        return { enabled: !!j.enabled, reason: j.reason ?? null, can_write: !!j.can_write, can_ask: !!j.can_ask, vision: !!j.vision };
      })
      .catch(() => {
        statusCache.delete(key);
        return null;
      });
    statusCache.set(key, p);
  }
  return p;
}

/* ── ask ─────────────────────────────────────────────────────────────────── */

export interface AskBody {
  question: string;
  history?: { q: string; a: string }[];
}

/** POST /ai/pages/{slug}/ask: streams the answer's events. Throws PageAiError on a refusal. */
export async function streamAsk(slug: string, body: AskBody, signal: AbortSignal, onEvent: (e: AiEvent) => void): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/ai/pages/${enc(slug)}/ask`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json", Accept: "text/event-stream" }),
      body: JSON.stringify(body),
      signal,
      cache: "no-store",
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new PageAiError(httpMessage(0), 0);
  }
  if (!res.ok || !res.body) throw await refusal(res);
  await readAiStream(res.body, onEvent, signal);
}

/* ── translate ───────────────────────────────────────────────────────────── */

export interface TranslateResult {
  slug: string;
  url?: string | null;
  title?: string | null;
}

export interface TranslateProgress {
  done?: number;
  total?: number;
  label?: string;
}

/**
 * POST /ai/pages/{slug}/translate {lang}: creates the translated sibling page. The API may answer
 * with JSON `{slug, url}` or stream `progress` events and then `done {slug, url}`; both work.
 */
export async function translatePage(slug: string, lang: string, onProgress: (p: TranslateProgress) => void, signal: AbortSignal): Promise<TranslateResult> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/ai/pages/${enc(slug)}/translate`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json", Accept: "text/event-stream, application/json" }),
      body: JSON.stringify({ lang }),
      signal,
      cache: "no-store",
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new PageAiError(httpMessage(0), 0);
  }
  if (!res.ok) throw await refusal(res);
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream") || !res.body) {
    const j = (await res.json().catch(() => null)) as TranslateResult | null;
    if (!j?.slug) throw new PageAiError("The translation didn't come back. Try again.", res.status);
    return j;
  }
  let result: TranslateResult | null = null;
  let failure: PageAiError | null = null;
  await readAiStream(
    res.body,
    (e) => {
      if (e.type === "progress") onProgress({ done: e.done, total: e.total, label: e.label });
      else if (e.type === "done" && typeof e.slug === "string") result = { slug: e.slug, url: typeof e.url === "string" ? e.url : null, title: typeof e.title === "string" ? e.title : null };
      else if (e.type === "limit") failure = new PageAiError(limitMessage(e.reason), 200, e.reason);
      else if (e.type === "error") failure = new PageAiError(e.detail || "The translation failed. Try again.", 200);
    },
    signal,
  );
  // (Set in the callback: TypeScript can't see that, hence the casts.)
  const failed = failure as PageAiError | null;
  const created = result as TranslateResult | null;
  if (failed) throw failed;
  if (!created) throw new PageAiError("The translation stopped before it finished. Try again.", 200);
  return created;
}

export { limitMessage };
export type { AiEvent };
