/**
 * Markdrop Guides › Import from GitHub and keep in sync: a typed client for `/api/v1/github/*`
 * (the Markdrop Guides GitHub App: installations, repositories, what a folder holds) and for a
 * guide's own link, `/api/v1/docs-sites/<site>/github*` (connect, sync now, mode, disconnect).
 *
 * Public repositories import without the app (read through GitHub's public API); private ones and
 * syncing on every push need the app installed. When this server has no app set up (`app.configured`
 * false) the public import still works and the rest shows "Not set up yet".
 *
 * Every read takes an AbortSignal: the pickers drop a stale answer when the person has moved on.
 */
import { DocsApiError, docsRequest, type GithubFormat, type GithubFormatChoice, type GithubLink, type GithubSyncMode, type Job } from "@/lib/docsSites";
import type { ApiReferenceStatus } from "@/lib/docsApiReference";

export { parseGithubUrl, repoLabel } from "./githubUrl.mjs";
export type { ParsedGithubRepo } from "./githubUrl.mjs";
export type { GithubFormat, GithubFormatChoice, GithubLink, GithubSyncMode };

const GH = "/api/v1/github";
const enc = encodeURIComponent;

const q = (params: Record<string, string | number | null | undefined>): string => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
};

// ── Types ────────────────────────────────────────────────────────────────────

/** A GitHub account (a person or an organisation) that installed the Markdrop Guides app. */
export interface GithubInstallation {
  installation_id: number;
  account: { login: string; type: "User" | "Organization"; avatar_url: string | null };
  repository_selection: "all" | "selected";
  suspended: boolean;
  /** github.com's page to change which repositories the app reads. */
  manage_url: string | null;
}

/** GET /github/status */
export interface GithubStatus {
  app: { configured: boolean; slug: string | null; name: string };
  installations: GithubInstallation[];
  /** May link or unlink installations for this workspace (Guides admins). */
  can_manage: boolean;
}

export interface GithubRepo {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  description: string | null;
  pushed_at: string | null;
  installation_id: number | null;
}

/** GET /github/repo */
export interface GithubRepoDetail {
  repo: GithubRepo & { public: boolean };
  /** Branch names (the default branch is in there). */
  branches: string[];
  /** How it was read: through the app, or GitHub's public API. */
  via: "app" | "public";
}

/** A folder the picker suggests, with what it found there. */
export interface GithubFolder {
  path: string;
  format: GithubFormat;
  pages: number;
}

/** GET /github/inspect: what a folder holds (the preview before importing). */
export interface GithubInspect {
  sha: string;
  folders: GithubFolder[];
  selected: {
    path: string;
    /** The format the import will use (the override, else the detected one). */
    format: GithubFormat;
    detected_format: GithubFormat;
    content_root: string;
    pages: number;
    /** Each group's page count and its first titles (up to 8). */
    groups: Array<{ group: string; count: number; pages: string[] }>;
    openapi: string[];
    warnings: string[];
  };
  /** The repository has more files than the preview reads (counts are a lower bound). */
  truncated: boolean;
}

/** One sync (or the first import) of a linked guide. */
export interface GithubSync {
  id: string;
  job_id: string | null;
  trigger: "import" | "push" | "manual" | "connect";
  sha: string | null;
  short_sha: string | null;
  commit_url: string | null;
  /** Who pushed (a GitHub login), for push syncs. */
  pusher: string | null;
  status: "queued" | "running" | "done" | "failed";
  pages: { created: number; updated: number; deleted: number; unchanged: number } | null;
  /** Mode "publish": the publish it started. */
  published_build: number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

/** GET /docs-sites/<site>/github */
export interface SiteGithubState {
  link: GithubLink | null;
  syncs: GithubSync[];
  app: { configured: boolean; slug: string | null };
}

/** PUT / PATCH / POST sync answer with the whole state (link, history, app); older answers only the link. */
export type SiteLinkAnswer = { link: GithubLink | null } & Partial<Omit<SiteGithubState, "link">>;

export interface GithubConnectResult {
  installations: GithubInstallation[];
  /** The installation ids this linked to the workspace. */
  linked: number[];
  return_to: string | null;
  workspace_id: string | null;
}

/** What a repository choice sends (a new guide's source, or connecting an existing guide). */
export interface GithubRepoChoice {
  installation_id: number | null;
  owner: string;
  name: string;
  branch: string;
  path: string;
  format: GithubFormatChoice;
  mode: GithubSyncMode;
  sync: boolean;
}

// ── Labels ───────────────────────────────────────────────────────────────────

export const FORMAT_LABELS: Record<GithubFormat, string> = {
  markdown: "Markdown folder",
  gitbook: "GitBook (Git Sync)",
  mintlify: "Mintlify",
  docusaurus: "Docusaurus",
  mkdocs: "MkDocs",
};
export const FORMAT_CHOICES: GithubFormatChoice[] = ["auto", "markdown", "gitbook", "mintlify", "docusaurus", "mkdocs"];
export const formatLabel = (f: string | null | undefined): string => (f && f in FORMAT_LABELS ? FORMAT_LABELS[f as GithubFormat] : f === "auto" ? "Auto" : f || "Markdown folder");

export const MODE_COPY: Record<GithubSyncMode, { label: string; body: string }> = {
  drafts: { label: "Update drafts", body: "Each push updates the drafts. You publish when ready." },
  publish: { label: "Publish automatically", body: "Each push is published after it syncs." },
};

/** "docs" or "the repository root". */
export const folderLabel = (path: string | null | undefined): string => (path ? path : "Repository root");

/**
 * The repository's own address (https://github.com/<owner>/<name>): `html_url` may point at the
 * folder (…/tree/<branch>/<path>), so only its origin is kept (GitHub Enterprise or a test server).
 */
export function repoBase(link: Pick<GithubLink, "owner" | "name" | "html_url">): string {
  let origin = "https://github.com";
  try {
    if (link.html_url && /^https:\/\//i.test(link.html_url)) origin = new URL(link.html_url).origin;
  } catch { /* keep github.com */ }
  return `${origin}/${enc(link.owner)}/${enc(link.name)}`;
}

/** github.com's editor for a file in the linked repository. */
export function editOnGithubUrl(link: Pick<GithubLink, "owner" | "name" | "branch" | "html_url">, path: string): string {
  const file = path.split("/").filter(Boolean).map(enc).join("/");
  return `${repoBase(link)}/edit/${link.branch.split("/").map(enc).join("/")}/${file}`;
}

/** The linked folder on github.com (the repository when it's the root). */
export function repoUrl(link: Pick<GithubLink, "owner" | "name" | "html_url">): string {
  return link.html_url && /^https:\/\//i.test(link.html_url) ? link.html_url : repoBase(link);
}

/** A commit on github.com. */
export const commitUrl = (link: Pick<GithubLink, "owner" | "name" | "html_url">, sha: string): string => `${repoBase(link)}/commit/${enc(sha)}`;

// ── Errors ───────────────────────────────────────────────────────────────────

export type GithubErrorKind = "rate_limit" | "not_found" | "not_configured" | "forbidden" | "bad_request" | "offline" | "other";

/** What went wrong, for the pickers' messages (and `retryAfter` seconds on GitHub's rate limit). */
export function githubError(e: unknown): { kind: GithubErrorKind; message: string; retryAfter: number | null } {
  const status = e instanceof DocsApiError ? e.status : -1;
  const message = e instanceof Error && e.message ? e.message : "That didn't work. Try again.";
  const ra = e instanceof DocsApiError ? Number(e.info.retry_after) : NaN;
  const retryAfter = Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : null;
  const kind: GithubErrorKind =
    status === 429 ? "rate_limit"
      : status === 404 ? "not_found"
        : status === 503 ? "not_configured"
          : status === 403 ? "forbidden"
            : status === 400 || status === 422 ? "bad_request"
              : status === 0 ? "offline"
                : "other";
  return { kind, message, retryAfter };
}

/** True when the request was dropped on purpose (a newer one replaced it). */
export const isAborted = (signal?: AbortSignal | null): boolean => !!signal?.aborted;

// ── /api/v1/github ───────────────────────────────────────────────────────────

/** `workspace` is a workspace id or "personal". */
export function getGithubStatus(workspace: string, signal?: AbortSignal): Promise<GithubStatus> {
  return docsRequest(`/status${q({ workspace_id: workspace })}`, { signal }, GH);
}

/** Install the app on a GitHub account: the address to send the browser to. 503 when the app isn't set up. */
export function startGithubInstall(workspace: string, returnTo: string): Promise<{ url: string }> {
  return docsRequest("/install", { method: "POST", json: { workspace_id: workspace, return_to: returnTo } }, GH);
}

/** Link an installation that already exists (GitHub sign-in): the address to send the browser to. */
export function startGithubAuthorize(workspace: string, returnTo: string): Promise<{ url: string }> {
  return docsRequest("/authorize", { method: "POST", json: { workspace_id: workspace, return_to: returnTo } }, GH);
}

/** Back from github.com (/guides/github/installed): finish linking. */
export function connectGithub(input: { code: string; state: string; installation_id?: number | null; setup_action?: string | null }): Promise<GithubConnectResult> {
  return docsRequest("/connect", { method: "POST", json: input }, GH);
}

/** Unlink an installation from the workspace (in Markdrop only: the app stays installed on GitHub). */
export function unlinkGithubInstallation(installationId: number, workspace: string): Promise<{ ok: true }> {
  return docsRequest(`/installations/${installationId}${q({ workspace_id: workspace })}`, { method: "DELETE" }, GH);
}

export function listGithubRepos(workspace: string, installationId: number, search: string, signal?: AbortSignal): Promise<{ repos: GithubRepo[]; truncated: boolean }> {
  return docsRequest(`/repos${q({ workspace_id: workspace, installation_id: installationId, q: search.trim() })}`, { signal }, GH);
}

/** No installation: read it as a public repository (404 when it doesn't exist or is private). */
export function getGithubRepo(workspace: string, owner: string, name: string, installationId: number | null, signal?: AbortSignal): Promise<GithubRepoDetail> {
  return docsRequest<GithubRepoDetail>(`/repo${q({ workspace_id: workspace, owner, name, installation_id: installationId })}`, { signal }, GH)
    .then((r) => ({ ...r, branches: r.branches?.length ? r.branches : [r.repo.default_branch] }));
}

/**
 * What a folder holds. `path` null: let the API choose (its best suggestion, `folders[0]`); ""
 * is the repository root, asked for explicitly.
 */
export function inspectGithubRepo(
  input: { workspace: string; owner: string; name: string; branch: string; path: string | null; installationId: number | null; format?: GithubFormatChoice | null },
  signal?: AbortSignal,
): Promise<GithubInspect> {
  const format = input.format && input.format !== "auto" ? input.format : undefined;
  const base = q({ workspace_id: input.workspace, owner: input.owner, name: input.name, branch: input.branch, installation_id: input.installationId, format });
  const path = input.path === null ? "" : `${base ? "&" : "?"}path=${enc(input.path)}`;
  return docsRequest<GithubInspect>(
    `/inspect${base}${path}`,
    { signal },
    GH,
  ).then((r) => ({
    ...r,
    folders: r.folders ?? [],
    truncated: !!r.truncated,
    selected: { ...r.selected, groups: r.selected?.groups ?? [], openapi: r.selected?.openapi ?? [], warnings: r.selected?.warnings ?? [] },
  }));
}

// ── /api/v1/docs-sites/<site>/github ─────────────────────────────────────────

export function getSiteGithub(siteId: string, signal?: AbortSignal): Promise<SiteGithubState> {
  return docsRequest(`/${enc(siteId)}/github`, { signal });
}

/** Admins: link an existing guide to a repository and start the first sync. */
export function connectSiteGithub(siteId: string, choice: GithubRepoChoice): Promise<SiteLinkAnswer & { job: Job | null }> {
  return docsRequest(`/${enc(siteId)}/github`, { method: "PUT", json: choice });
}

/** Admins: change how it syncs. */
export function updateSiteGithub(siteId: string, patch: Partial<Pick<GithubLink, "mode" | "sync" | "format" | "branch">> & { installation_id?: number }): Promise<SiteLinkAnswer> {
  return docsRequest(`/${enc(siteId)}/github`, { method: "PATCH", json: patch });
}

/** Editors and admins: sync now (a sync already waiting comes back instead of a new one). */
export function syncSiteGithub(siteId: string): Promise<SiteLinkAnswer & { job: Job | null }> {
  return docsRequest(`/${enc(siteId)}/github/sync`, { method: "POST" });
}

/** Admins: stop syncing. The pages stay and become studio pages. */
export function disconnectSiteGithub(siteId: string): Promise<{ ok: true }> {
  return docsRequest(`/${enc(siteId)}/github`, { method: "DELETE" });
}

/** Admins: make an OpenAPI file in the repository the guide's API reference. */
export function adoptGithubOpenapi(siteId: string, path: string): Promise<ApiReferenceStatus> {
  return docsRequest(`/${enc(siteId)}/github/openapi`, { method: "POST", json: { path } });
}
