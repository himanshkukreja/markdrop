"use client";

import { useCallback, useEffect, useState } from "react";
import { useOnUnauthorized } from "../shared";

/** Shared by the Admin → AI tabs: the API client, a small loader hook, formatters and the
 *  per-feature colours (backend/app/routers/admin_ai.py, services/ai_usage.FEATURES). */

export const API = process.env.NEXT_PUBLIC_API_URL || "https://api.markdrop.in";
export type RangeKey = "24h" | "7d" | "30d" | "90d";
export const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: "24h", label: "24 h" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }, { value: "90d", label: "90 days" },
];

type Params = Record<string, string | number | boolean | undefined | null>;

function qs(params: Params) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)]));
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** An error the API explained (its `detail`), shown as is. */
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function detailOf(res: Response, fallback: string) {
  try {
    const j = await res.json();
    if (typeof j?.detail === "string") return j.detail;
  } catch { /* not JSON */ }
  return fallback;
}

export function useAiFetch(token: string) {
  const onUnauthorized = useOnUnauthorized();
  return useCallback(async <T,>(path: string, params: Params = {}): Promise<T> => {
    const res = await fetch(`${API}/api/v1/admin/ai/${path}${qs(params)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) { onUnauthorized(); throw new Error("UNAUTHORIZED"); }
    if (!res.ok) throw new ApiError(await detailOf(res, `${path}: ${res.status}`), res.status);
    return res.json();
  }, [token, onUnauthorized]);
}

export type AiGet = ReturnType<typeof useAiFetch>;

/** PUT a JSON body; resolves with the response JSON, rejects with the API's message. */
export function useAiSend(token: string) {
  const onUnauthorized = useOnUnauthorized();
  return useCallback(async <T,>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(`${API}/api/v1/admin/ai/${path}`, {
      method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (res.status === 401) { onUnauthorized(); throw new Error("UNAUTHORIZED"); }
    if (!res.ok) throw new ApiError(await detailOf(res, "Couldn't save. Try again."), res.status);
    return res.json();
  }, [token, onUnauthorized]);
}

/** POST (no body); resolves with the response JSON, rejects with the API's message. */
export function useAiPost(token: string) {
  const onUnauthorized = useOnUnauthorized();
  return useCallback(async <T,>(path: string): Promise<T> => {
    const res = await fetch(`${API}/api/v1/admin/ai/${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) { onUnauthorized(); throw new Error("UNAUTHORIZED"); }
    if (!res.ok) throw new ApiError(await detailOf(res, "That didn't work. Try again."), res.status);
    return res.json();
  }, [token, onUnauthorized]);
}

/** Download a CSV through the admin token (a plain link can't send the header). */
export function useAiDownload(token: string) {
  const onUnauthorized = useOnUnauthorized();
  return useCallback(async (path: string, params: Params, fallbackName: string) => {
    const res = await fetch(`${API}/api/v1/admin/ai/${path}${qs(params)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) { onUnauthorized(); throw new Error("UNAUTHORIZED"); }
    if (!res.ok) throw new ApiError(await detailOf(res, "Couldn't export."), res.status);
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] || fallbackName;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [token, onUnauthorized]);
}

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: boolean; loading: boolean }>({ loading: true });
  const run = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: false }));
    load().then((data) => setState({ data, loading: false })).catch(() => setState((s) => ({ ...s, loading: false, error: true })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run };
}

// ── Formatting ───────────────────────────────────────────────────────────────

export const n0 = (n: number | null | undefined) => (n ?? 0).toLocaleString("en");
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n}%`);
export function usd(n: number | null | undefined) {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
export const secs = (ms: number | null | undefined) => (ms === null || ms === undefined ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
export const tokensShort = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
/** A cap for display: null is "No cap". */
export const capText = (n: number | null | undefined) => (n === null || n === undefined ? "No cap" : usd(n));

export function ago(iso: string | null | undefined) {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86_400 * 30) return `${Math.floor(s / 86_400)} d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// ── Features ─────────────────────────────────────────────────────────────────

/** The registry's labels (services/ai_usage.FEATURES), for filters and rows that carry only a key. */
export const FEATURE_LABEL: Record<string, string> = {
  docs_ask: "Docs Ask AI", docs_editor: "Guides editor AI", pages_ai: "Pages AI", search_ai: "AI search",
  analytics_ai: "Analytics AI", meetings_ai: "Meetings AI", ask_suggestions: "Ask suggestions",
  workspace_memory: "Team memory", jira_ai: "Jira drafts",
};
export const featureLabel = (k: string | null | undefined) => (k ? FEATURE_LABEL[k] ?? k : "—");

/** Categorical colours in a fixed order (the backend's FEATURES order), never by rank. A feature
 *  the registry doesn't know yet is "other". */
const FEATURE_ORDER = ["docs_ask", "docs_editor", "pages_ai", "search_ai", "analytics_ai", "meetings_ai"];
const SLOTS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"];
export function featureColor(key: string) {
  const i = FEATURE_ORDER.indexOf(key);
  return i >= 0 ? SLOTS[i] : "var(--chart-other)";
}

/** The Workspaces view's own fixed order: the features that run for a workspace (Team memory, Ask
 *  suggestions, Jira drafts) take the slots the docs features have on Overview, and Pages AI,
 *  Analytics AI and Meetings AI keep theirs. Anything else (docs Ask AI, Guides editor, AI search)
 *  folds into "Other". */
export const WS_FEATURE_ORDER = ["workspace_memory", "ask_suggestions", "pages_ai", "jira_ai", "analytics_ai", "meetings_ai"];
export const WS_OTHER = "other";
export const wsFeatureKey = (key: string) => (WS_FEATURE_ORDER.includes(key) ? key : WS_OTHER);
export function wsFeatureColor(key: string) {
  const i = WS_FEATURE_ORDER.indexOf(key);
  return i >= 0 ? SLOTS[i] : "var(--chart-other)";
}

export const OUTCOME_TONE: Record<string, "success" | "warning" | "danger" | "neutral" | "info"> = {
  ok: "success", answered: "success", no_answer: "warning", off_topic: "neutral", refused: "danger", limit: "info", error: "danger",
};
export const OUTCOME_LABEL: Record<string, string> = {
  ok: "OK", answered: "Answered", no_answer: "No answer", off_topic: "Off topic", refused: "Refused", limit: "Limited", error: "Error",
};
export const LIMIT_LABEL: Record<string, string> = {
  budget_daily: "Daily cap", budget_monthly: "Monthly cap", budget_global_daily: "All-AI daily cap", budget_global_monthly: "All-AI monthly cap",
  budget_site_daily: "Site daily cap", budget_site_monthly: "Site monthly cap", site_answers_monthly: "Guide allowance",
  guide_budget: "Guide allowance", user_daily: "Per-person limit", user_spend: "Per-person spend cap", blocked: "Blocked",
  burst: "Burst limit", rate_limited: "Hourly limit", busy: "Busy", daily: "Daily cap", monthly: "Monthly cap",
};
