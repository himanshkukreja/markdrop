/**
 * Docs sites API (Markdrop Docs, Phase 1): a typed client for every `/api/v1/docs-sites` endpoint
 * (backend/app/routers/docs_sites.py + docs_site_pages.py).
 *
 * Kept out of lib/api.ts for the same reason lib/workspaces.ts is: nothing here is reachable without
 * a session, and lib/api.ts loads on every public document page.
 *
 * Errors keep their HTTP status and the parsed body, because the editor acts on three of them:
 * 409 on a page save (`base_rev` is stale: the body says the current `rev` and who saved it), 423
 * (someone else holds the page lock: the body carries `lock`) and 409 "review required" on publish.
 *
 * A change the API accepts reports its product event here (lib/guidesEvents: enums and counts,
 * never content), so every screen that makes it is counted the same way.
 */
import { API_BASE } from "@/lib/api";
import { after, guideEvents } from "@/lib/guidesEvents";
import { sanitizeCss } from "@/docs/theme.mjs";
import type { CustomThemeSettings } from "@/lib/guideThemes";

const TOKEN_KEY = "markdrop_token";
const BASE = "/api/v1/docs-sites";

function authHeaders(): Record<string, string> {
  const t = typeof window === "undefined" ? null : localStorage.getItem(TOKEN_KEY);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** A refused docs-sites call: the status, the server's message and the rest of its body. */
export class DocsApiError extends Error {
  status: number;
  /** The parsed JSON body, or null. */
  body: unknown;
  /** The body's fields beside `detail` (409 on save: `rev`, `updated_by_name`, `updated_at`; 423: `lock`). */
  info: Record<string, unknown>;
  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.name = "DocsApiError";
    this.status = status;
    this.body = body;
    const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const d = b.detail && typeof b.detail === "object" && !Array.isArray(b.detail) ? (b.detail as Record<string, unknown>) : {};
    this.info = { ...b, ...d };
  }
}

export const docsErrorStatus = (e: unknown): number => (e instanceof DocsApiError ? e.status : 0);
export const docsErrorMessage = (e: unknown, fallback = "That didn't work. Try again."): string =>
  e instanceof Error && e.message ? e.message : fallback;

function messageOf(body: unknown, status: number): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (status === 409 && detail === "review required") return "This site needs a review before it's published.";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return (detail[0] as { msg?: string } | undefined)?.msg || "That value isn't valid.";
  if (detail && typeof detail === "object") {
    const m = (detail as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  if (status === 423) return "Someone else is editing this page.";
  if (status === 409) return "Someone saved a newer version.";
  if (status === 413) return "That file is too big. Files can be up to 25 MB.";
  if (status === 415) return "That kind of file can't be uploaded here.";
  if (status === 429) return "That's the limit for now. Try again later.";
  if (status === 503) return "Uploads aren't available right now.";
  return `Request failed (${status})`;
}

async function request<T>(path: string, init?: RequestInit & { json?: unknown }, base: string = BASE): Promise<T> {
  const { json, ...rest } = init ?? {};
  const isForm = typeof FormData !== "undefined" && rest.body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${base}${path}`, {
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

/**
 * The reads a studio screen opens with (the guide, its page list, a page) try again after these
 * pauses when the answer was worth another try: status 0 (no readable answer: offline, or the
 * proxy in front of the API refused the request while busy; its 429 carries no CORS headers, so
 * the browser reports a network error), 429 and 502–504. A page full of imported images can send
 * a burst of requests at once; the pauses are long enough for it to drain. Other answers are final.
 */
export const RETRY_MS = [1500, 4000];
export const retryable = (status: number): boolean => status === 0 || status === 429 || (status >= 502 && status <= 504);

async function requestRetrying<T>(path: string): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await request<T>(path);
    } catch (e) {
      if (i >= RETRY_MS.length || !(e instanceof DocsApiError) || !retryable(e.status)) throw e;
      await new Promise((r) => setTimeout(r, RETRY_MS[i]));
    }
  }
}

/** The same request, for a feature's own module (lib/docsApiReference.ts). */
export const docsRequest = request;

const q = (params: Record<string, string | number | boolean | null | undefined>): string => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
};
const enc = encodeURIComponent;

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Your Guides role on a site (the API's `your_role`): its own roles, not the workspace's. The
 * workspace owner and admins are always "admin"; everyone else has what a studio admin gave them,
 * per workspace or per site. A personal site's owner is "admin". ("owner" is the old name, kept
 * so an older API's answer still reads as admin.)
 */
export type DocsRole = "owner" | "admin" | "reviewer" | "editor" | "viewer";
/** A role you can give in Markdrop Guides; "none" = no access (the sites are invisible). */
export type StudioRole = "admin" | "reviewer" | "editor" | "viewer" | "none";
/**
 * Where a role comes from: workspace_owner / workspace_admin (always admin, can't be changed),
 * workspace (their studio role in the workspace), site (this site's override), personal, none.
 */
export type RoleSource = "workspace_owner" | "workspace_admin" | "workspace" | "site" | "personal" | "none";
export type SiteStatus = "draft" | "live" | "unpublished";
export type SourceKind = "blank" | "template" | "gitbook" | "github";
export type ThemePreset =
  | "clean" | "editorial" | "technical" | "minimal" | "playful" | "helpcenter"
  | "midnight" | "paper" | "terminal" | "corporate" | "studio" | "academic" | "atlas" | "pastel";
export type ThemeMode = "both" | "light" | "dark";
export type Corners = "sharp" | "soft" | "round";
export type AccessLevel = "public" | "password" | "members";
export type TemplateId = "product" | "api" | "helpcenter";

export interface SiteSource {
  kind: SourceKind;
  url?: string | null;
  template?: TemplateId | string | null;
  repo?: { owner: string; name: string; branch: string; path: string } | null;
}

export interface SiteBrand {
  enabled: boolean;
  /** An https:// address or an uploaded file (`/docs-assets/<sha256>.<ext>`). */
  logo_url?: string | null;
  logo_dark_url?: string | null;
  colors: string[];
  accent?: string | null;
  accent_dark?: string | null;
}

export interface SiteTheme {
  preset: ThemePreset;
  brand: SiteBrand;
  /** Font ids (FONTS); null = the preset's own. mono: a code face (kind "mono"). */
  fonts: { heading?: string | null; body?: string | null; mono?: string | null };
  mode: ThemeMode;
  corners?: Corners | null;
  /** ≤ 20 KB; no remote @import, no non-https url(), no expressions (validated by the API). */
  custom_css?: string | null;
  /** A custom theme (the theme builder, lib/guideThemes.ts); null = the preset as designed. */
  custom?: CustomThemeSettings | null;
}

export interface NavGroup {
  group: string;
  pages: string[];
}

export interface Redirect {
  from: string;
  to: string;
  /** Why it's there: a page moved (added for you) or someone added it in Settings. Kept by the API on save. */
  why?: "moved" | "added";
}

export interface SiteSettings {
  theme: SiteTheme;
  ai: { enabled: boolean; name?: string | null; suggestions?: string[] };
  /** `password` is write-only (6–200 chars); the API only says `has_password`. */
  access: { level: AccessLevel; has_password?: boolean };
  seo: { index: boolean };
  review: { required: boolean };
  /** Reader insights (page views, searches, feedback): on unless an admin turned them off. */
  insights?: { enabled: boolean };
  nav: NavGroup[];
  /** The API reference's options (lib/docsApiReference.ts). Absent on an older API. */
  api?: ApiReferenceSettings;
  /** Old addresses → their new pages (the build writes redirects.json). Checked on save: targets
   * exist, no page is hidden by one, no chains. A GitBook import's own redirects stay in the build. */
  redirects?: Redirect[];
}

export interface ApiReferenceSettings {
  /** The description version a publish builds (set by upload / fetch / restore, never PATCH). */
  spec_id: string | null;
  label: string;
  placement: "tab" | "sidebar";
  try_it: boolean;
  refetch: boolean;
}

/** A DNS record the customer adds for their own domain (CNAME: always; TXT: Cloudflare's alternatives). */
export interface DomainRecord {
  type: "CNAME" | "TXT" | string;
  name: string;
  value: string;
  /** route: the CNAME that sends readers here; ownership / certificate: TXT records Cloudflare can
   * check instead of the CNAME (only needed when it can't see it, e.g. behind another proxy). */
  purpose: "route" | "ownership" | "certificate" | string;
  optional: boolean;
}

/** One of the guide's own domains (backend services/docs_custom_domains.py). */
export interface SiteDomain {
  host: string;
  /** pending: waiting for DNS / the certificate; live: readers get the guide there; failed: gave up
   * (see message); removing: being taken off. */
  status: "pending" | "live" | "failed" | "removing" | "verified" | string;
  /** While pending: dns (Cloudflare doesn't see the CNAME yet) or certificate (issuing it). */
  stage?: "dns" | "certificate" | null;
  /** Cloudflare's words (or ours) about what's in the way. */
  message?: string | null;
  /** Guides admins only. */
  records?: DomainRecord[];
  added_at?: string | null;
  live_at?: string | null;
  checked_at?: string | null;
  next_check_at?: string | null;
}

/** Whether this server offers own domains, the CNAME target, and how many a guide may have. */
export interface OwnDomains {
  available: boolean;
  target: string;
  max: number;
}

export type BuildStatus = "queued" | "building" | "publishing" | "live" | "failed" | "superseded";

export interface Build {
  id: string;
  site_id: string;
  number: number;
  status: BuildStatus;
  requested_by: string;
  requested_by_name?: string | null;
  review_id?: string | null;
  note?: string | null;
  snapshot_id?: string | null;
  job_id?: string | null;
  manifest_hash?: string | null;
  stats?: { pages: number; objects: number; uploaded: number; bytes: number; ms: number } | null;
  error?: string | null;
  /** What went ahead differently than asked (an API reference that couldn't be re-fetched). */
  warnings?: string[];
  /** On GET /builds: this is the build readers see now. */
  live?: boolean;
  /** On GET /builds: what it changed against the publish before it that went live. */
  changes?: ChangeSummary | null;
  /** On GET /builds and /publish-status, while it runs. */
  progress?: PublishProgress | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
}

/** Pages added / edited / removed and the published settings that changed ("theme" is the design). */
export interface ChangeSummary {
  added: number;
  edited: number;
  removed: number;
  design: boolean;
  redirects: boolean;
  /** The API reference. */
  api: boolean;
  /** Changelog entries added, edited or removed (older APIs leave it out). */
  changelog?: number;
  /** "theme" | "nav" | "redirects" | "ai" | "seo" | "api" | "changelog" | "name" | "address" */
  settings: string[];
}

/** A changelog entry added, edited or removed (GET /changes uses modified/deleted, /compare edited/removed). */
export interface ChangelogChange {
  id: string;
  slug: string;
  title: string;
  date: string;
  change: "added" | "modified" | "deleted" | "edited" | "removed";
  updated_by?: string | null;
  updated_by_name?: string | null;
  updated_at?: string | null;
}

/** A running publish (backend docs_site_compare.progress_view). */
export interface PublishProgress {
  stage: "waiting" | "pages" | "extras" | "live";
  percent: number;
  step?: string | null;
  pages_done: number;
  pages_total: number;
  eta_seconds: number;
  elapsed_seconds: number;
}

/** GET /docs-sites/<site>/publish-status: the site bar's state on every studio screen. */
export interface PublishStatus {
  count: number;
  ever_published: boolean;
  summary: ChangeSummary;
  status: SiteStatus;
  running: Build | null;
  running_count: number;
  live: Build | null;
  latest: Build | null;
}

/** One side of a comparison: a publish, the drafts, or nothing (no publish is live). */
export interface CompareSide {
  ref: string;
  kind: "publish" | "drafts" | "none";
  number?: number;
  status?: BuildStatus;
  live?: boolean;
  note?: string | null;
  requested_by_name?: string | null;
  at?: string | null;
}

export interface ComparePage {
  id: string;
  path: string;
  title: string;
  change: "added" | "edited" | "removed";
  added_lines: number;
  removed_lines: number;
  moved_from?: string | null;
  /** Edited: the page fields that changed besides its Markdown. */
  fields?: string[];
}

export interface DiffRow {
  op: "same" | "add" | "del" | "gap";
  /** A gap's text: how many unchanged lines it skips. */
  text: string;
  a: number | null;
  b: number | null;
}

/** GET /docs-sites/<site>/compare */
export interface CompareResponse {
  from: CompareSide;
  to: CompareSide;
  pages: ComparePage[];
  /** Changelog entries (older APIs leave it out). */
  changelog?: ChangelogChange[];
  summary: ChangeSummary;
  page: (ComparePage & { rows: DiffRow[]; truncated: boolean }) | null;
}

/** GET /docs-sites/<site>/setup: the "Finish setting up" checklist's facts. */
export interface SetupStatus {
  pages: number;
  look_chosen: boolean;
  published: boolean;
  live_since: string | null;
  own_domain: boolean;
  own_domain_live: boolean;
  /** People with a Guides role on it; null for a personal guide. */
  team: number | null;
  insights_data: boolean;
  /** Changelog entries written (older APIs leave it out). */
  changelog_entries?: number;
}

export interface Usage {
  sites: number;
  limit: number;
  /** Ask AI answers this month across the scope's sites, and the per-site monthly allowance. */
  ai_used: number;
  ai_limit: number;
}

export interface Limits {
  sites: number;
  pages: number;
  builds_per_day: number;
  asset_bytes: number;
  storage_bytes: number;
  ai_answers_per_month: number;
}

export interface SiteSummary {
  id: string;
  workspace_id: string | null;
  name: string;
  slug: string;
  /** `https://<slug>.guides.markdrop.in` */
  url: string | null;
  status: SiteStatus;
  /** An open review is waiting. */
  in_review: boolean;
  review_requested_by_name?: string | null;
  preset: ThemePreset;
  source_kind?: SourceKind | null;
  page_count: number;
  /** Ask AI answers this month. */
  ai_used: number;
  last_published_at: string | null;
  last_published_by: string | null;
  last_published_by_name?: string | null;
  updated_at: string;
  created_at: string;
  your_role: DocsRole;
  /** Where `your_role` comes from (absent from an older API). */
  your_role_source?: RoleSource | null;
  /** The full Site: every own domain. A listing: the live ones (host and status). */
  domains?: SiteDomain[];
  /** GET /docs-sites?scope=all: the site's workspace (null: a personal site). */
  workspace?: StudioWorkspaceRef | null;
  /** What the home's card draws its preview with (absent from an older API). */
  theme?: SummaryTheme;
  /** The newest build's status: building / failed show on the card (null: never published). */
  build_status?: BuildStatus | null;
  /** Pages in the open review. */
  review_pages?: number;
  /** The newest page save. */
  last_edited_at?: string | null;
  /** settings.insights.enabled */
  insights_enabled?: boolean;
}

/** A listing's theme: enough to draw the guide's card in its own look. */
export interface SummaryTheme {
  preset: ThemePreset;
  mode: ThemeMode;
  corners?: Corners | null;
  brand: Pick<SiteBrand, "enabled" | "accent" | "accent_dark" | "colors" | "logo_url" | "logo_dark_url">;
  /** The chosen faces (null: the preset's). */
  fonts?: SiteTheme["fonts"];
  /** A custom theme (the theme builder): the card draws its colours, corners and type. */
  custom?: SiteTheme["custom"];
}

/** GET /docs-sites/insights-summary: the Guides home's last 7 days. Totals are null when nothing
 * could be counted (no published guide has Insights on): show "—", never 0. */
export interface HomeInsights {
  range: "7d";
  /** The 7 UTC days, oldest first. */
  days: string[];
  guides: number;
  live: number;
  /** Published guides with Insights on (what the totals add up). */
  counted: number;
  insights_off: number;
  totals: {
    readers: number | null;
    readers_previous: number | null;
    /** % against the 7 days before; null when that week had no readers. */
    readers_change: number | null;
    views: number | null;
    ask_answered: number | null;
    ask_unanswered: number | null;
    helpful_pct: number | null;
    votes: number | null;
  };
  /** By site id. `enabled: false`: Insights is off for it, no numbers. */
  sites: Record<string, HomeSiteInsights>;
}

export type HomeSiteInsights =
  | { enabled: false }
  | {
      enabled: true;
      views: number[];
      views_total: number;
      readers: number;
      readers_previous: number;
      helpful_pct: number | null;
      votes: number;
      ask_answered: number;
      ask_unanswered: number;
      /** The Fix list's open items (high impact among them). */
      fixes?: { open: number; high: number };
    };

/** A workspace as Markdrop Guides shows it beside its sites. */
export interface StudioWorkspaceRef {
  id: string;
  name: string;
  accent?: string | null;
  logo_url?: string | null;
}

export interface StudioWorkspace extends StudioWorkspaceRef {
  /** The workspace role (owner/admin/member/viewer); Markdrop Guides' own role is `your_role`. */
  workspace_role: string;
  /** Your Guides role across the workspace; "none" until a studio admin gives you one. */
  your_role: DocsRole | "none";
  your_role_source?: RoleSource | null;
  /** Studio admins, while the workspace isn't being deleted. */
  can_create: boolean;
  /** Studio admins: Guides › Members for this workspace. */
  can_manage_people?: boolean;
  usage: { sites: number; limit: number };
}

/** GET /docs-sites?scope=all (Markdrop Guides' home and site switcher). */
export interface AllSitesResponse {
  sites: SiteSummary[];
  workspaces: StudioWorkspace[];
  personal: { your_role: DocsRole; can_create: boolean; usage: { sites: number; limit: number } };
  usage: Usage;
}

export interface Job {
  id: string;
  kind: "build" | "import" | "restore" | "unpublish" | "delete" | string;
  site_id: string;
  status: JobStatus;
  attempts?: number;
  payload?: Record<string, unknown>;
  progress?: { step: string | number; done: number; total: number; message?: string | null; steps?: JobStep[] } | null;
  /** Import: WorkerImportResult. Build: what the worker recorded (build_id…). */
  result?: (WorkerImportResult & { build_id?: string }) | ImportReport | null;
  error?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Site extends SiteSummary {
  owner_id: string;
  source: SiteSource;
  settings: SiteSettings;
  domains: SiteDomain[];
  own_domains?: OwnDomains;
  live_build_id: string | null;
  /** The GitBook import that filled this site (its screen can be reopened while the job is kept). */
  last_import_job_id?: string | null;
  live_build: Build | null;
  latest_build: Build | null;
  open_review_id: string | null;
  counts: { pages: number; hidden_pages: number; open_reviews: number; builds_today: number; storage_bytes: number; ai_answers_this_month: number };
  limits: Limits;
  /** False while the docs edge doesn't hold the site's current access setting yet (the server keeps retrying). */
  access_enforced?: boolean;
  /** False while this server doesn't take password or members-only guides yet (they show "Coming soon"). */
  private_access?: boolean;
  /** False while the site's free address isn't attached on Cloudflare yet (its certificate is on its way). */
  address_ready?: boolean;
  /** POST /docs-sites (GitBook import, template seed) and POST …/unpublish: the job it started. */
  job?: Job | null;
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
  /** Differs from what's live (or was never published). */
  has_changes: boolean;
  /** In the live guide (false: new, never published). Older APIs leave it out. */
  published?: boolean;
  lock: PageLock | null;
  rev: number;
  updated_at: string;
  updated_by: string;
}

export interface PagesResponse {
  nav: NavGroup[];
  pages: PageSummary[];
}

export interface Page extends PageSummary {
  site_id: string;
  description: string;
  markdown: string;
  frontmatter_extra?: Record<string, unknown> | null;
  updated_by_name?: string | null;
  created_at: string;
}

export interface PageVersion {
  rev: number;
  title: string;
  description: string;
  by: string;
  by_name?: string | null;
  at: string;
  kind: "save" | "import" | "restore" | string;
  chars?: number;
  /** Only from GET …/versions/<rev>. */
  markdown?: string;
}

/** 409 on a page save: what's there now. */
export interface SaveConflict {
  rev: number;
  updated_by?: string | null;
  updated_by_name?: string | null;
  updated_at?: string | null;
}

export interface PageChange {
  id: string;
  path: string;
  title: string;
  change: "added" | "modified" | "deleted";
  lines_changed?: number | null;
  moved_from?: string | null;
  updated_by?: string | null;
  updated_by_name?: string | null;
  updated_at?: string | null;
}

export interface ChangesResponse {
  live_build: Build | null;
  last_published_at: string | null;
  pages: PageChange[];
  /** Changelog entries added, modified or deleted since the live publish (older APIs leave it out). */
  changelog?: ChangelogChange[];
  /** "theme" | "ai" | "access" | "seo" | "nav" | "changelog" | "name" | "address" */
  settings_changed: string[];
  count: number;
  ever_published: boolean;
}

export type ReviewStatus = "open" | "approved" | "changes_requested" | "withdrawn";

export interface Review {
  id: string;
  site_id: string;
  requested_by: string;
  requested_by_name?: string | null;
  note: string | null;
  page_ids: string[];
  status: ReviewStatus;
  decided_by?: string | null;
  decided_by_name?: string | null;
  decided_at?: string | null;
  comment?: string | null;
  build_id?: string | null;
  created_at: string;
  /** Who will be asked, if the API ever says. */
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
  /** What the import couldn't take (a page over the limit, an unusable path…). */
  skipped?: string[];
  /** The importer's full Markdown report (_IMPORT_REPORT.md). */
  markdown?: string;
  brand?: ImportedBrand;
}

/** What of the old site's brand an import brought across (scripts/docs-import `_import-report.json` brand). */
export interface ImportedBrand {
  name?: string;
  logo?: boolean;
  logoDark?: boolean;
  favicon?: boolean;
  /** Why the logo or favicon didn't come across ("download failed (HTTP 404)"…). */
  logoReason?: string | null;
  faviconReason?: string | null;
  accent?: string | null;
  /** Older reports. */
  logo_url?: string | null;
  favicon_url?: string | null;
}

/**
 * An import job's `result` as the worker stores it (backend/app/services/docs_import_job.py). The
 * report's lists are the importer's (scripts/docs-import/gitbook.mjs `_import-report.json`), capped
 * at 200 each; `truncated` gives the full length of a capped list.
 */
export interface WorkerImportResult {
  ok?: boolean;
  pages?: { created: number; updated: number; total: number; hidden: number };
  nav_groups?: number;
  assets?: { files?: number; bytes?: number; uploaded?: number; rows?: number };
  report?: {
    source?: string;
    counts?: Record<string, number | boolean>;
    items?: Partial<Record<"altGenerated" | "hidden" | "brokenLinks" | "missing" | "keptOriginal" | "unmatchedIcons" | "notes" | "external", Array<Record<string, unknown>>>>;
    truncated?: Record<string, number>;
    brand?: ImportedBrand;
  };
  skipped?: string[];
}

export interface UploadedAsset {
  /** `/docs-assets/<sha256>.<ext>`: what goes in the Markdown and settings. */
  url: string;
  name: string;
  size: number;
  content_type: string;
  sha256: string;
}

// ── Sites ────────────────────────────────────────────────────────────────────

/** Every site you can open, across your workspaces and your personal ones (Markdrop Guides). */
export function listAllSites(): Promise<AllSitesResponse> {
  return request(q({ scope: "all" }));
}

/** The home's numbers: the last 7 days across every guide you can open, and per guide. */
export function getHomeInsights(): Promise<HomeInsights> {
  return request("/insights-summary");
}

/** A workspace's sites, or with `null` your personal ones. */
export function listSites(workspaceId: string | null): Promise<{ sites: SiteSummary[]; your_role: DocsRole; usage: Usage }> {
  return request(q({ workspace_id: workspaceId ?? undefined }));
}

export interface CreateSiteInput {
  workspace_id: string | null;
  name: string;
  slug: string;
  source: SiteSource;
}

/** Workspace admins and owners only (editors get 403). GitBook/template sources start a job (`site.job`). */
export function createSite(input: CreateSiteInput): Promise<Site> {
  return request<Site>("", { method: "POST", json: input }).then(after(() => guideEvents.created(input)));
}

export function getSite(id: string): Promise<Site> {
  return requestRetrying(`/${enc(id)}`);
}

/** A partial `settings` (the API deep-merges, then validates the whole; arrays replace). Nav: use saveNav. */
export interface SettingsPatch {
  theme?: Partial<Omit<SiteTheme, "brand">> & { brand?: Partial<SiteBrand> };
  ai?: Partial<SiteSettings["ai"]>;
  access?: { level?: AccessLevel; password?: string };
  seo?: Partial<SiteSettings["seo"]>;
  review?: Partial<SiteSettings["review"]>;
  insights?: { enabled?: boolean };
  /** The options only: the description itself changes through lib/docsApiReference.ts. */
  api?: Partial<Omit<ApiReferenceSettings, "spec_id">>;
  /** Replaces the whole list. */
  redirects?: Redirect[];
}

export function updateSite(id: string, patch: { name?: string; slug?: string; settings?: SettingsPatch }): Promise<Site> {
  return request<Site>(`/${enc(id)}`, { method: "PATCH", json: patch }).then(after(() => guideEvents.siteUpdated(patch)));
}

/** Reset design: the design a guide started with (after its import, or when it was created). */
export interface DesignBaseline {
  source: "import" | "created";
  /** recorded (stored when it happened), unchanged (an older guide's never-saved design), rebuilt (exact),
   *  reconstructed (an older import rebuilt from its record), default (nothing to rebuild from). */
  how: "recorded" | "unchanged" | "rebuilt" | "reconstructed" | "default";
  /** Said in the reset dialog when the baseline isn't exactly known. */
  note: string | null;
  recorded_at: string | null;
  theme: SiteTheme;
  /** What a reset would change, in the Design screen's order. */
  changes: Array<{ field: string; label: string }>;
  same: boolean;
}

/** Admins: what Reset design goes back to, and what it would change. */
export function getDesignBaseline(siteId: string): Promise<DesignBaseline> {
  return request<DesignBaseline>(`/${enc(siteId)}/design/baseline`);
}

/** Admins: the design back to its baseline, saved like "Save design" (nothing is published). */
export function resetDesign(siteId: string): Promise<Site & { design: DesignBaseline }> {
  return request<Site & { design: DesignBaseline }>(`/${enc(siteId)}/design/reset`, { method: "POST" })
    .then(after((r) => guideEvents.designReset(r.design.source)));
}

/** Admins: soft delete (a job takes the published files down). */
export function deleteSite(id: string): Promise<{ deleted: true; job: Job | null }> {
  return request<{ deleted: true; job: Job | null }>(`/${enc(id)}`, { method: "DELETE" }).then(after(guideEvents.deleted));
}

export function unpublishSite(id: string): Promise<Site> {
  return request<Site>(`/${enc(id)}/unpublish`, { method: "POST" }).then(after(guideEvents.unpublished));
}

/** Admins: add an own domain (help.acme.com). The answer is the site, with the domain pending. */
export function addSiteDomain(id: string, host: string): Promise<Site> {
  return request<Site>(`/${enc(id)}/domains`, { method: "POST", json: { host } }).then(after(guideEvents.domainAdded));
}

/** Admins: ask Cloudflare about the domain now (a failed one starts over). */
export function checkSiteDomain(id: string, host: string): Promise<Site> {
  return request<Site>(`/${enc(id)}/domains/${enc(host)}/check`, { method: "POST" });
}

/** Admins: take the domain off the guide (the free address keeps working). */
export function removeSiteDomain(id: string, host: string): Promise<Site> {
  return request<Site>(`/${enc(id)}/domains/${enc(host)}`, { method: "DELETE" }).then(after(guideEvents.domainRemoved));
}

export interface SlugStatus {
  slug: string;
  available: boolean;
  reason: "invalid" | "reserved" | "taken" | null;
  message: string | null;
  url?: string;
}

/** `siteId`: changing an existing site's address (its own slug counts as free). */
export function slugAvailable(slug: string, siteId?: string): Promise<SlugStatus> {
  return request(`/slug-available${q({ slug, site_id: siteId })}`);
}

// ── Pages ────────────────────────────────────────────────────────────────────

export function listPages(siteId: string): Promise<PagesResponse> {
  return requestRetrying(`/${enc(siteId)}/pages`);
}

export function createPage(siteId: string, input: { path: string; title: string; group?: string; after_page_id?: string; markdown?: string; description?: string; icon?: string | null }): Promise<Page> {
  return request<Page>(`/${enc(siteId)}/pages`, { method: "POST", json: input }).then(after(guideEvents.pageCreated));
}

export function getPage(siteId: string, pageId: string): Promise<Page> {
  return requestRetrying(`/${enc(siteId)}/pages/${enc(pageId)}`);
}

export interface SavePageInput {
  base_rev: number;
  markdown?: string;
  title?: string;
  description?: string;
  icon?: string | null;
  hidden?: boolean;
  path?: string;
  frontmatter_extra?: Record<string, unknown>;
}

/** 409: `base_rev` is stale (`info` holds SaveConflict). 423: someone else holds the lock (`info.lock`). */
export function savePage(siteId: string, pageId: string, input: SavePageInput): Promise<Page> {
  return request(`/${enc(siteId)}/pages/${enc(pageId)}`, { method: "PUT", json: input });
}

/** "/" (the home page) can't be deleted. */
export function deletePage(siteId: string, pageId: string): Promise<{ deleted: true }> {
  return request<{ deleted: true }>(`/${enc(siteId)}/pages/${enc(pageId)}`, { method: "DELETE" }).then(after(guideEvents.pageDeleted));
}

/** Acquire or renew (heartbeat every 30 s; a lock lapses 2 min after the last). 423 when someone else holds it; admins may `takeover`. */
export function lockPage(siteId: string, pageId: string, takeover = false): Promise<{ lock: PageLock | null }> {
  return request(`/${enc(siteId)}/pages/${enc(pageId)}/lock${takeover ? "?takeover=true" : ""}`, { method: "POST" });
}

export function unlockPage(siteId: string, pageId: string, opts?: { keepalive?: boolean }): Promise<{ lock: null }> {
  return request(`/${enc(siteId)}/pages/${enc(pageId)}/lock`, { method: "DELETE", keepalive: opts?.keepalive });
}

/** Newest first, without the Markdown (getVersion has it). */
export function listVersions(siteId: string, pageId: string): Promise<PageVersion[]> {
  return request(`/${enc(siteId)}/pages/${enc(pageId)}/versions`);
}

export function getVersion(siteId: string, pageId: string, rev: number): Promise<PageVersion> {
  return request(`/${enc(siteId)}/pages/${enc(pageId)}/versions/${rev}`);
}

/** The version becomes the newest draft (a new rev). */
export function restoreVersion(siteId: string, pageId: string, rev: number): Promise<Page> {
  return request<Page>(`/${enc(siteId)}/pages/${enc(pageId)}/versions/${rev}/restore`, { method: "POST" }).then(after(guideEvents.pageRestored));
}

export function saveNav(siteId: string, nav: NavGroup[]): Promise<{ nav: NavGroup[] }> {
  return request(`/${enc(siteId)}/nav`, { method: "PUT", json: { nav } });
}

// ── Publish, reviews, builds, jobs ───────────────────────────────────────────

export function getChanges(siteId: string): Promise<ChangesResponse> {
  return request(`/${enc(siteId)}/changes`);
}

/** Changes waiting, the running publish (with progress) and the live one: the site bar polls it. */
export function getPublishStatus(siteId: string): Promise<PublishStatus> {
  return request(`/${enc(siteId)}/publish-status`);
}

/** `from`: a publish id or "live"; `to`: a publish id, "live" or "drafts". `page`: whose line diff. */
export function comparePublishes(siteId: string, from: string, to: string, page?: string | null): Promise<CompareResponse> {
  return request(`/${enc(siteId)}/compare${q({ from, to, page })}`);
}

export function getSetup(siteId: string): Promise<SetupStatus> {
  return request(`/${enc(siteId)}/setup`);
}

/** Every address readers can use: live own domains first, then the free one. */
export function liveAddresses(s: Pick<SiteSummary, "slug" | "url" | "domains">): Array<{ host: string; own: boolean }> {
  const own = (s.domains ?? []).filter((d) => d.status === "live" || d.status === "verified").map((d) => ({ host: d.host, own: true }));
  return [...own, { host: siteHost(s), own: false }];
}

/** 202: the queued build and its job. 409 "review required" for editors when the site needs a review; 429 at the daily cap. */
export function publishSite(siteId: string, note?: string): Promise<Build & { job: Job | null }> {
  return request<Build & { job: Job | null }>(`/${enc(siteId)}/publish`, { method: "POST", json: { note: note || undefined } })
    .then(after(() => guideEvents.publishRequested(!!note)));
}

export function createReview(siteId: string, note: string): Promise<Review> {
  return request<Review>(`/${enc(siteId)}/reviews`, { method: "POST", json: { note: note || undefined } }).then(after(guideEvents.reviewSubmitted));
}

export function listReviews(siteId: string, status?: ReviewStatus): Promise<Review[]> {
  return request(`/${enc(siteId)}/reviews${q({ status })}`);
}

/** Admins: approve publishes (202 with the review and the build it queued). */
export function approveReview(siteId: string, reviewId: string, comment?: string): Promise<{ review: Review; build: Build & { job?: Job | null } }> {
  return request<{ review: Review; build: Build & { job?: Job | null } }>(`/${enc(siteId)}/reviews/${enc(reviewId)}/approve`, { method: "POST", json: { comment: comment || undefined } })
    .then(after(guideEvents.reviewApproved));
}

export function requestChanges(siteId: string, reviewId: string, comment: string): Promise<Review> {
  return request<Review>(`/${enc(siteId)}/reviews/${enc(reviewId)}/request-changes`, { method: "POST", json: { comment } }).then(after(guideEvents.changesRequested));
}

export function withdrawReview(siteId: string, reviewId: string): Promise<Review> {
  return request<Review>(`/${enc(siteId)}/reviews/${enc(reviewId)}/withdraw`, { method: "POST" }).then(after(guideEvents.reviewWithdrawn));
}

/** Newest first; `live` marks the one readers see. */
export function listBuilds(siteId: string, limit?: number): Promise<Build[]> {
  return request(`/${enc(siteId)}/builds${q({ limit })}`);
}

/** Admins: put an earlier build live again (no rebuild; a job re-points the site). */
export function restoreBuild(siteId: string, buildId: string): Promise<{ build: Build; job: Job | null }> {
  return request<{ build: Build; job: Job | null }>(`/${enc(siteId)}/builds/${enc(buildId)}/restore`, { method: "POST" }).then(after(guideEvents.restored));
}

export function getJob(siteId: string, jobId: string): Promise<Job> {
  return request(`/${enc(siteId)}/jobs/${enc(jobId)}`);
}

// ── Assets ───────────────────────────────────────────────────────────────────

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

/**
 * `{variant: "dark", for: "/docs-assets/<image>"}`: the dark-theme version of an image on this site.
 * The API stores it where the engine looks (`x.png` → `x.dark.png`, the editor's darkVariantPath),
 * converting other raster formats to the image's own, and replaces any earlier dark version.
 */
export async function uploadAsset(siteId: string, file: File, opts?: { variant?: "light" | "dark"; for?: string }): Promise<UploadedAsset> {
  if (file.size > MAX_ASSET_BYTES) throw new DocsApiError("Files can be up to 25 MB.", 413);
  const form = new FormData();
  form.append("file", file);
  if (opts?.variant === "dark") {
    form.append("variant", "dark");
    if (opts.for) form.append("for", opts.for);
  }
  return request(`/${enc(siteId)}/assets`, { method: "POST", body: form });
}

/**
 * Where the dashboard can show an uploaded file: `/docs-assets/<name>` only exists on the published
 * site, so in the app it goes through the API's preview redirect. Anything else is returned as is.
 */
export function assetPreviewUrl(siteId: string, url: string | null | undefined): string | null {
  if (!url) return null;
  // An upload (<sha256>.<ext>, its dark version <sha256>.dark.<ext>) or an imported file (import/<page>/<name>).
  const m = /^\/docs-assets\/((?:[A-Za-z0-9_][A-Za-z0-9._@-]*\/){0,7}[A-Za-z0-9_][A-Za-z0-9._@-]*)$/.exec(url);
  return m ? `${API_BASE}${BASE}/${enc(siteId)}/assets/${m[1].split("/").map(enc).join("/")}` : url;
}

// ── Helpers shared by the screens ────────────────────────────────────────────

export const DOCS_HOST_SUFFIX = ".guides.markdrop.in";

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

/** Why a slug can't be used, or "" when its shape is fine (the API also checks reserved and taken). */
export function slugProblem(slug: string): string {
  if (!slug) return "Choose an address.";
  if (slug.length < 3) return "Use at least 3 characters.";
  if (slug.length > 40) return "Use at most 40 characters.";
  if (/[^a-z0-9-]/.test(slug)) return "Use lowercase letters, numbers and hyphens.";
  if (slug.startsWith("-") || slug.endsWith("-")) return "Start and end with a letter or number.";
  return "";
}

/** The free address's host: from `url` when the API gave one, else `<slug>.guides.markdrop.in`. */
export function siteHost(s: Pick<SiteSummary, "slug" | "url">): string {
  if (s.url) {
    try { return new URL(s.url).host; } catch { /* fall through */ }
  }
  return `${s.slug}${DOCS_HOST_SUFFIX}`;
}

/** The address readers use: a live custom domain first, else the free one. */
export function primaryAddress(s: Pick<SiteSummary, "slug" | "url" | "domains">): string {
  const own = s.domains?.find((d) => d.status === "live" || d.status === "verified");
  return own?.host ?? siteHost(s);
}

export const isAdminRole = (r: DocsRole | StudioRole | undefined | null): boolean => r === "owner" || r === "admin";
export const canReviewRole = (r: DocsRole | StudioRole | undefined | null): boolean => isAdminRole(r) || r === "reviewer";
export const canEditRole = (r: DocsRole | StudioRole | undefined | null): boolean => canReviewRole(r) || r === "editor";

/** The roles you can give, highest first, with what each may do (the Members screen's explainer). */
export const STUDIO_ROLES: Array<{ id: StudioRole; label: string; short: string; can: string[] }> = [
  { id: "admin", label: "Admin", short: "Everything, including settings and people", can: ["Change guide settings, design and domains", "Give people roles", "Approve reviews, publish, restore, delete"] },
  { id: "reviewer", label: "Reviewer", short: "Edit, publish and approve reviews", can: ["Everything an editor can", "Approve or send back other people's changes", "No settings"] },
  { id: "editor", label: "Editor", short: "Edit pages and publish", can: ["Create, edit and delete pages", "Upload images and files", "Publish, or submit for review when it's required"] },
  { id: "viewer", label: "Viewer", short: "Read drafts and history", can: ["Read drafts and preview", "See publish history", "No edits"] },
  { id: "none", label: "No access", short: "Can't see the guides", can: ["The workspace's guides are invisible to them"] },
];

export function roleLabel(r: DocsRole | StudioRole | "none" | null | undefined): string {
  if (r === "owner") return "Admin";
  return STUDIO_ROLES.find((x) => x.id === r)?.label ?? "No access";
}

/** "Workspace owner", "Workspace admin", "This guide only"… for a role's source. */
export function roleSourceLabel(s: RoleSource | null | undefined): string {
  switch (s) {
    case "workspace_owner": return "Workspace owner";
    case "workspace_admin": return "Workspace admin";
    case "site": return "This guide only";
    case "personal": return "Your personal guide";
    case "workspace": return "Guides role";
    default: return "";
  }
}

// ── People (Guides roles) ──────────────────────────────────────────────

const STUDIO_BASE = "/api/v1/docs-studio";

export interface StudioPerson {
  user_id: string;
  name: string;
  email: string | null;
  picture?: string | null;
  /** owner / admin / member / viewer in the workspace. */
  workspace_role: string | null;
}

export interface StudioMember extends StudioPerson {
  role: StudioRole;
  source: RoleSource;
  /** The workspace owner and admins: always admin, can't be changed. */
  locked: boolean;
  granted_by: string | null;
  granted_by_name: string | null;
  granted_at: string | null;
  site_overrides: Array<{ site_id: string; site_name: string | null; role: StudioRole }>;
}

export interface StudioMembersResponse {
  workspace: { id: string; name: string };
  your_role: DocsRole;
  your_role_source?: RoleSource | null;
  /** Your user id (you can't change your own role). */
  you: string;
  members: StudioMember[];
  sites: Array<{ id: string; name: string }>;
}

export interface SitePerson extends StudioPerson {
  /** Their role across the workspace. */
  studio_role: StudioRole;
  studio_source: RoleSource;
  /** This site's override, or null. */
  override: StudioRole | null;
  override_by: string | null;
  override_by_name: string | null;
  override_at: string | null;
  /** What they have on this site. */
  effective_role: StudioRole;
  source: RoleSource;
  locked: boolean;
}

export interface SitePeopleResponse {
  site_id: string;
  workspace_id: string | null;
  personal: boolean;
  your_role: DocsRole;
  you: string;
  members: SitePerson[];
}

export interface RoleEvent {
  kind: "docs_role_granted" | "docs_role_changed" | "docs_role_removed";
  at: string;
  actor_id: string | null;
  actor_name: string | null;
  target_user_id: string;
  target_name: string | null;
  scope: "workspace" | "site";
  site_id: string | null;
  site_name: string | null;
  role: StudioRole | null;
  previous: StudioRole | null;
  /** "left_workspace" when it went because they left. */
  reason?: string | null;
}

/** Guides › Members (studio admins only; 403 otherwise). */
export function getStudioMembers(workspaceId: string): Promise<StudioMembersResponse> {
  return request(`/workspaces/${enc(workspaceId)}/members`, undefined, STUDIO_BASE);
}

/** One member's studio role ("none" takes it away). */
export function setStudioMember(workspaceId: string, userId: string, role: StudioRole): Promise<StudioMember> {
  return request<StudioMember>(`/workspaces/${enc(workspaceId)}/members/${enc(userId)}`, { method: "PUT", json: { role } }, STUDIO_BASE)
    .then(after(() => guideEvents.memberRole("workspace", role)));
}

export function getStudioHistory(workspaceId: string, limit = 50): Promise<{ events: RoleEvent[] }> {
  return request(`/workspaces/${enc(workspaceId)}/history${q({ limit })}`, undefined, STUDIO_BASE);
}

/** Site › Settings › People: everyone in the workspace, with this site's overrides (site admins). */
export function getSitePeople(siteId: string): Promise<SitePeopleResponse> {
  return request(`/${enc(siteId)}/members`);
}

/** This site's role for a workspace member, whatever their workspace-wide one ("none" hides it). */
export function setSitePerson(siteId: string, userId: string, role: StudioRole): Promise<SitePerson> {
  return request<SitePerson>(`/${enc(siteId)}/members/${enc(userId)}`, { method: "PUT", json: { role } }).then(after(() => guideEvents.memberRole("site", role)));
}

/** Back to their workspace-wide role on this site. */
export function removeSitePerson(siteId: string, userId: string): Promise<SitePerson> {
  return request<SitePerson>(`/${enc(siteId)}/members/${enc(userId)}`, { method: "DELETE" }).then(after(() => guideEvents.memberRole("site", null)));
}

export function getSitePeopleHistory(siteId: string, limit = 50): Promise<{ events: RoleEvent[] }> {
  return request(`/${enc(siteId)}/members-history${q({ limit })}`);
}

/** What a theme suits, for the Design panel's filter (a theme can suit more than one). */
export type PresetKind = "docs" | "help" | "dev";

export const PRESETS: Array<{ id: ThemePreset; name: string; blurb: string; kinds: PresetKind[]; isNew?: boolean }> = [
  { id: "clean", name: "Clean", blurb: "Sidebar layout. Calm and familiar.", kinds: ["docs"] },
  { id: "editorial", name: "Editorial", blurb: "Serif headings, centred reading.", kinds: ["docs"] },
  { id: "technical", name: "Technical", blurb: "Dense, mono accents, API-first.", kinds: ["dev"] },
  { id: "minimal", name: "Minimal", blurb: "No sidebar chrome, lots of air.", kinds: ["docs"] },
  { id: "playful", name: "Playful", blurb: "Round, bold and friendly.", kinds: ["docs"] },
  { id: "helpcenter", name: "Help center", blurb: "Search first, then categories.", kinds: ["help"] },
  { id: "midnight", name: "Midnight", blurb: "Deep navy, violet accent. Developer tools.", kinds: ["dev"], isNew: true },
  { id: "paper", name: "Paper", blurb: "Warm paper, serif text. Handbooks.", kinds: ["docs"], isNew: true },
  { id: "terminal", name: "Terminal", blurb: "Monospace headings, green accent. CLI tools.", kinds: ["dev"], isNew: true },
  { id: "corporate", name: "Corporate", blurb: "Strict and compact, blue-grey. Enterprise.", kinds: ["docs", "help"], isNew: true },
  { id: "studio", name: "Studio", blurb: "Bold display type, big rounded cards. Launches.", kinds: ["docs"], isNew: true },
  { id: "academic", name: "Academic", blurb: "Serif, numbered sections. Knowledge bases.", kinds: ["docs", "help"], isNew: true },
  { id: "atlas", name: "Atlas", blurb: "Top tabs, a card-grid home. Big help centers.", kinds: ["help"], isNew: true },
  { id: "pastel", name: "Pastel", blurb: "Soft colours, friendly shapes. Education.", kinds: ["docs", "help"], isNew: true },
];

export const presetName = (p: ThemePreset | undefined | null): string => PRESETS.find((x) => x.id === p)?.name ?? "Clean";

/** The font ids the API accepts (services/docs_site_settings.py FONT_IDS); null = the preset's own. */
export const FONTS: Array<{ id: string; label: string; family: string; kind: "sans" | "serif" | "mono" }> = [
  { id: "system", label: "System UI", family: "system-ui, sans-serif", kind: "sans" },
  { id: "inter", label: "Inter", family: "Inter, sans-serif", kind: "sans" },
  { id: "manrope", label: "Manrope", family: "Manrope, var(--font-sans)", kind: "sans" },
  { id: "geist", label: "Geist", family: "Geist, sans-serif", kind: "sans" },
  { id: "dmsans", label: "DM Sans", family: '"DM Sans", sans-serif', kind: "sans" },
  { id: "plex", label: "IBM Plex Sans", family: '"IBM Plex Sans", sans-serif', kind: "sans" },
  { id: "nunito", label: "Nunito", family: "Nunito, sans-serif", kind: "sans" },
  { id: "source-sans-3", label: "Source Sans 3", family: '"Source Sans 3", sans-serif', kind: "sans" },
  { id: "space-grotesk", label: "Space Grotesk", family: '"Space Grotesk", sans-serif', kind: "sans" },
  { id: "plus-jakarta-sans", label: "Plus Jakarta Sans", family: '"Plus Jakarta Sans", sans-serif', kind: "sans" },
  { id: "figtree", label: "Figtree", family: "Figtree, sans-serif", kind: "sans" },
  { id: "newsreader", label: "Newsreader", family: "Newsreader, Georgia, serif", kind: "serif" },
  { id: "source-serif-4", label: "Source Serif 4", family: '"Source Serif 4", Georgia, serif', kind: "serif" },
  { id: "lora", label: "Lora", family: "Lora, Georgia, serif", kind: "serif" },
  { id: "fraunces", label: "Fraunces", family: "Fraunces, Georgia, serif", kind: "serif" },
  { id: "crimson-pro", label: "Crimson Pro", family: '"Crimson Pro", Georgia, serif', kind: "serif" },
  { id: "jetbrains-mono", label: "JetBrains Mono", family: '"JetBrains Mono", var(--font-mono)', kind: "mono" },
  { id: "plex-mono", label: "IBM Plex Mono", family: '"IBM Plex Mono", var(--font-mono)', kind: "mono" },
  { id: "geist-mono", label: "Geist Mono", family: '"Geist Mono", var(--font-mono)', kind: "mono" },
  { id: "fira-code", label: "Fira Code", family: '"Fira Code", var(--font-mono)', kind: "mono" },
  { id: "source-code-pro", label: "Source Code Pro", family: '"Source Code Pro", var(--font-mono)', kind: "mono" },
];

export const CUSTOM_CSS_MAX = 20 * 1024;

/**
 * Why the docs engine would refuse this custom CSS ("" when it's fine). The engine's own
 * sanitizeCss decides, the same rules the API applies on save (services/docs_site_settings.py is a
 * port of it, tested against one shared corpus), so the panel says what's wrong before saving.
 */
export function customCssProblem(css: string): string {
  if (!css.trim()) return "";
  const { errors } = sanitizeCss(css);
  return errors.length ? `Custom CSS: ${errors[0]}.` : "";
}

