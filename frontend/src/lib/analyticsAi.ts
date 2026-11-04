/**
 * Analytics AI on the analytics home (backend routers/analytics_ai_home.py, Claude Haiku 5.5):
 *
 *   GET  /api/v1/me/analytics/ai/status                    can it run; where the caller may see gaps
 *   GET  /api/v1/me/analytics/ai/story?range=&fresh=       what changed and why, in 3-5 bullets
 *   POST /api/v1/me/analytics/ai/ask   (SSE)               Ask your analytics
 *   GET  /api/v1/me/analytics/ai/gaps?scope=&fresh=        what people looked for and didn't find
 *
 * Signed-in only, like the rest of lib/analytics.ts. Limits come back in the body (status "limit"),
 * so the card can say what happened.
 */
import { API_BASE, getToken } from "@/lib/api";
import { request } from "@/lib/workspaces";
import { SseParser } from "@/lib/pages-ai/sse";

export type StoryRange = "7d" | "30d" | "90d";
export type AiStatusReason = "off" | "not_configured" | "daily" | "monthly" | "burst" | "user_daily" | "blocked" | string;

export interface GapScope { scope: string; label: string; kind: "workspace" | "personal"; role: string }

export interface AnalyticsAiStatus {
  enabled: boolean;
  reason: AiStatusReason | null;
  message: string | null;
  model: string;
  gap_scopes: GapScope[];
}

export interface StoryBullet { text: string; href: string; doc: { slug: string; title: string } | null }

export interface Story {
  status: "ok" | "thin" | "limit" | "error";
  range: StoryRange;
  headline?: string;
  bullets?: StoryBullet[];
  message?: string;
  reason?: string;
  generated_at?: string;
  cached?: boolean;
}

export interface Gap {
  topic: string;
  count: number;
  searches: number;
  questions: number;
  why: string;
  outline: string[];
  examples: string[];
  guides: string[];
  markdown: string;
}

export interface Gaps {
  status: "ok" | "thin" | "limit" | "error";
  scope: string;
  label: string;
  days: number;
  gaps: Gap[];
  signals?: number;
  message?: string;
  reason?: string;
  create: { workspace: string | null };
  generated_at?: string;
  cached?: boolean;
}

export const aiStatus = () => request<AnalyticsAiStatus>("/api/v1/me/analytics/ai/status");

export const getStory = (range: StoryRange, fresh = false) =>
  request<Story>(`/api/v1/me/analytics/ai/story?range=${range}${fresh ? "&fresh=1" : ""}`);

export const getGaps = (scope: string, fresh = false) =>
  request<Gaps>(`/api/v1/me/analytics/ai/gaps?scope=${encodeURIComponent(scope)}${fresh ? "&fresh=1" : ""}`);

export interface AskLink { title: string; href: string }

export type AnalyticsAskEvent =
  | { type: "status"; stage: string; label?: string }
  | { type: "delta"; text: string; reset?: boolean }
  | { type: "done"; answer: string; links: AskLink[]; cached?: boolean; thin?: boolean }
  | { type: "limit"; reason: string; message: string }
  | { type: "error"; detail: string; code?: string };

/** POST /analytics/ai/ask, read as SSE until it ends or `signal` aborts. */
export async function askAnalytics(body: { question: string; range?: string | null; fresh?: boolean },
  onEvent: (e: AnalyticsAskEvent) => void, signal?: AbortSignal): Promise<void> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/me/analytics/ai/ask`, {
      method: "POST",
      signal,
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ question: body.question, ...(body.range ? { range: body.range } : {}), ...(body.fresh ? { fresh: true } : {}) }),
    });
  } catch {
    if (signal?.aborted) return;
    onEvent({ type: "error", detail: "Couldn't reach Markdrop. Check your connection and try again." });
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
      if (data && typeof data === "object") onEvent({ ...data, type: data.type ?? m.event } as AnalyticsAskEvent);
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

/** The board's range as a story range: the story compares a period with the one before it, so
 *  "all time" reads as the last 30 days. */
export function storyRangeOf(range: string): StoryRange {
  return range === "7d" || range === "90d" ? range : "30d";
}

/** Split answer text into plain runs and [title](href) links whose href is an app path the server
 *  returned (anything else stays text). */
export function linkSegments(text: string, allowed: Set<string>): Array<{ text: string; href?: string }> {
  const out: Array<{ text: string; href?: string }> = [];
  const re = /\[([^\]\n]{1,300})\]\(([^)\s]{1,500})\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    const href = m[2];
    out.push(allowed.has(href) && href.startsWith("/") && !href.startsWith("//") ? { text: m[1], href } : { text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
