/**
 * Meeting memory while writing (backend routers/meeting_memory.py, services/meeting_memory.py):
 *
 *   POST  /api/v1/meeting-memory/related   facts related to what is being written (search, no AI)
 *   POST  /api/v1/meeting-memory/check     Haiku: does this section contradict / leave out these decisions?
 *   GET   /api/v1/meeting-memory/prefs     {panel, hints}
 *   PATCH /api/v1/meeting-memory/prefs
 *
 * Every fact comes from a meeting the person can open now (the server decides it); the UI never
 * filters for privacy.
 */
import { request } from "@/lib/workspaces";

export type FactKind = "decision" | "action_item" | "open_question" | "topic";

export interface MemoryFact {
  id: string;
  kind: FactKind;
  text: string;
  title: string | null;
  gist: string | null;
  owner: string | null;
  owner_id: string | null;
  due: string | null;
  status: "open" | "done" | null;
  source: "ai" | "google";
  meeting: { id: string; title: string | null; date: string | null; series: string | null; type: string | null; slug: string | null; url: string | null; href: string | null; restricted: boolean };
  moment: { label: string; href: string; url: string } | null;
  /** The meeting page, or the moment in its transcript. */
  href: string | null;
  /** The cited line "Insert" puts in the page (Markdown with a mention of the meeting). */
  markdown: string;
  /** The same as plain text. */
  cite: string;
  score?: number;
}

export interface MemoryHint {
  kind: "omits" | "contradicts";
  fact: string;
  clear: boolean;
  message: string;
  question: string;
}

export interface MemoryPrefs { panel: boolean; hints: boolean }

export interface RelatedResult {
  facts: MemoryFact[];
  hints: MemoryHint[];
  meetings: number;
  workspace_id: string | null;
  prefs: MemoryPrefs;
  took_ms?: number;
}

export interface RelatedQuery {
  page?: string;
  workspace?: string;
  title?: string;
  heading?: string;
  selection?: string;
  section?: string;
  q?: string;
  kinds?: FactKind[];
  limit?: number;
}

export function relatedFacts(body: RelatedQuery, signal?: AbortSignal): Promise<RelatedResult> {
  return request<RelatedResult>("/api/v1/meeting-memory/related", { method: "POST", body: JSON.stringify(body), signal });
}

export interface CheckResult {
  results: Array<{ id: string; verdict: "contradicts" | "omits" | "consistent"; note: string | null }>;
  cached: boolean;
  reason?: string;
  message?: string;
}

export function checkSection(body: { page: string; heading?: string | null; section: string; facts: string[] }, signal?: AbortSignal): Promise<CheckResult> {
  return request<CheckResult>("/api/v1/meeting-memory/check", { method: "POST", body: JSON.stringify(body), signal });
}

export function getMemoryPrefs(): Promise<MemoryPrefs> {
  return request<MemoryPrefs>("/api/v1/meeting-memory/prefs");
}

export function setMemoryPrefs(patch: Partial<MemoryPrefs>): Promise<MemoryPrefs> {
  return request<MemoryPrefs>("/api/v1/meeting-memory/prefs", { method: "PATCH", body: JSON.stringify(patch) });
}

export const KIND_LABEL: Record<FactKind, string> = {
  decision: "Decision",
  action_item: "Action item",
  open_question: "Open question",
  topic: "Discussed",
};

/** "Oct 28, 2026" for a YYYY-MM-DD date. */
export function fmtDay(d: string | null | undefined): string {
  if (!d) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return d;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return dt.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
