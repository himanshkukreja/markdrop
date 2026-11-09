/**
 * Review power on comment threads (backend routers/comments_review.py; Track B): suggested edits, AI
 * (Apply with AI, @AI, Summarize discussion, tone check) and files in comments. Threads themselves are
 * `@/lib/comments` (Track A).
 */
import { API_BASE, getToken } from "@/lib/api";
import { CommentsApiError, type CallOpts, type Person, type Thread, type Message } from "@/lib/comments";

const enc = encodeURIComponent;

async function call<T>(path: string, init: RequestInit = {}, opts: CallOpts = {}): Promise<T> {
  const t = getToken();
  let res: Response;
  const json = typeof init.body === "string";
  try {
    res = await fetch(`${API_BASE}${path}`, {
      cache: "no-store",
      ...init,
      headers: {
        ...(json ? { "Content-Type": "application/json" } : {}),
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
    const detail = body?.detail;
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

// ── Suggested edits ──────────────────────────────────────────────────────────

export interface SuggestionDetail {
  suggestion: null | {
    text: string;
    state: "open" | "accepted" | "rejected" | "stale";
    ai: boolean;
    by: Person | null;
    at: string | null;
    decided_by: Person | null;
    decided_at: string | null;
    version_id: string | null;
  };
  /** Accepting now would change the page (or offer it to whoever is editing). */
  applies: boolean;
  reason: null | "stale" | "unappliable" | "changed" | "locked";
  holder: null | { name: string; you: boolean };
  offer: null | { to: Person | null; by: Person | null; at: string | null; mine: boolean };
  /** The line as it is and as it would read (Markdown). */
  before: string | null;
  after: string | null;
  can: { accept: boolean; reject: boolean; withdraw: boolean; edit: boolean };
}

export interface AcceptResult {
  applied: boolean;
  offered: boolean;
  holder: string | null;
  version_id: string | null;
  rev: number | null;
  thread: Thread;
}

export const getSuggestion = (slug: string, threadId: string, opts: CallOpts = {}) =>
  call<SuggestionDetail>(`${base(slug)}/${enc(threadId)}/suggestion`, {}, opts);

export const putSuggestion = (slug: string, threadId: string, text: string, ai = false, opts: CallOpts = {}) =>
  call<Thread>(`${base(slug)}/${enc(threadId)}/suggestion`, { method: "PUT", body: JSON.stringify({ text, ai }) }, opts);

export const deleteSuggestion = (slug: string, threadId: string, opts: CallOpts = {}) =>
  call<Thread>(`${base(slug)}/${enc(threadId)}/suggestion`, { method: "DELETE" }, opts);

export const acceptSuggestion = (slug: string, threadId: string, resolve = true, opts: CallOpts = {}) =>
  call<AcceptResult>(`${base(slug)}/${enc(threadId)}/suggestion/accept`, { method: "POST", body: JSON.stringify({ resolve }) }, opts);

// ── AI ───────────────────────────────────────────────────────────────────────

export interface AiStatus {
  enabled: boolean;
  reason: string | null;
  message: string | null;
}

export interface SummaryLine {
  text: string;
  threads: string[];
  person?: string;
}

export interface DiscussionSummary {
  decided: SummaryLine[];
  open: SummaryLine[];
  waiting: SummaryLine[];
  counts: { open: number; resolved: number };
  generated_at: string | null;
  cached: boolean;
  empty: boolean;
}

export interface ToneResult {
  ok: boolean;
  issues: string[];
  rewrite: string | null;
  ai: boolean;
}

export const aiStatus = (slug: string, opts: CallOpts = {}) => call<AiStatus>(`${base(slug)}/ai/status`, {}, opts);

export const aiApply = (slug: string, threadId: string, instruction?: string | null, opts: CallOpts = {}) =>
  call<{ text: string; note: string | null; quote: string }>(`${base(slug)}/${enc(threadId)}/ai/apply`, {
    method: "POST",
    body: JSON.stringify(instruction ? { instruction } : {}),
  }, opts);

export const aiAsk = (slug: string, threadId: string, question: string, opts: CallOpts = {}) =>
  call<{ thread: Thread; message: Message; answer: string }>(`${base(slug)}/${enc(threadId)}/ai/ask`, {
    method: "POST",
    body: JSON.stringify({ question }),
  }, opts);

export const aiSummary = (slug: string, refresh = false, opts: CallOpts = {}) =>
  call<DiscussionSummary>(`${base(slug)}/ai/summary`, { method: "POST", body: JSON.stringify({ refresh }) }, opts);

export const aiTone = (slug: string, body: string, force = false, opts: CallOpts = {}) =>
  call<ToneResult>(`${base(slug)}/ai/tone`, { method: "POST", body: JSON.stringify({ body, force }) }, opts);

/** Cheap signs a comment may read badly (backend ai.tone_flags): only then does posting ask AI. */
const HARSH = /\b(stupid|idiot\w*|dumb|useless|garbage|trash|nonsense|ridiculous|lazy|terrible|awful|pathetic|wtf|why (would|did) you|obviously|clearly you|what were you thinking|incompetent|sloppy|lame|crap)\b/i;
export function toneFlags(body: string): string[] {
  const flags: string[] = [];
  const letters = body.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 12 && [...letters].filter((c) => c >= "A" && c <= "Z").length / letters.length > 0.7) flags.push("shouting");
  if (/[!?]{3,}/.test(body)) flags.push("punctuation");
  if (HARSH.test(body)) flags.push("harsh words");
  return flags;
}

/** Writing `@AI` in a comment asks Markdrop AI (the answer lands in the thread). */
export const AT_AI = /(^|[^\w@./])@ai\b/i;

// ── Files ────────────────────────────────────────────────────────────────────

export interface UploadedFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  url?: string;
}

export interface FileLink extends UploadedFile {
  url: string;
  expires_at: string | null;
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 10;
export const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,application/pdf,.docx,.xlsx,.pptx,.zip,.txt,.csv,.md,.json";

export async function uploadFile(slug: string, file: File, opts: CallOpts = {}): Promise<UploadedFile> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  return call<UploadedFile>(`${base(slug)}/attachments`, { method: "POST", body: fd }, opts);
}

export const discardFile = (slug: string, id: string, opts: CallOpts = {}) =>
  call<void>(`${base(slug)}/attachments/${enc(id)}`, { method: "DELETE" }, opts);

export const fileLinks = (slug: string, ids: string[], opts: CallOpts = {}) =>
  call<{ attachments: Record<string, FileLink> }>(`${base(slug)}/attachments/urls`, { method: "POST", body: JSON.stringify({ ids }) }, opts);

export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
