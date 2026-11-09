/**
 * Comments, Track C (backend routers/comments_insights.py): an item's comment analytics, its threads for a
 * printed (PDF) export, the daily comments digest setting, and the admin totals. Markdown and Word exports with
 * comments go through the page export (`components/pages/export/exportApi.ts`, `comments=`).
 */
import { API_BASE, getToken } from "@/lib/api";

export type InsightsRange = "7d" | "30d" | "90d" | "all";

export interface CommentInsights {
  range: InsightsRange;
  counts: { total: number; open: number; resolved: number; messages: number; participants: number; changed: number };
  first_reply: { median_s: number | null; avg_s: number | null; replied: number; waiting: number };
  resolve: { median_s: number | null; resolved: number };
  sections: Array<{ id: string | null; title: string; threads: number; open: number; messages: number }>;
  series: Array<{ date: string; threads: number; messages: number }>;
  people: Array<{ id: string; name: string; picture: string | null; messages: number }>;
  summary: string;
}

export interface ExportThreadDto {
  n: number;
  id: string;
  anchor_type: "text" | "block" | "page";
  quote: string | null;
  block_id: string | null;
  status: "open" | "resolved";
  changed: boolean;
  section: string | null;
  suggestion: string | null;
  resolved_by: string | null;
  messages: Array<{ author: string; at: string | null; body: string; ai: boolean }>;
}

export interface AdminComments {
  range: InsightsRange;
  kpis: {
    threads: number; messages: number; resolved: number; open_now: number; items: number; people: number;
    ai_answers: number; median_first_reply_s: number | null;
  };
  series: Array<{ date: string; threads: number; messages: number }>;
  top_items: Array<{ slug: string | null; title: string | null; threads: number; messages: number; open: number }>;
}

export class InsightsError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "InsightsError";
    this.status = status;
    this.code = code;
  }
}

function readPassword(slug: string): string | null {
  try {
    return sessionStorage.getItem(`pwd:${slug}`);
  } catch {
    return null;
  }
}

async function call<T>(path: string, init: RequestInit = {}, slug?: string): Promise<T> {
  const t = getToken();
  const pw = slug ? readPassword(slug) : null;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      cache: "no-store",
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(t ? { Authorization: `Bearer ${t}` } : {}),
        ...(pw ? { "X-Read-Password": pw } : {}),
      },
    });
  } catch {
    throw new InsightsError("Couldn't reach Markdrop. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const detail = body?.detail;
    throw new InsightsError(typeof detail === "string" ? detail : `Request failed (${res.status})`, res.status,
      typeof body?.code === "string" ? body.code : null);
  }
  return (await res.json()) as T;
}

const doc = (slug: string) => `/api/v1/documents/${encodeURIComponent(slug)}/comments`;

export function getCommentInsights(slug: string, range: InsightsRange = "30d"): Promise<CommentInsights> {
  return call(`${doc(slug)}/insights?range=${range}`, {}, slug);
}

export async function getExportThreads(slug: string, status: "open" | "all" = "all"): Promise<ExportThreadDto[]> {
  const r = await call<{ threads: ExportThreadDto[] }>(`${doc(slug)}/export?status=${status}`, {}, slug);
  return r.threads;
}

export async function getCommentDigest(): Promise<boolean> {
  return (await call<{ on: boolean }>("/api/v1/comments/digest/settings")).on;
}

export async function setCommentDigest(on: boolean): Promise<boolean> {
  return (await call<{ on: boolean }>("/api/v1/comments/digest/settings", { method: "PUT", body: JSON.stringify({ on }) })).on;
}

export function getAdminComments(range: InsightsRange = "30d"): Promise<AdminComments> {
  return call(`/api/v1/admin/analytics/comments?range=${range}`);
}

/** "12 min", "3.5 h", "2 days" (null → "—"). */
export function duration(s: number | null | undefined): string {
  if (s == null) return "—";
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 36 * 3600) return `${Number((s / 3600).toFixed(1))} h`;
  return `${Number((s / 86400).toFixed(1))} days`;
}

// "Export with comments" from the comments panel: the page's Export dialog opens with comments on. The page
// (app/[slug]/DocumentView.tsx) registers what opens its dialog; a classic document registers nothing.
let preset: { comments: boolean } | null = null;
const handlers = new Set<() => void>();

export function onExportRequest(open: () => void): () => void {
  handlers.add(open);
  return () => {
    handlers.delete(open);
  };
}

export function canRequestExport(): boolean {
  return handlers.size > 0;
}

export function requestExportWithComments(): void {
  preset = { comments: true };
  handlers.forEach((h) => h());
}

/** The preset the Export dialog starts from (read once). */
export function takeExportPreset(): { comments: boolean } | null {
  const p = preset;
  preset = null;
  return p;
}
