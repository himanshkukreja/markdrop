/**
 * Creator analytics v1: typed fetchers for the owner-only read API (`/api/v1/me/.../analytics*`).
 *
 * Kept out of lib/api.ts (loaded by every public document page): none of this is reachable without
 * a session. Auth is the same bearer token lib/api.ts uses. CSV and frame images come back as
 * blobs (the frame endpoint needs the bearer header, so an <img src> can't fetch it directly).
 *
 * Dev only: `?fixture=1` on any analytics page answers every call from local sample data
 * (lib/analyticsFixtures.ts, loaded on demand), so the pages can be looked at without a backend.
 * It is compiled out of production builds.
 */
import { API_BASE, getDocument } from "@/lib/api";

const TOKEN_KEY = "markdrop_token";

function authHeaders(): Record<string, string> {
  const t = typeof window === "undefined" ? null : localStorage.getItem(TOKEN_KEY);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// ── Types (build spec §3, §5) ──────────────────────────────────────────────────

export type AnalyticsRange = "7d" | "30d" | "90d" | "all";
export const RANGES: { value: AnalyticsRange; label: string; long: string }[] = [
  { value: "7d", label: "7 days", long: "last 7 days" },
  { value: "30d", label: "30 days", long: "last 30 days" },
  { value: "90d", label: "90 days", long: "last 90 days" },
  { value: "all", label: "All time", long: "all time" },
];
export const isRange = (v: string | null | undefined): v is AnalyticsRange => v === "7d" || v === "30d" || v === "90d" || v === "all";

/** What a tracked session was: markdown, a PDF, a video, audio, or any other artifact. */
export type TrackKind = "doc" | "pdf" | "video" | "audio" | "other";

export type KpiUnit = "count" | "seconds" | "percent" | "hours";
export interface Kpi {
  key: string;
  label: string;
  value: number;
  unit: KpiUnit;
  /** The previous window of equal length (absent for "all"). */
  prev?: number | null;
  note?: string | null;
}

export type InsightTab = "overview" | "video" | "listening" | "content" | "pages" | "audience" | "versions" | "viewers";
export interface Insight {
  key: string;
  title: string;
  body: string;
  severity: "info" | "warning" | "success";
  cta?: { label: string; tab: InsightTab | string } | null;
  /** Short text for the thumbnail box ("2:14", "v3 → v4", "QoE"). */
  thumb?: string | null;
  /** Home: which document it is about. */
  slug?: string | null;
}

export interface AnalyticsDoc {
  slug: string;
  title: string | null;
  kind: TrackKind;
  renderer?: string | null;
  mime?: string | null;
  duration_s?: number | null;
  npages?: number | null;
  file_version?: number | null;
  workspace?: { id: string; name: string } | null;
  /** "docs.acme.com/guides/product-demo" or "markdrop.in/slug". */
  address: string;
  created_at: string;
  /** Not in the spec: encrypted docs have no readable title. Optional. */
  encrypted?: boolean;
}

export interface DailyPoint { date: string; views: number; people: number }

export interface Overview {
  doc: AnalyticsDoc;
  range: AnalyticsRange;
  has_engagement: boolean;
  tracking_since: string | null;
  live: number;
  kpis: Kpi[];
  daily: DailyPoint[];
  versions_marks: { date: string; version: number }[];
  sources: { channel: string; views: number }[];
  insights: Insight[];
}

export interface Moment {
  t: number;
  kind: "hold" | "drop" | "rewatch";
  pct?: number | null;
  delta?: number | null;
  title: string;
  body: string;
}

export interface MediaAnalytics {
  ver: number;
  dur: number;
  sessions: number;
  viewers: number;
  retention: { t: number; pct: number }[];
  rewatch: number[];
  moments: Moment[];
  speeds: { rate: string; pct: number }[];
  fullscreen_pct: number;
  muted_pct: number;
  pip_pct: number;
  qoe?: {
    startup_p50_ms: number | null;
    startup_p95_ms: number | null;
    stalled_pct: number;
    failed_pct: number;
    failed_n: number;
    failed_by: { reason: string; n: number }[];
    phone_slow_pct: number | null;
    phone_slow_by: { country: string; pct: number }[];
    bitrate_kbps: number | null;
    suggestion?: string | null;
  } | null;
  versions: { version: number; created_at: string; sessions: number }[];
}

export interface ContentAnalytics {
  sessions: number;
  read_all_pct: number;
  median_active_s: number;
  sections: { id: string; reached_pct: number; median_s: number }[];
  copies: { hash: string; section: string; n: number }[];
  links: { href: string; section: string; n: number }[];
  prints: number;
}

export interface PagesAnalytics {
  sessions: number;
  npages: number;
  reach: { page: number; pct: number }[];
  time: { page: number; median_s: number }[];
  back: { page: number; pct: number }[];
  biggest_drop?: { after_page: number; pct: number } | null;
}

export interface AudienceAnalytics {
  new: number;
  returning: number;
  returning_ratio_note?: string | null;
  devices: { device: string; pct: number; engaged_pct: number | null }[];
  countries: { country: string; people: number; engaged_pct: number | null }[];
  channels: { channel: string; views: number; engaged_pct: number | null }[];
  signals: { platform: string; n: number; last: string }[];
  campaigns: { source: string | null; medium: string | null; campaign: string | null; people: number; engaged_pct: number | null }[];
  internal_hidden: number;
  workspace?: { id: string; name: string } | null;
}

export interface VersionsAnalytics {
  versions: {
    version: number;
    created_at: string;
    views: number;
    sessions: number;
    primary_metric: { label: string; value: number } | null;
    first_minute?: { t: number; pct: number }[] | null;
  }[];
}

export interface HomeLink {
  slug: string;
  title: string | null;
  kind: TrackKind;
  renderer?: string | null;
  icon?: string | null;
  views: number;
  spark: number[];
  engage_label: string | null;
  last_view: string | null;
  live: boolean;
}

export interface HomeAnalytics {
  range: AnalyticsRange;
  kpis: Kpi[];
  live: { people: number; links: number };
  links: HomeLink[];
  insights: Insight[];
}

export interface LivePos { s?: number; h?: string; p?: number }
export interface LiveAnalytics {
  people: number;
  links: number;
  docs: {
    slug: string;
    title: string | null;
    kind: TrackKind;
    n: number;
    /** Not in the spec (optional): a video/audio duration, to place viewers on a timeline. */
    dur?: number | null;
    entries: { pos: LivePos | null; country: string | null; device: string | null }[];
  }[];
  feed: { at: string; text: string; slug: string | null }[];
}

// ── Errors ─────────────────────────────────────────────────────────────────────

/** A failed call that keeps its HTTP status (0 = network). 403/404 mean "not yours". */
export class AnalyticsError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AnalyticsError";
    this.status = status;
  }
}
export const isNotYours = (e: unknown) => e instanceof AnalyticsError && (e.status === 403 || e.status === 404);
export const isSignedOut = (e: unknown) => e instanceof AnalyticsError && e.status === 401;

// ── Fixture mode (development only) ────────────────────────────────────────────

const FIXTURE_KEY = "md_analytics_fixture";

/** True in development when `?fixture=1` was seen this tab session (`?fixture=0` turns it off). */
export function fixtureMode(): boolean {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search).get("fixture");
    if (q === "1") sessionStorage.setItem(FIXTURE_KEY, "1");
    else if (q === "0") sessionStorage.removeItem(FIXTURE_KEY);
    return sessionStorage.getItem(FIXTURE_KEY) === "1";
  } catch {
    return false;
  }
}

async function fromFixture<T>(path: string): Promise<T> {
  // The literal NODE_ENV test lets production builds drop the sample-data chunk entirely.
  if (process.env.NODE_ENV !== "production") {
    const { fixtureFor } = await import("./analyticsFixtures");
    await new Promise((r) => setTimeout(r, 350));
    return fixtureFor(path) as T;
  }
  throw new Error("fixtures are development-only");
}

// ── Transport ──────────────────────────────────────────────────────────────────

async function send(path: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1${path}`, { cache: "no-store", headers: { ...authHeaders() } });
  } catch {
    throw new AnalyticsError("Couldn't reach Markdrop. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    const msg = typeof body?.detail === "string" ? body.detail : `Request failed (${res.status})`;
    throw new AnalyticsError(msg, res.status);
  }
  return res;
}

async function getJson<T>(path: string): Promise<T> {
  if (fixtureMode()) return fromFixture<T>(path);
  const res = await send(path);
  return res.json() as Promise<T>;
}

const q = (params: Record<string, string | number | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
const doc = (slug: string) => `/me/documents/${encodeURIComponent(slug)}`;

export interface Scope { range: AnalyticsRange; internal: boolean }
const scopeQ = (s: Scope, extra: Record<string, string | number | null | undefined> = {}) =>
  q({ range: s.range, internal: s.internal ? 1 : 0, ...extra });

// ── Fetchers (§3.1–3.11) ───────────────────────────────────────────────────────

export const getOverview = (slug: string, s: Scope) => getJson<Overview>(`${doc(slug)}/analytics/overview${scopeQ(s)}`);
export const getMedia = (slug: string, s: Scope, ver?: number | null) => getJson<MediaAnalytics>(`${doc(slug)}/analytics/media${scopeQ(s, { ver })}`);
export const getContent = (slug: string, s: Scope) => getJson<ContentAnalytics>(`${doc(slug)}/analytics/content${scopeQ(s)}`);
export const getPages = (slug: string, s: Scope) => getJson<PagesAnalytics>(`${doc(slug)}/analytics/pages${scopeQ(s)}`);
export const getAudience = (slug: string, s: Scope) => getJson<AudienceAnalytics>(`${doc(slug)}/analytics/audience${scopeQ(s)}`);
export const getVersions = (slug: string, s: Scope) => getJson<VersionsAnalytics>(`${doc(slug)}/analytics/versions${scopeQ(s)}`);
export const getHome = (s: Scope) => getJson<HomeAnalytics>(`/me/analytics${scopeQ(s)}`);
export const getLive = () => getJson<LiveAnalytics>(`/me/analytics/live`);

/** A video frame at `t` seconds as an object URL (the caller revokes it). null when unavailable. */
export async function getFrameUrl(slug: string, t: number, ver?: number | null): Promise<string | null> {
  if (fixtureMode()) return null;
  try {
    const res = await send(`${doc(slug)}/analytics/frame${q({ t: Math.round(t), ver })}`);
    const blob = await res.blob();
    if (!blob.type.startsWith("image/")) return null;
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

/** Downloads a CSV through fetch (bearer header) and saves it under `filename`. */
async function downloadCsv(path: string, filename: string): Promise<void> {
  let blob: Blob;
  if (fixtureMode()) {
    blob = new Blob(["date,views,people,sessions,active_s,watched_s\n2026-10-27,88,71,60,5120,0\n"], { type: "text/csv" });
  } else {
    const res = await send(path);
    blob = await res.blob();
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const downloadDocCsv = (slug: string, range: AnalyticsRange) =>
  downloadCsv(`${doc(slug)}/analytics.csv${q({ range })}`, `${slug}-analytics-${range}.csv`);
export const downloadHomeCsv = (range: AnalyticsRange) =>
  downloadCsv(`/me/analytics.csv${q({ range })}`, `markdrop-analytics-${range}.csv`);

// ── Viewers: every view, who and what they did (backend services/doc_views.py) ─

export type ViewerWho = "all" | "signed_in" | "anonymous";
export type ViewCompletion = "any" | "low" | "mid" | "high" | "done";
export type ViewersAccess = "full" | "counts";

export interface ViewViewer {
  type: "user" | "anonymous";
  /** Account id, or the anonymous key (stable for one browser on this owner's links). */
  id: string | null;
  /** The person's name, or "Visitor 3F2A". */
  name: string | null;
  email: string | null;
  avatar?: string | null;
  deleted?: boolean;
}

export interface ViewSummary {
  id: string;
  viewer: ViewViewer;
  own: boolean;
  internal: boolean;
  kind: string;
  ver?: number | null;
  started_at: string;
  last_at: string;
  open_s: number;
  active_s: number;
  /** 0..100: read depth, PDF pages, slides, tabs or video watched; null when there's no measure. */
  completion: number | null;
  ended: boolean;
  visit_n: number | null;
  watched_s?: number;
  duration_s?: number;
  location: { country: string | null; region: string | null; city: string | null; timezone: string | null; label: string | null };
  system: {
    device: string | null; os: string | null; os_version: string | null; browser: string | null;
    browser_version: string | null; in_app: string | null; app: "tab" | "pwa" | "embed"; embed_host: string | null;
    viewport: string | null; screen: string | null; language: string | null; label: string;
  };
  source: string;
  channel: string;
  referrer: string | null;
  utm: { source?: string; medium?: string; campaign?: string } | null;
  acts: Partial<Record<"link" | "copy" | "dl" | "print" | "ask" | "signoff" | "fs", number>>;
}

export interface ViewersBreakdownRow { key: string; views: number }
export interface ViewersResponse {
  access: ViewersAccess;
  doc: { slug: string; title: string; kind: string; track_kind: TrackKind; mime: string | null; renderer: string | null; encrypted: boolean; workspace_id: string | null; access: ViewersAccess };
  totals: { views: number; people: number; signed_in: number; anonymous: number; avg_active_s?: number; avg_completion?: number | null; own_hidden?: number };
  retention_days: number;
  /** Absent for "counts" access. */
  views?: ViewSummary[];
  total?: number;
  offset?: number;
  next?: number | null;
  sampled?: boolean;
  breakdowns?: Record<"country" | "city" | "device" | "os" | "browser" | "source" | "app", ViewersBreakdownRow[]>;
}

export interface ViewStep {
  t: number;
  at: string;
  kind: string;
  text: string;
  label?: string;
  active_s?: number;
  jump?: boolean;
  url?: string;
  question?: string;
  start?: number;
  end?: number;
}

export interface ViewTimeline extends ViewSummary {
  steps: ViewStep[];
  other_views: { id: string; started_at: string; active_s: number }[];
  truncated: boolean;
  text: string;
}

export interface ViewerPerson {
  key: string;
  viewer: ViewViewer;
  views: number;
  active_s: number;
  best_completion: number | null;
  first_at: string;
  last_at: string;
  last_view: string;
  place: string | null;
  system: string;
  internal: boolean;
  own: boolean;
}

export interface ViewersQuery {
  range: AnalyticsRange;
  who?: ViewerWho;
  completion?: ViewCompletion;
  own?: boolean;
  internal?: boolean;
  country?: string | null;
  device?: string | null;
  os?: string | null;
  browser?: string | null;
  source?: string | null;
}

const viewersQ = (v: ViewersQuery, extra: Record<string, string | number | null | undefined> = {}) =>
  q({
    range: v.range, who: v.who && v.who !== "all" ? v.who : null,
    completion: v.completion && v.completion !== "any" ? v.completion : null,
    own: v.own ? 1 : null, internal: v.internal === false ? 0 : null,
    country: v.country, device: v.device, os: v.os, browser: v.browser, source: v.source, ...extra,
  });

export const getViewers = (slug: string, v: ViewersQuery, offset = 0, limit = 50) =>
  getJson<ViewersResponse>(`${doc(slug)}/analytics/viewers${viewersQ(v, { offset: offset || null, limit })}`);
export const getViewerPeople = (slug: string, v: ViewersQuery) =>
  getJson<{ people: ViewerPerson[]; total: number; sampled: boolean }>(
    `${doc(slug)}/analytics/viewers/people${q({ range: v.range, who: v.who && v.who !== "all" ? v.who : null, own: v.own ? 1 : null, internal: v.internal === false ? 0 : null })}`);
export const getViewTimeline = (slug: string, viewId: string) =>
  getJson<ViewTimeline>(`${doc(slug)}/analytics/viewers/${encodeURIComponent(viewId)}`);
export const downloadViewersCsv = (slug: string, v: ViewersQuery) =>
  downloadCsv(`${doc(slug)}/analytics/viewers.csv${viewersQ(v)}`, `${slug}-viewers-${v.range}.csv`);

/** The views you made while signed in (what owners see with your name), newest first. */
export const getMyViewHistory = () =>
  getJson<{ views: { started_at: string; active_s: number; kind: string; slug: string | null; title: string }[]; total: number; retention_days: number }>(`/me/view-history`);

/** Takes your name off every view you made; returns how many. */
export async function forgetMyViewHistory(): Promise<number> {
  const res = await fetch(`${API_BASE}/api/v1/me/view-history`, { method: "DELETE", headers: { ...authHeaders() } });
  if (!res.ok) throw new AnalyticsError(`Request failed (${res.status})`, res.status);
  return ((await res.json()) as { forgotten: number }).forgotten;
}

// ── Analytics AI per document (services/analytics_ai_doc.py) ─────────────────

/** content (Markdown), media (video/audio), pages (PDF), versions (files with versions). */
export type AiKind = "content" | "media" | "pages" | "versions";
export type AiState = "ready" | "empty" | "thin" | "encrypted" | "unsupported";
export type AiSeverity = "high" | "medium" | "low";

export interface AiFinding {
  severity: AiSeverity;
  title: string;
  why: string;
  suggestion: string;
  /** content: the section it's about (heading text and level, for "Apply in page"). */
  section?: { n: number; id: string; title: string; depth: number; reached_pct: number; lost_before_pct: number } | null;
  /** content: new Markdown for that section's body (never applied by itself). */
  rewrite?: string | null;
  /** content: what "Apply in page" offers over the section: its heading, the rewrite, its sub-sections. */
  apply_markdown?: string | null;
  /** media: seconds (and an optional end). */
  t?: number | null;
  end?: number | null;
  /** media: a key moment with a frame near `t`. */
  frame_t?: number | null;
  /** pages: the page number. */
  page?: number | null;
  /** versions: the version it's about. */
  version?: number | null;
}

export interface AiMoment { n: number; t: number; kind: "drop" | "skip" | "rewatch"; still_watching_pct: number; frame?: boolean; delta?: number; dip?: number; ratio?: number }

export interface AiResult {
  summary: string;
  findings: AiFinding[];
  chapters?: { t: number; title: string }[];
  moments?: AiMoment[];
  ver?: number;
  verdict?: {
    winner: number;
    headline: string;
    explanation: string;
    metric: string;
    value: number;
    unit: "percent" | "seconds";
    sessions: number;
    runner_up: { version: number; value: number; sessions: number } | null;
    confidence: { level: "high" | "medium" | "low"; note: string };
  };
}

export interface AiAnalysis {
  kind: AiKind;
  state: AiState;
  result: AiResult | null;
  stale: boolean;
  generated_at: string | null;
  sample: { have: number; need: number } | null;
  note: string | null;
  /** Why AI can't run right now (off, workspace_off, daily, …), before anyone clicks. */
  limit: { reason: string; message: string } | null;
  /** A page this person may edit: a rewrite can be offered in its editor. */
  can_apply: boolean;
  kinds: AiKind[];
}

/** A failed analysis: `code` "limit" (with `reason`), "bad_output", "upstream"… */
export class AiError extends AnalyticsError {
  code: string;
  reason: string | null;
  constructor(message: string, status: number, code: string, reason: string | null) {
    super(message, status);
    this.name = "AiError";
    this.code = code;
    this.reason = reason;
  }
}

const aiPath = (slug: string, kind: AiKind, s: Scope, ver?: number | null) =>
  `${doc(slug)}/analytics/ai/${kind}${scopeQ(s, { ver: kind === "media" ? ver : null })}`;

export const getAiAnalysis = (slug: string, kind: AiKind, s: Scope, ver?: number | null) =>
  getJson<AiAnalysis>(aiPath(slug, kind, s, ver));

/** Analyse (or Re-analyse with `refresh`). Throws AiError (429 limits, 502 a failed answer). */
export async function runAiAnalysis(slug: string, kind: AiKind, s: Scope, ver?: number | null, refresh = false): Promise<AiAnalysis> {
  if (fixtureMode()) return fromFixture<AiAnalysis>(`${aiPath(slug, kind, s, ver)}${refresh ? "&refresh=1" : ""}&run=1`);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1${aiPath(slug, kind, s, ver)}`, {
      method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(refresh ? { refresh: true } : {}),
    });
  } catch {
    throw new AiError("Couldn't reach Markdrop. Check your connection and try again.", 0, "network", null);
  }
  const body = (await res.json().catch(() => null)) as (AiAnalysis & { detail?: unknown; code?: string; reason?: string }) | null;
  if (!res.ok) {
    const msg = typeof body?.detail === "string" ? body.detail : "AI hit a problem. Try again in a moment.";
    throw new AiError(msg, res.status, body?.code ?? "error", body?.reason ?? null);
  }
  return body as AiAnalysis;
}

/**
 * A markdown document's text for mapping heading ids to titles and copy hashes to code. Owner
 * read (bearer). null for encrypted documents, artifacts or any failure: callers fall back.
 */
export async function getDocMarkdown(slug: string): Promise<string | null> {
  if (process.env.NODE_ENV !== "production" && fixtureMode()) {
    const { fixtureMarkdown } = await import("./analyticsFixtures");
    return fixtureMarkdown(slug);
  }
  try {
    const d = await getDocument(slug);
    if (d.encrypted || d.kind === "artifact") return null;
    return d.content || null;
  } catch {
    return null;
  }
}

// ── Helpers shared with the tracker's hashing (§1b copies) ────────────────────

/** FNV-1a 32-bit over UTF-8 bytes, as unpadded lower-case hex. */
export function fnv1a32Utf8(text: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** FNV-1a 32-bit over UTF-16 code units (what a quick `charCodeAt` loop computes). */
export function fnv1a32Units(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** Two hex hashes are the same number (padding and case don't matter). */
export const sameHash = (a: string, b: string) => {
  const x = parseInt(a, 16), y = parseInt(b, 16);
  return Number.isFinite(x) && x === y;
};

/** The fenced code blocks of a markdown document: trimmed text, in order. */
export function fencedBlocks(markdown: string): string[] {
  const out: string[] = [];
  let fence: { ch: string; len: number; indent: number } | null = null;
  let buf: string[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    if (fence) {
      const close = /^(\s{0,3})(`{3,}|~{3,})\s*$/.exec(raw);
      if (close && close[2]![0] === fence.ch && close[2]!.length >= fence.len) {
        out.push(buf.join("\n").trim());
        fence = null;
        buf = [];
      } else {
        buf.push(fence.indent ? raw.replace(new RegExp(`^ {0,${fence.indent}}`), "") : raw);
      }
      continue;
    }
    const open = /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(raw);
    if (open && !(open[2]![0] === "`" && open[3]!.includes("`"))) {
      fence = { ch: open[2]![0]!, len: open[2]!.length, indent: open[1]!.length };
      buf = [];
    }
  }
  if (fence && buf.length) out.push(buf.join("\n").trim());
  return out;
}

/** The first non-empty line of the fenced block whose hash matches, or null. */
export function blockPreview(blocks: string[], hash: string): string | null {
  for (const b of blocks) {
    if (sameHash(fnv1a32Utf8(b), hash) || sameHash(fnv1a32Units(b), hash)) {
      return b.split("\n").find((l) => l.trim())?.trim() ?? null;
    }
  }
  return null;
}
