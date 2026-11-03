/**
 * Page AI, the editor's side (SPEC.md "API contract"): the streaming client, the status hook and
 * the editor's AI (`EditorAi`, components/docs-editor/types.ts) for a page and for a guide.
 *
 *   GET  /api/v1/ai/pages/status?slug=        {enabled, reason?, can_write, can_ask, vision}
 *   POST /api/v1/ai/pages/{slug}/transform    SSE  {action, text, tone?, lang?, before?, after?}
 *   POST /api/v1/ai/pages/{slug}/write        SSE  {prompt, before?, after?}
 *   POST /api/v1/ai/pages/{slug}/action-items SSE  {text?}
 *   POST /api/v1/ai/pages/{slug}/summary      SSE
 *   POST /api/v1/ai/pages/{slug}/meta         JSON {title, description, icon}
 *   POST /api/v1/ai/pages/{slug}/alt-text     JSON {alt}  (501: no vision)
 *   POST /api/v1/ai/pages/notes               SSE  {notes, template?, title?, workspace?}
 *   Guides: /api/v1/docs-sites/{id}/pages/{page_id}/ai/{transform|write|action-items|summary|meta|alt-text}
 *
 * Streams are Server-Sent Events read off the fetch body; the parsing is in sseCore.mjs (pure, so
 * the tests load it; the reader side has its own parser in sse.ts for now: one to merge later).
 * Every stream resolves with the whole answer, or rejects with an `AiError` whose message is a
 * sentence to show (limits included). A stop (the AbortSignal) rejects with an AbortError.
 *
 * Nothing here logs or records what's sent: the page's words go to the API and nowhere else.
 */
import { useEffect, useState } from "react";
import { API_BASE, getToken } from "@/lib/api";
import type { AiStreamOptions, EditorAi } from "@/components/docs-editor/types";
import { createSseParser, limitMessage, toAiEvent } from "./sseCore.mjs";

export { limitMessage } from "./sseCore.mjs";

const enc = encodeURIComponent;

/** A refusal or failure, with a sentence to show. `reason` for limits (daily, burst, …). */
export class AiError extends Error {
  kind: "limit" | "error";
  reason: string | null;
  status: number;
  constructor(message: string, kind: "limit" | "error" = "error", reason: string | null = null, status = 0) {
    super(message);
    this.name = "AiError";
    this.kind = kind;
    this.reason = reason;
    this.status = status;
  }
}

const GENERIC = "AI couldn't do that just now. Try again.";
const OFFLINE = "Couldn't reach Markdrop. Check your connection and try again.";
const LIMIT_REASONS = new Set(["daily", "monthly", "burst", "off", "workspace_off", "not_configured", "blocked", "user_daily"]);

function headers(extra?: Record<string, string | null | undefined>): Record<string, string> {
  const t = getToken();
  const out: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream, application/json" };
  if (t) out.Authorization = `Bearer ${t}`;
  for (const [k, v] of Object.entries(extra ?? {})) if (v) out[k] = v;
  return out;
}

/** An HTTP refusal as an AiError: limits by their reason, the rest by the server's sentence. */
async function httpError(res: Response): Promise<AiError> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const detail = body?.detail;
  const info = detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : body ?? {};
  const reason = [info.reason, info.code, body?.reason, body?.type === "limit" ? body?.reason : null].find((r): r is string => typeof r === "string" && LIMIT_REASONS.has(r));
  if (reason) return new AiError(limitMessage(reason), "limit", reason, res.status);
  if (res.status === 429) return new AiError(limitMessage("burst"), "limit", "burst", 429);
  if (res.status === 401) return new AiError("Sign in to use AI.", "error", null, 401);
  if (res.status === 501) return new AiError("That isn't available yet.", "error", null, 501);
  if (res.status === 503) return new AiError(limitMessage("off"), "limit", "off", 503);
  const text = typeof detail === "string" ? detail : typeof info.message === "string" ? info.message : "";
  return new AiError(text || GENERIC, "error", null, res.status);
}

const abortError = () => {
  const e = new Error("Stopped");
  e.name = "AbortError";
  return e;
};

/**
 * POSTs `body` to `path` and reads the answer as it streams: `onDelta` gets each piece, the promise
 * the whole. A JSON answer (`{markdown}` / `{text}`) is taken whole, for servers that don't stream.
 */
export async function streamAi(path: string, body: unknown, o: AiStreamOptions & { headers?: Record<string, string | null | undefined> }): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: "POST", cache: "no-store", headers: headers(o.headers), body: JSON.stringify(body ?? {}), signal: o.signal });
  } catch (e) {
    if (o.signal.aborted) throw abortError();
    void e;
    throw new AiError(OFFLINE);
  }
  if (!res.ok) throw await httpError(res);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream") || !res.body) {
    const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (j?.type === "limit") throw new AiError(limitMessage(String(j.reason ?? "daily")), "limit", String(j.reason ?? "daily"));
    const text = typeof j?.markdown === "string" ? j.markdown : typeof j?.text === "string" ? j.text : "";
    o.onDelta(text, true);
    return text;
  }

  let text = "";
  let failure: AiError | null = null;
  const parser = createSseParser((m) => {
    if (failure) return;
    const e = toAiEvent(m);
    if (!e) return;
    if (e.type === "delta") {
      text = e.reset ? e.text : text + e.text;
      o.onDelta(e.text, e.reset);
    } else if (e.type === "limit") failure = new AiError(limitMessage(e.reason), "limit", e.reason);
    else if (e.type === "error") failure = new AiError(e.detail || GENERIC);
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => void reader.cancel().catch(() => {});
  o.signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
      if (failure) break;
    }
    parser.push(decoder.decode());
    parser.end();
  } catch (e) {
    if (o.signal.aborted) throw abortError();
    void e;
    throw new AiError(text ? "The answer was cut off. Try again." : OFFLINE);
  } finally {
    o.signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* released */
    }
  }
  if (o.signal.aborted) throw abortError();
  if (failure) throw failure;
  return text;
}

async function postJson<T>(path: string, body: unknown, extra?: Record<string, string | null | undefined>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: "POST", cache: "no-store", headers: headers(extra), body: JSON.stringify(body ?? {}) });
  } catch {
    throw new AiError(OFFLINE);
  }
  if (!res.ok) throw await httpError(res);
  const j = (await res.json().catch(() => null)) as (T & { type?: string; reason?: string }) | null;
  if (j && j.type === "limit") throw new AiError(limitMessage(String(j.reason ?? "daily")), "limit", String(j.reason ?? "daily"));
  return j as T;
}

/* ── status ─────────────────────────────────────────────────────────────── */

export interface PagesAiStatus {
  enabled: boolean;
  /** Why it isn't: off | not_configured | workspace_off | encrypted | … */
  reason?: string | null;
  can_write: boolean;
  can_ask: boolean;
  /** The model can read images (alt text). */
  vision: boolean;
}

const statusCache = new Map<string, { at: number; p: Promise<PagesAiStatus | null> }>();
const STATUS_TTL = 60_000;

/** What AI this person may use on a page (`slug`), or for a new page (`workspace`); null: none. */
export function getPagesAiStatus(q: { slug?: string | null; workspace?: string | null }): Promise<PagesAiStatus | null> {
  const params = new URLSearchParams();
  if (q.slug) params.set("slug", q.slug);
  if (q.workspace) params.set("workspace", q.workspace);
  const key = params.toString();
  const hit = statusCache.get(key);
  if (hit && Date.now() - hit.at < STATUS_TTL) return hit.p;
  const p = fetch(`${API_BASE}/api/v1/ai/pages/status${key ? `?${key}` : ""}`, { cache: "no-store", headers: headers() })
    .then((r) => (r.ok ? (r.json() as Promise<PagesAiStatus>) : null))
    .catch(() => null);
  statusCache.set(key, { at: Date.now(), p });
  return p;
}

/** The status, once known (null until then, and when there's none). Pass `skip` to not ask. */
export function usePagesAiStatus(q: { slug?: string | null; workspace?: string | null }, skip = false): PagesAiStatus | null {
  const [s, setS] = useState<PagesAiStatus | null>(null);
  useEffect(() => {
    if (skip) {
      setS(null);
      return;
    }
    let live = true;
    void getPagesAiStatus(q).then((r) => live && setS(r));
    return () => {
      live = false;
    };
  }, [q.slug, q.workspace, skip]); // eslint-disable-line react-hooks/exhaustive-deps
  return s;
}

export const WORKSPACE_OFF = "AI is off for this workspace. A workspace admin can turn it on in its settings.";

/* ── the editor's AI: one interface (EditorAi), a page's and a guide's ─────── */

type Base = (endpoint: string) => string;

function editorAi(base: Base, opts: { headers?: Record<string, string | null | undefined>; altId?: (src: string) => string | null; vision?: boolean }): EditorAi {
  const h = opts.headers;
  return {
    transform: (req, o) => streamAi(base("transform"), req, { ...o, headers: h }),
    write: (req, o) => streamAi(base("write"), req, { ...o, headers: h }),
    actionItems: (req, o) => streamAi(base("action-items"), req, { ...o, headers: h }),
    summary: (o) => streamAi(base("summary"), {}, { ...o, headers: h }),
    altText:
      opts.vision === false || !opts.altId
        ? undefined
        : async (src) => {
            const id = opts.altId!(src);
            if (!id) return null;
            const r = await postJson<{ alt?: string | null }>(base("alt-text"), { asset_id: id }, h);
            return r?.alt?.trim() || null;
          },
  };
}

/** An AI that can't be used: its menus say why (the workspace turned AI off). */
function offAi(message: string): EditorAi {
  const no = () => Promise.reject(new AiError(message, "limit", "workspace_off"));
  return { off: message, transform: no };
}

/**
 * A page's AI for its editor, from its status: none for people who can't write (or when AI is
 * off for everyone); a menu that says so when the workspace turned it off.
 */
export function pageEditorAi(slug: string, status: PagesAiStatus | null, secret?: string | null): EditorAi | null {
  if (!status) return null;
  if (status.reason === "workspace_off") return offAi(WORKSPACE_OFF);
  if (!status.enabled || !status.can_write) return null;
  const s = enc(slug);
  return editorAi((e) => `/api/v1/ai/pages/${s}/${e}`, {
    headers: { "x-edit-secret": secret ?? null },
    vision: status.vision,
    altId: (src) => /^asset:([A-Za-z0-9_-]+)$/.exec(src.trim())?.[1] ?? null,
  });
}

/** A guide page's AI (charged to the guide's editor AI budget). */
export function guideEditorAi(siteId: string, pageId: string): EditorAi {
  return editorAi((e) => `/api/v1/docs-sites/${enc(siteId)}/pages/${enc(pageId)}/ai/${e}`, {
    // An upload's address is /docs-assets/<sha256>.<ext>: the asset's id is its name.
    altId: (src) => /^\/docs-assets\/([A-Za-z0-9_][A-Za-z0-9._@-]*)$/.exec(src.trim())?.[1] ?? null,
  });
}

/* ── title, description and icon ─────────────────────────────────────────── */

export interface PageMeta {
  title?: string | null;
  description?: string | null;
  icon?: string | null;
}

export function suggestPageMeta(slug: string, secret?: string | null): Promise<PageMeta> {
  return postJson<PageMeta>(`/api/v1/ai/pages/${enc(slug)}/meta`, {}, { "x-edit-secret": secret ?? null });
}

export function suggestGuideMeta(siteId: string, pageId: string): Promise<PageMeta> {
  return postJson<PageMeta>(`/api/v1/docs-sites/${enc(siteId)}/pages/${enc(pageId)}/ai/meta`, {});
}

/* ── notes → page ─────────────────────────────────────────────────────────── */

export function streamNotes(input: { notes: string; template?: string | null; title?: string | null; workspace?: string | null }, o: AiStreamOptions): Promise<string> {
  const body: Record<string, string> = { notes: input.notes };
  if (input.template) body.template = input.template;
  if (input.title) body.title = input.title;
  if (input.workspace) body.workspace = input.workspace;
  return streamAi("/api/v1/ai/pages/notes", body, o);
}
