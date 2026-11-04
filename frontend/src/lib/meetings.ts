/**
 * Meetings' client (backend routers/meetings.py; .work/meetings/SPEC.md):
 *
 *   GET    /api/v1/meetings/status?workspace=     AI on?, Google Picker ready?, the Meetings folder
 *   POST   /api/v1/meetings/preview               what a paste / files would import (no writes)
 *   POST   /api/v1/meetings/import                → {meetings}
 *   POST   /api/v1/meetings/google/token          the Picker's short-lived token (drive.file)
 *   GET    /api/v1/meetings?workspace=            the meetings the caller can open
 *   GET    /api/v1/meetings/{id}                  one
 *   PATCH  /api/v1/meetings/{id}                  {restricted?, type?}
 *   DELETE /api/v1/meetings/{id}
 *   POST   /api/v1/meetings/{id}/regenerate
 *   POST   /api/v1/meetings/{id}/ask      (SSE)   Ask this meeting
 *   POST   /api/v1/meetings/ask           (SSE)   Ask across meetings
 *
 * Signed-in members only; every meeting is decided on its page by the server. Kept out of lib/api.ts
 * (that one loads on public pages).
 */
import { API_BASE, getToken } from "@/lib/api";
import { request } from "@/lib/workspaces";
import { SseParser } from "@/lib/pages-ai/sse";

export const MEETING_TYPES = ["Standup", "Planning", "Review", "1:1", "Interview", "Customer", "Other"] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];

export interface MeetingAi {
  state: "pending" | "done" | "skipped" | "failed";
  reason?: string | null;
  message?: string | null;
  cost_usd?: number;
  calls?: number;
  chunks?: number | null;
  at?: string | null;
}

export interface MeetingSource { kind: "transcript" | "notes" | "both"; origin: string; name: string | null; url: string | null; format?: string | null }

export interface Meeting {
  id: string;
  workspace_id: string;
  title: string | null;
  page_title: string | null;
  slug: string;
  transcript_slug: string | null;
  date: string | null;
  time: string | null;
  duration_s: number | null;
  type: MeetingType | string | null;
  attendees: Array<{ name: string; user_id: string | null }>;
  restricted: boolean;
  action_items: number;
  segments: number;
  has_notes: boolean;
  has_transcript: boolean;
  sources: MeetingSource[];
  ai: MeetingAi;
  created_at: string | null;
  created_by: string | null;
  can_manage: boolean;
  can_delete: boolean;
  can_regenerate: boolean;
  approx_times?: boolean;
}

export interface HiddenMeeting { id: string; date: string | null; restricted: true; redacted: true; can_delete: true }

export interface MeetingsStatus {
  ai: { enabled: boolean; reason: string | null; message: string | null; model: string };
  google: { configured: boolean; connected: boolean };
  folder_id: string | null;
  can_import: boolean;
  types: string[];
}

export interface DetectedMeeting {
  title: string | null;
  date: string | null;
  time: string | null;
  duration_s: number | null;
  attendees: string[];
  segments: number;
  has_notes: boolean;
  kinds: string[];
  truncated: boolean;
  sources: Array<{ name: string; kind: string; format: string; segments: number; speakers: string[] }>;
}

export interface SourceIn { name?: string; text?: string; data_b64?: string; google_file_id?: string; origin?: "paste" | "upload" }

export const meetingsHref = (workspaceId: string) => `/meetings/${encodeURIComponent(workspaceId)}`;

export function getMeetingsStatus(workspace: string) {
  return request<MeetingsStatus>(`/api/v1/meetings/status?workspace=${encodeURIComponent(workspace)}`);
}

export function listMeetings(workspace: string, q?: string) {
  const qs = new URLSearchParams({ workspace });
  if (q) qs.set("q", q);
  return request<{ meetings: Meeting[]; hidden: HiddenMeeting[]; folder_id: string | null }>(`/api/v1/meetings?${qs}`);
}

export function getMeeting(id: string) {
  return request<Meeting>(`/api/v1/meetings/${encodeURIComponent(id)}`);
}

export function previewMeeting(sources: SourceIn[]) {
  return request<{ meetings: DetectedMeeting[] }>(`/api/v1/meetings/preview`, { method: "POST", body: JSON.stringify({ sources }) });
}

export function importMeeting(body: { workspace: string; sources: SourceIn[]; title?: string; date?: string; type?: string; restricted?: boolean }) {
  return request<{ meetings: Meeting[] }>(`/api/v1/meetings/import`, { method: "POST", body: JSON.stringify(body) });
}

export function patchMeeting(id: string, body: { restricted?: boolean; type?: string }) {
  return request<Meeting>(`/api/v1/meetings/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteMeeting(id: string) {
  return request<{ deleted: boolean }>(`/api/v1/meetings/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function regenerateMeeting(id: string) {
  return request<Meeting>(`/api/v1/meetings/${encodeURIComponent(id)}/regenerate`, { method: "POST" });
}

export function googlePickerToken() {
  return request<{ access_token: string; api_key: string; app_id: string; client_id: string }>(`/api/v1/meetings/google/token`, { method: "POST" });
}

// ── Asking ────────────────────────────────────────────────────────────────────

export interface MeetingCitation {
  /** What the model wrote: "s12", "n3", "M2-s14", "M2". */
  label: string;
  kind: "segment" | "page";
  /** "Ada Lovelace, 12:34" / "Meeting notes" / "<meeting> · Nov 4, 2026". */
  text: string;
  href: string;
  slug?: string | null;
  meeting_id?: string;
}

export interface RankedMeeting { n: number; id: string; title: string | null; date: string | null; type: string | null; slug: string }

export type MeetingAskEvent =
  | { type: "status"; stage: "searching" | "answering" }
  | { type: "results"; items: RankedMeeting[] }
  | { type: "delta"; text: string }
  | { type: "done"; answer: string; citations: MeetingCitation[]; ranked?: RankedMeeting[]; truncated?: boolean }
  | { type: "limit"; reason: string; message: string }
  | { type: "error"; detail: string; code?: string };

async function stream(path: string, body: unknown, onEvent: (e: MeetingAskEvent) => void, signal?: AbortSignal) {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      signal,
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    if (!signal?.aborted) onEvent({ type: "error", detail: "Couldn't reach Markdrop. Check your connection and try again." });
    return;
  }
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => null);
    const detail = typeof j?.detail === "string" ? j.detail : res.status === 429 ? "You're asking very fast. Wait a moment." : "AI hit a problem. Try again.";
    onEvent({ type: "error", detail });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser((m) => {
    try {
      const data = JSON.parse(m.data);
      if (data && typeof data === "object") onEvent({ ...data, type: data.type ?? m.event } as MeetingAskEvent);
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

export function askMeeting(id: string, body: { question: string; history?: Array<{ question: string; answer: string }> },
  onEvent: (e: MeetingAskEvent) => void, signal?: AbortSignal) {
  return stream(`/api/v1/meetings/${encodeURIComponent(id)}/ask`, body, onEvent, signal);
}

export function askMeetings(body: { workspace: string; question: string }, onEvent: (e: MeetingAskEvent) => void, signal?: AbortSignal) {
  return stream(`/api/v1/meetings/ask`, body, onEvent, signal);
}

// ── Small helpers (pure) ──────────────────────────────────────────────────────

export function fmtMeetingDate(d: string | null | undefined): string {
  if (!d) return "";
  const [y, m, day] = d.split("-").map(Number);
  if (!y || !m || !day) return d;
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function fmtDuration(s: number | null | undefined): string {
  if (!s) return "";
  const m = Math.max(1, Math.round(s / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

/** A file → a source: text files as text, a .docx as base64 (the server reads it). */
export async function fileToSource(file: File): Promise<SourceIn> {
  const name = file.name;
  if (/\.docx$/i.test(name)) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { name, data_b64: btoa(bin), origin: "upload" };
  }
  return { name, text: await file.text(), origin: "upload" };
}

export const ACCEPT = ".txt,.vtt,.srt,.sbv,.docx,.md,text/plain,text/vtt";
export const MAX_FILE_BYTES = 4_000_000;

/** Splits an answer at its citations: text pieces and citation labels in order. */
export function splitCitations(answer: string): Array<{ text: string } | { label: string }> {
  const out: Array<{ text: string } | { label: string }> = [];
  const re = /\[((?:M\d{1,2}(?:-[sn]\d{1,5})?)|(?:[sn]\d{1,5}))\]/g;
  let last = 0;
  for (let m = re.exec(answer); m; m = re.exec(answer)) {
    if (m.index > last) out.push({ text: answer.slice(last, m.index) });
    out.push({ label: m[1] });
    last = m.index + m[0].length;
  }
  if (last < answer.length) out.push({ text: answer.slice(last) });
  return out;
}
