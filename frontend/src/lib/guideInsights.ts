/**
 * A guide's Insights (backend routers/guide_insights.py): how readers use a published Markdrop
 * Guides site. Kept out of lib/docsSites.ts so the editor's bundle doesn't carry it.
 */
import { API_BASE } from "@/lib/api";
import { DocsApiError } from "@/lib/docsSites";

const TOKEN_KEY = "markdrop_token";
const BASE = "/api/v1/docs-sites";

export type InsightsRange = "7d" | "30d" | "90d";
export const INSIGHTS_RANGES: { value: InsightsRange; label: string; long: string }[] = [
  { value: "7d", label: "7 days", long: "last 7 days" },
  { value: "30d", label: "30 days", long: "last 30 days" },
  { value: "90d", label: "90 days", long: "last 90 days" },
];
export const isInsightsRange = (v: string | null | undefined): v is InsightsRange => v === "7d" || v === "30d" || v === "90d";

export type FeedbackFilter = "open" | "resolved" | "all";

export interface InsightsDay { date: string; views: number; visitors: number; searches: number }
export interface FeedbackItem { id: string; path: string; helpful: boolean; comment: string | null; source: "page" | "mcp"; ts: string; resolved: boolean }
export interface AskQuestion { q: string; n: number; unanswered: number; last: string | null; page: string | null }

export interface Insights {
  range: InsightsRange;
  /** Collection on (settings.insights.enabled). */
  enabled: boolean;
  /** The guide has a live build (nothing is collected before). */
  live: boolean;
  /** The first event kept, or null: nothing collected yet. */
  since: string | null;
  daily: InsightsDay[];
  totals: { views: number; visitors: number; searches: number; empty_searches: number };
  /** The window before, when there was data then. */
  previous: { views: number; visitors: number; searches: number } | null;
  pages: { path: string; title: string | null; views: number; visitors: number }[];
  referrers: { host: string; views: number }[];
  countries: { country: string; views: number }[];
  devices: { device: "desktop" | "mobile" | "tablet"; views: number }[];
  searches: { top: { q: string; n: number; empty: number }[]; empty: { q: string; n: number }[] };
  ask: {
    asked: number; answered: number; unanswered: number; helpful: number; not_helpful: number;
    top: AskQuestion[]; unanswered_top: AskQuestion[]; capped: boolean;
  };
  feedback: {
    yes: number; no: number; helpful_pct: number | null; open: number;
    pages: { path: string; yes: number; no: number }[];
    items: FeedbackItem[];
  };
  can_manage: boolean;
  can_resolve: boolean;
}

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const token = typeof window === "undefined" ? null : localStorage.getItem(TOKEN_KEY);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${BASE}${path}`, {
      ...rest,
      cache: "no-store",
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  } catch {
    throw new DocsApiError("Couldn't reach Markdrop. Check your connection and try again.", 0);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = (body as { detail?: unknown } | null)?.detail;
    throw new DocsApiError(typeof detail === "string" ? detail : `Request failed (${res.status})`, res.status, body);
  }
  return body as T;
}

const enc = encodeURIComponent;

export function getInsights(siteId: string, range: InsightsRange, feedback: FeedbackFilter = "open"): Promise<Insights> {
  return call<Insights>(`/${enc(siteId)}/insights?range=${range}&feedback=${feedback}`);
}

/** Editors and up. */
export function resolveFeedback(siteId: string, id: string, resolved: boolean): Promise<FeedbackItem> {
  return call<FeedbackItem>(`/${enc(siteId)}/insights/feedback/${enc(id)}`, { method: "PATCH", json: { resolved } });
}

/** Admins: delete everything Insights holds for the guide. */
export function clearInsights(siteId: string): Promise<{ cleared: { events: number; days: number; feedback: number } }> {
  return call(`/${enc(siteId)}/insights`, { method: "DELETE" });
}
