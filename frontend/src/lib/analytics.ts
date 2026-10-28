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

export type InsightTab = "overview" | "video" | "listening" | "content" | "pages" | "audience" | "versions";
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
