/**
 * Docs sites API (Markdrop Docs, Phase 1): a typed client for every `/api/v1/docs-sites` endpoint.
 *
 * Kept out of lib/api.ts for the same reason lib/workspaces.ts is: nothing here is reachable without
 * a session, and lib/api.ts loads on every public document page.
 *
 * Errors keep their HTTP status and the parsed body, because the editor acts on three of them:
 * 409 on a page save (someone saved a newer version: `base_rev` is stale), 423 (the page is locked by
 * someone else: the body carries the lock) and 409 on publish (this site requires a review).
 */
import { API_BASE } from "@/lib/api";

const TOKEN_KEY = "markdrop_token";
const BASE = "/api/v1/docs-sites";

function authHeaders(): Record<string, string> {
  const t = typeof window === "undefined" ? null : localStorage.getItem(TOKEN_KEY);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** A refused docs-sites call: the status, the server's message and whatever else the body said. */
export class DocsApiError extends Error {
  status: number;
  /** The parsed JSON body (`detail` and anything beside it), or null. */
  body: unknown;
  /** `detail` when it was an object (e.g. `{message, lock}` on a 423, `{message, current}` on a 409). */
  detail: Record<string, unknown> | null;
  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.name = "DocsApiError";
    this.status = status;
    this.body = body;
    const d = (body as { detail?: unknown } | null)?.detail;
    this.detail = d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
  }
}

export const docsErrorStatus = (e: unknown): number => (e instanceof DocsApiError ? e.status : 0);
export const docsErrorMessage = (e: unknown, fallback = "That didn't work. Try again."): string =>
  e instanceof Error && e.message ? e.message : fallback;

function messageOf(body: unknown, status: number): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return (detail[0] as { msg?: string } | undefined)?.msg || "That value isn't valid.";
  if (detail && typeof detail === "object") {
    const m = (detail as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  const m = (body as { message?: unknown } | null)?.message;
  if (typeof m === "string") return m;
  if (status === 423) return "Someone else is editing this page.";
  if (status === 409) return "Someone saved a newer version.";
  return `Request failed (${status})`;
}

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const isForm = typeof FormData !== "undefined" && rest.body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${BASE}${path}`, {
      ...rest,
      cache: "no-store",
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      headers: { ...(isForm ? {} : { "Content-Type": "application/json" }), ...authHeaders(), ...(rest.headers || {}) },
    });
  } catch {
    throw new DocsApiError("Couldn't reach Markdrop. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new DocsApiError(messageOf(body, res.status), res.status, body);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const q = (params: Record<string, string | number | boolean | null | undefined>): string => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
};
const enc = encodeURIComponent;

// ── Types (the spec's contract) ──────────────────────────────────────────────

/** Workspace owner/admin → "owner"/"admin"; "Can edit" → "editor"; "Can view" → "viewer". */
export type DocsRole = "owner" | "admin" | "editor" | "viewer";
export type SiteStatus = "draft" | "live" | "unpublished";
export type SourceKind = "blank" | "template" | "gitbook" | "github";
export type ThemePreset = "clean" | "editorial" | "technical" | "minimal" | "playful" | "helpcenter";
export type ThemeMode = "both" | "light" | "dark";
export type Corners = "sharp" | "soft" | "round";
export type AccessLevel = "public" | "password" | "members";
export type TemplateId = "product" | "api" | "helpcenter";

export interface SiteSource {
  kind: SourceKind;
  url?: string;
  template?: TemplateId | string;
  repo?: { owner: string; name: string; branch: string; path: string };
}

export interface SiteBrand {
  enabled: boolean;
  logo_url?: string | null;
  logo_dark_url?: string | null;
  colors: string[];
  accent?: string | null;
  accent_dark?: string | null;
}

export interface SiteTheme {
  preset: ThemePreset;
  brand: SiteBrand;
  fonts: { heading?: string | null; body?: string | null };
  mode: ThemeMode;
  corners?: Corners | null;
  /** ≤ 20 KB; no remote @import, no non-https url(), no expressions (validated by the API). */
  custom_css?: string | null;
}

export interface NavGroup {
  group: string;
  pages: string[];
}

export interface Redirect {
  from: string;
  to: string;
}

export interface SiteSettings {
  theme: SiteTheme;
  ai: { enabled: boolean; name?: string | null; suggestions?: string[] };
  /** `password` is write-only: send it to set a password; the API never returns it (only `has_password`). */
  access: { level: AccessLevel; password?: string; has_password?: boolean };
  seo: { index: boolean };
  review: { required: boolean };
  nav: NavGroup[];
  /** Optional until the API grows it: old addresses kept working (GitBook import fills it). */
  redirects?: Redirect[];
}

export interface SiteDomain {
  host: string;
  status: "pending" | "verified" | "live" | "failed" | string;
}

export type BuildStatus = "queued" | "building" | "publishing" | "live" | "failed" | "superseded";

export interface Build {
  id: string;
  site_id: string;
  number: number;
  status: BuildStatus;
  requested_by: string;
  /** Display name for `requested_by` when the API includes it. */
  requested_by_name?: string | null;
  review_id?: string | null;
  note?: string | null;
  snapshot_id?: string;
  manifest_hash?: string | null;
  stats?: { pages: number; objects: number; uploaded: number; bytes: number; ms: number } | null;
  error?: string | null;
  /** The build job, when the API links it (progress on the Publish screen). */
  job_id?: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface Usage {
  /** Workspace scope (list): sites used / allowed. */
  sites?: number;
  limit?: number;
  /** Ask AI answers this month and the monthly allowance (per site; on the list, the busiest site's). */
  ai_used?: number;
  ai_limit?: number;
  /** Which site `ai_used` belongs to on the list. */
  ai_site_name?: string | null;
  pages?: number;
  page_limit?: number;
  asset_bytes?: number;
  asset_limit?: number;
  builds_today?: number;
  build_limit?: number;
}

export interface SiteSummary {
  id: string;
  workspace_id: string | null;
  name: string;
  slug: string;
  status: SiteStatus;
  /** The free address host: `<slug>.docs.markdrop.in`. */
  host?: string;
  domains?: SiteDomain[];
  preset?: ThemePreset;
  /** A light snapshot of the theme for the card thumbnail. */
  theme?: Pick<SiteTheme, "preset" | "mode"> & { accent?: string | null };
  page_count?: number;
  /** Pages with unpublished drafts. */
  changes?: number;
  open_reviews?: number;
  last_published_at?: string | null;
  last_published_by?: string | null;
  last_published_by_name?: string | null;
  your_role?: DocsRole;
  updated_at?: string;
}

export interface Site extends SiteSummary {
  owner_id: string;
  source: SiteSource;
  settings: SiteSettings;
  live_build_id: string | null;
  live_build?: Build | null;
  counts?: { pages?: number; changes?: number; open_reviews?: number; hidden?: number };
  usage?: Usage;
  your_role: DocsRole;
  /** The import/seed job a new gitbook/template site started (POST response and while it runs). */
  job_id?: string | null;
  import_job_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PageLock {
  user_id: string;
  name: string;
  expires_at: string;
}

export interface PageSummary {
  id: string;
  path: string;
  title: string;
  icon?: string | null;
  hidden: boolean;
  has_changes: boolean;
  /** Never published yet. */
  is_new?: boolean;
  lock: PageLock | null;
}

export interface PagesResponse {
  nav: NavGroup[];
  pages: PageSummary[];
}

export interface PageDraft {
  markdown: string;
  frontmatter_extra?: Record<string, unknown> | null;
  rev: number;
  updated_by: string;
  updated_by_name?: string | null;
  updated_at: string;
}

export interface Page {
  id: string;
  site_id: string;
  path: string;
  title: string;
  description: string;
  icon?: string | null;
  hidden: boolean;
  draft: PageDraft;
  published: { markdown: string; rev: number; published_build_id: string } | null;
  lock: PageLock | null;
  created_at: string;
}

export interface PageVersion {
  id: string;
  page_id: string;
  site_id: string;
  rev: number;
  markdown: string;
  title: string;
  description: string;
  by: string;
  by_name?: string | null;
  at: string;
  kind: "save" | "import" | "restore";
}

export interface PageChange {
  page_id: string;
  path: string;
  title: string;
  kind: "new" | "edited" | "deleted" | "moved";
  by?: string | null;
  by_name?: string | null;
  lines_changed?: number | null;
  group?: string | null;
}

export interface ChangesResponse {
  pages: PageChange[];
  settings_changed: boolean;
  /** Which settings changed (e.g. ["theme", "nav"]), when the API says. */
  settings?: string[];
  settings_by_name?: string | null;
}

export type ReviewStatus = "open" | "approved" | "changes_requested" | "withdrawn";

export interface Review {
  id: string;
  site_id: string;
  requested_by: string;
  requested_by_name?: string | null;
  note: string;
  page_ids: string[];
  status: ReviewStatus;
  decided_by?: string | null;
  decided_by_name?: string | null;
  decided_at?: string | null;
  comment?: string | null;
  created_at: string;
  /** Who will be asked (admins), when the API includes it. */
  reviewers?: Array<{ user_id: string; name: string }>;
}

export type JobStatus = "queued" | "running" | "done" | "failed";

/** One row of the import screen's step list, when the worker sends its own list. */
export interface JobStep {
  id: string;
  label: string;
  detail?: string | null;
  status: "done" | "running" | "waiting" | "failed";
}

/** One "Needs a look before you publish" row from the import report. */
export interface ReportItem {
  kind: "alt_text" | "hidden_pages" | "broken_links" | "icons" | "missing_assets" | "lossy" | string;
  count: number;
  title?: string;
  body?: string;
  items?: Array<{ page_id?: string | null; path: string; line?: number | null; detail?: string | null }>;
}

export interface ImportReport {
  summary?: { pages?: number; groups?: number; images?: number; files?: number; redirects?: number; anchors?: number; gifs?: number; mb_before?: number; mb_after?: number };
  needs_look?: ReportItem[];
  /** The importer's full Markdown report (_IMPORT_REPORT.md). */
  markdown?: string;
  brand?: { name?: string; logo_url?: string | null; accent?: string | null; favicon_url?: string | null };
}

export interface Job {
  id: string;
  kind: "build" | "import";
  site_id: string;
  status: JobStatus;
  attempts?: number;
  progress?: { step: string | number; done: number; total: number; message?: string | null; steps?: JobStep[] } | null;
  result?: ({ report?: ImportReport; build_id?: string } & ImportReport) | null;
  error?: string | null;
  created_at: string;
  updated_at: string;
}

// ── Sites ────────────────────────────────────────────────────────────────────

export function listSites(workspaceId: string | null): Promise<{ sites: SiteSummary[]; usage?: Usage }> {
  return request(q({ workspace_id: workspaceId ?? undefined }) || "");
}

export interface CreateSiteInput {
  workspace_id: string | null;
  name: string;
  slug: string;
  source: SiteSource;
}

export function createSite(input: CreateSiteInput): Promise<Site> {
  return request("", { method: "POST", json: input });
}

export function getSite(id: string): Promise<Site> {
  return request(`/${enc(id)}`);
}

/** A partial `settings` (the API deep-merges and validates; arrays replace). */
export interface SettingsPatch {
  theme?: Partial<Omit<SiteTheme, "brand">> & { brand?: Partial<SiteBrand> };
  ai?: Partial<SiteSettings["ai"]>;
  access?: Partial<SiteSettings["access"]>;
  seo?: Partial<SiteSettings["seo"]>;
  review?: Partial<SiteSettings["review"]>;
  nav?: NavGroup[];
  redirects?: Redirect[];
}

export function updateSite(id: string, patch: { name?: string; slug?: string; settings?: SettingsPatch }): Promise<Site> {
  return request(`/${enc(id)}`, { method: "PATCH", json: patch });
}

export function deleteSite(id: string): Promise<void> {
  return request(`/${enc(id)}`, { method: "DELETE" });
}

export function unpublishSite(id: string): Promise<Site> {
  return request(`/${enc(id)}/unpublish`, { method: "POST" });
}

export function slugAvailable(slug: string): Promise<{ available: boolean; reason?: string | null; suggestion?: string | null }> {
  return request(`/slug-available${q({ slug })}`);
}

// ── Pages ────────────────────────────────────────────────────────────────────

export function listPages(siteId: string): Promise<PagesResponse> {
  return request(`/${enc(siteId)}/pages`);
}

export function createPage(siteId: string, input: { path: string; title: string; group?: string; after_page_id?: string }): Promise<Page> {
  return request(`/${enc(siteId)}/pages`, { method: "POST", json: input });
}

export function getPage(siteId: string, pageId: string): Promise<Page> {
  return request(`/${enc(siteId)}/pages/${enc(pageId)}`);
}

export interface SavePageInput {
  markdown: string;
  title: string;
  description: string;
  icon?: string | null;
  hidden?: boolean;
  path?: string;
  base_rev: number;
}

/** 409: `base_rev` is stale (someone saved a newer version). 423: someone else holds the lock. */
export function savePage(siteId: string, pageId: string, input: SavePageInput): Promise<Page> {
  return request(`/${enc(siteId)}/pages/${enc(pageId)}`, { method: "PUT", json: input });
}

export function deletePage(siteId: string, pageId: string): Promise<void> {
  return request(`/${enc(siteId)}/pages/${enc(pageId)}`, { method: "DELETE" });
}

/** Acquire or extend (heartbeat) the page lock. 423 when someone else holds it; admins may `takeover`. */
export function lockPage(siteId: string, pageId: string, takeover = false): Promise<{ lock: PageLock }> {
  return request(`/${enc(siteId)}/pages/${enc(pageId)}/lock${takeover ? "?takeover=1" : ""}`, { method: "POST" });
}

export function unlockPage(siteId: string, pageId: string, opts?: { keepalive?: boolean }): Promise<void> {
  return request(`/${enc(siteId)}/pages/${enc(pageId)}/lock`, { method: "DELETE", keepalive: opts?.keepalive });
}

export function listVersions(siteId: string, pageId: string): Promise<PageVersion[]> {
  return request<PageVersion[] | { versions: PageVersion[] }>(`/${enc(siteId)}/pages/${enc(pageId)}/versions`).then((r) =>
    Array.isArray(r) ? r : r.versions,
  );
}

export function restoreVersion(siteId: string, pageId: string, rev: number): Promise<Page> {
  return request(`/${enc(siteId)}/pages/${enc(pageId)}/versions/${rev}/restore`, { method: "POST" });
}

export function saveNav(siteId: string, nav: NavGroup[]): Promise<{ nav: NavGroup[] } | Site> {
  return request(`/${enc(siteId)}/nav`, { method: "PUT", json: { nav } });
}

// ── Publish, reviews, builds, jobs ───────────────────────────────────────────

export function getChanges(siteId: string): Promise<ChangesResponse> {
  return request(`/${enc(siteId)}/changes`);
}

/** 409 with "review required" when the site needs a review and you aren't an admin. */
export function publishSite(siteId: string, note?: string): Promise<Build> {
  return request(`/${enc(siteId)}/publish`, { method: "POST", json: { note: note || undefined } });
}

export function createReview(siteId: string, note: string): Promise<Review> {
  return request(`/${enc(siteId)}/reviews`, { method: "POST", json: { note } });
}

export function listReviews(siteId: string, status?: ReviewStatus): Promise<Review[]> {
  return request<Review[] | { reviews: Review[] }>(`/${enc(siteId)}/reviews${q({ status })}`).then((r) =>
    Array.isArray(r) ? r : r.reviews,
  );
}

/** Approve publishes: the response is the build it started (or the updated review). */
export function approveReview(siteId: string, reviewId: string): Promise<Build | Review> {
  return request(`/${enc(siteId)}/reviews/${enc(reviewId)}/approve`, { method: "POST" });
}

export function requestChanges(siteId: string, reviewId: string, comment: string): Promise<Review> {
  return request(`/${enc(siteId)}/reviews/${enc(reviewId)}/request-changes`, { method: "POST", json: { comment } });
}

export function withdrawReview(siteId: string, reviewId: string): Promise<Review> {
  return request(`/${enc(siteId)}/reviews/${enc(reviewId)}/withdraw`, { method: "POST" });
}

export function listBuilds(siteId: string): Promise<Build[]> {
  return request<Build[] | { builds: Build[] }>(`/${enc(siteId)}/builds`).then((r) => (Array.isArray(r) ? r : r.builds));
}

/** Admins: put an earlier build live again (no rebuild). */
export function restoreBuild(siteId: string, buildId: string): Promise<Build | Site> {
  return request(`/${enc(siteId)}/builds/${enc(buildId)}/restore`, { method: "POST" });
}

export function getJob(siteId: string, jobId: string): Promise<Job> {
  return request(`/${enc(siteId)}/jobs/${enc(jobId)}`);
}

// ── Assets ───────────────────────────────────────────────────────────────────

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

export async function uploadAsset(siteId: string, file: File): Promise<{ url: string }> {
  if (file.size > MAX_ASSET_BYTES) throw new DocsApiError("Files can be up to 25 MB.", 413);
  const form = new FormData();
  form.append("file", file);
  return request(`/${enc(siteId)}/assets`, { method: "POST", body: form });
}

// ── Helpers shared by the screens ────────────────────────────────────────────

export const DOCS_HOST_SUFFIX = ".docs.markdrop.in";
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/** "Acme Docs!" → "acme-docs" (3–40 chars of [a-z0-9-], no leading/trailing dash). */
export function slugFrom(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** Why a slug can't be used, or "" when its shape is fine (the API still checks availability). */
export function slugProblem(slug: string): string {
  if (!slug) return "Choose an address.";
  if (slug.length < 3) return "Use at least 3 characters.";
  if (slug.length > 40) return "Use at most 40 characters.";
  if (/[^a-z0-9-]/.test(slug)) return "Use lowercase letters, numbers and dashes.";
  if (slug.startsWith("-") || slug.endsWith("-")) return "Start and end with a letter or number.";
  return "";
}

export const siteHost = (s: Pick<SiteSummary, "slug" | "host">): string => s.host || `${s.slug}${DOCS_HOST_SUFFIX}`;

/** The address readers use: a live custom domain first, else the free one. */
export function primaryAddress(s: Pick<SiteSummary, "slug" | "host" | "domains">): string {
  const own = s.domains?.find((d) => d.status === "live" || d.status === "verified");
  return own?.host ?? siteHost(s);
}

export const isAdminRole = (r: DocsRole | undefined | null): boolean => r === "owner" || r === "admin";
export const canEditRole = (r: DocsRole | undefined | null): boolean => isAdminRole(r) || r === "editor";

export const PRESETS: Array<{ id: ThemePreset; name: string; blurb: string }> = [
  { id: "clean", name: "Clean", blurb: "Sidebar docs. Calm and familiar." },
  { id: "editorial", name: "Editorial", blurb: "Serif headings, centred reading." },
  { id: "technical", name: "Technical", blurb: "Dense, mono accents, API-first." },
  { id: "minimal", name: "Minimal", blurb: "No sidebar chrome, lots of air." },
  { id: "playful", name: "Playful", blurb: "Round, bold and friendly." },
  { id: "helpcenter", name: "Help center", blurb: "Search first, then categories." },
];

export const presetName = (p: ThemePreset | undefined | null): string => PRESETS.find((x) => x.id === p)?.name ?? "Clean";

/** Fonts the engine allows (ids → labels). "theme" = the preset's own. */
export const FONTS: Array<{ id: string; label: string; family: string }> = [
  { id: "manrope", label: "Manrope", family: "Manrope, sans-serif" },
  { id: "inter", label: "Inter", family: "Inter, sans-serif" },
  { id: "newsreader", label: "Newsreader", family: "Newsreader, Georgia, serif" },
  { id: "source-sans-3", label: "Source Sans 3", family: '"Source Sans 3", sans-serif' },
  { id: "ibm-plex-sans", label: "IBM Plex Sans", family: '"IBM Plex Sans", sans-serif' },
  { id: "dm-sans", label: "DM Sans", family: '"DM Sans", sans-serif' },
  { id: "nunito", label: "Nunito", family: "Nunito, sans-serif" },
  { id: "geist", label: "Geist", family: "Geist, sans-serif" },
];

export const CUSTOM_CSS_MAX = 20 * 1024;

/** The same rules the API enforces, so the panel can say what's wrong before saving. */
export function customCssProblem(css: string): string {
  if (new Blob([css]).size > CUSTOM_CSS_MAX) return "Custom CSS can be up to 20 KB.";
  if (/@import\s+(url\()?\s*["']?\s*(https?:)?\/\//i.test(css)) return "Remote @import isn't allowed. Paste the rules instead.";
  if (/url\(\s*["']?\s*(?!https:|data:|#|\/(?!\/))[a-z]+:/i.test(css) || /url\(\s*["']?\s*http:/i.test(css)) return "url() must point at an https:// address.";
  if (/expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(css)) return "Scripts and expressions aren't allowed.";
  if (/<\/?\s*(script|style)/i.test(css)) return "Only CSS rules go here, no HTML tags.";
  return "";
}
