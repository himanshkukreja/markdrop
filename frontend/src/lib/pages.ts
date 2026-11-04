/**
 * Pages: Markdrop documents opened in the block editor (`editor: "blocks"`), with sub-pages, page
 * images, embeds of other Markdrop items and an edit lock. The typed client for the page builder's
 * API (scratchpad CONTRACT.md, "Endpoints"). Everything here goes through the reader's session; on a
 * workspace's own domain that session is the domain's own token, which the API lets through only
 * for the read routes a page needs (embeds and asset URLs).
 *
 * Kept out of lib/api.ts: that module is loaded by every public document page.
 */
import { API_BASE, getToken, type DocumentResponse } from "@/lib/api";
import { announce } from "@/lib/navBus";
import { readPageProps } from "@/components/pages/pageProps";

/* ── errors ─────────────────────────────────────────────────────────────── */

/** An API refusal with its status and JSON body (`code`, `holder`, `readers_before`…). */
export class PagesApiError extends Error {
  status: number;
  info: Record<string, unknown>;
  constructor(message: string, status: number, info: Record<string, unknown> = {}) {
    super(message);
    this.name = "PagesApiError";
    this.status = status;
    this.info = info;
  }
}

export const pagesErrorStatus = (e: unknown): number => (e instanceof PagesApiError ? e.status : 0);

function headers(json = true, extra?: Record<string, string>): Record<string, string> {
  const t = getToken();
  return { ...(json ? { "Content-Type": "application/json" } : {}), ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(extra ?? {}) };
}

async function call<T>(path: string, init?: RequestInit & { secret?: string | null }): Promise<T> {
  const { secret, ...rest } = init ?? {};
  // A keepalive request (the lock let go as the page closes) asks its preflight for nothing but
  // Authorization: Chromium drops one that also wants Content-Type, the no-store cache headers or
  // the edit secret header while the page unloads. The session alone identifies the editor.
  const leaving = !!rest.keepalive && !!getToken();
  const json = typeof rest.body === "string";
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...(leaving ? {} : { cache: "no-store" as RequestCache }),
      ...rest,
      headers: { ...headers(json, secret && !leaving ? { "x-edit-secret": secret } : undefined), ...((rest.headers as Record<string, string>) ?? {}) },
    });
  } catch {
    throw new PagesApiError("Couldn't reach Markdrop. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    // FastAPI puts structured refusals in `detail` (an object) and plain ones as a string.
    const detail = body?.detail;
    const info = detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : body ?? {};
    const message =
      typeof detail === "string" ? detail
        : typeof info.message === "string" ? info.message
          : Array.isArray(detail) ? "That value isn't valid."
            : `Request failed (${res.status})`;
    throw new PagesApiError(message, res.status, info);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const enc = encodeURIComponent;

/* ── shapes ─────────────────────────────────────────────────────────────── */

export type EditorKind = "blocks" | "classic";

export interface Crumb {
  slug: string;
  title: string | null;
  /** The page's icon (an emoji or asset:<id>), when the API sends it. */
  icon?: string | null;
}

export interface AssetUrl {
  url: string;
  expires_at?: string | null;
  /** The image's size in pixels, when it was read at upload (it keeps the image's room while it loads). */
  width?: number;
  height?: number;
}

/** A document as the page builder reads it: GET /documents/{slug} plus the page fields. */
export interface PageDocument extends DocumentResponse {
  /** "blocks": a page (the block editor). Absent: the classic editor. */
  editor?: "blocks" | null;
  parent?: Crumb | null;
  /** Readable ancestors, root first (never the page itself). */
  breadcrumbs?: Crumb[];
  children_count?: number;
  /** Meaningful with a parent: true (or absent) = who can read follows the parent. */
  access_inherit?: boolean | null;
  template_id?: string | null;
  /** Page images referenced in the content, per viewer: `asset:<id>` → URL. */
  assets?: Record<string, AssetUrl>;
  /** Auto covers: the cover was picked for the page automatically. */
  cover_auto?: boolean;
  /** Auto covers: one is being picked right now (the editor fades it in when it lands). */
  cover_pending?: boolean;
}

export interface PageTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  content: string;
}

export interface ChildPage {
  slug: string;
  title: string | null;
  editor?: "blocks" | null;
  updated_at?: string | null;
  has_children: boolean;
  access_inherit?: boolean | null;
  /** An emoji or asset:<id>, and the image's link for asset icons. */
  icon?: string | null;
  icon_url?: string | null;
}

export type EmbedState = "ok" | "signin" | "denied" | "password" | "encrypted" | "missing";
export type EmbedRenderer = "html" | "bundle" | "pdf" | "sheet" | "docx" | "text" | "image" | "video" | "audio" | "markdown";

/** One embed or mention resolved for the viewer. Anything not "ok" carries no title or address. */
export interface ResolvedEmbed {
  state: EmbedState;
  kind?: "document" | "artifact";
  renderer?: EmbedRenderer;
  title?: string | null;
  /** The item's Markdrop link for this viewer (the custom domain when there is one). */
  url?: string | null;
  artifact_url?: string | null;
  viewer_url?: string | null;
  download_url?: string | null;
  poster_url?: string | null;
  expires_at?: string | null;
  preview?: { excerpt?: string | null; updated_at?: string | null; author_name?: string | null } | null;
}

export interface CreatedPage {
  document: PageDocument;
  edit_secret?: string | null;
}

export interface UploadedAsset {
  id: string;
  mime: string;
  size: number;
  width?: number | null;
  height?: number | null;
}

export interface LockInfo {
  holder: { name: string | null };
  expires_at?: string | null;
}

/* ── pages ──────────────────────────────────────────────────────────────── */

/** Tell the navigation caches (lib/navStore), here and in the person's other tabs (lib/navBus),
 *  that pages changed: the rail's outline and sub-page lists refresh (an event, so this module
 *  doesn't import the store that imports it). A save carries the page's title and icon instead,
 *  so the caches patch that one row without a request. */
function changed<T>(p: Promise<T>, saved?: { slug: string; title: string | null; icon: string | null }): Promise<T> {
  return p.then((r) => {
    announce("md:pages-change", saved ? { soft: true, ...saved } : { soft: false });
    return r;
  });
}

/** `POST /pages`: a new page (signed in). `parent` is a page's slug; the new page inherits its access. */
export function createPage(input: { title: string; workspace?: string | null; folder?: string | null; parent?: string | null; template?: string | null; content?: string | null; after?: string | null; autoCover?: boolean }) {
  const body: Record<string, unknown> = { title: input.title };
  for (const k of ["workspace", "folder", "parent", "template", "content", "after"] as const) if (input[k]) body[k] = input[k];
  // A cover is picked for a new page unless it has one; a duplicate keeps its source's (none included).
  if (input.autoCover === false) body.auto_cover = false;
  return changed(call<CreatedPage>("/api/v1/pages", { method: "POST", body: JSON.stringify(body) }));
}

export interface CoverStatus {
  cover: string | null;
  cover_auto: boolean;
  cover_pending: boolean;
  rev: number;
}

/** `GET /pages/{slug}/cover`: the page's cover now (an editor waiting on its auto cover polls this). */
export function getCoverStatus(slug: string, secret?: string | null) {
  return call<CoverStatus>(`/api/v1/pages/${enc(slug)}/cover`, { secret });
}

/** `POST /pages/{slug}/cover/suggest`: a cover picked for the page like an auto cover, not saved ("Pick for me"). */
export function suggestCover(slug: string, secret?: string | null) {
  return call<{ cover: string; how: "ai" | "keywords" }>(`/api/v1/pages/${enc(slug)}/cover/suggest`, { method: "POST", secret });
}

/** A page as this person reads it (GET /documents/{slug}, with their session). */
export function getPage(slug: string) {
  return call<PageDocument & { page_path?: string[] | null; page?: Record<string, unknown> | null }>(`/api/v1/documents/${enc(slug)}`);
}

let templatesCache: Promise<PageTemplate[]> | null = null;
/** The built-in templates (cached for the session). */
export function listPageTemplates(): Promise<PageTemplate[]> {
  if (!templatesCache) {
    templatesCache = call<PageTemplate[]>("/api/v1/page-templates");
    templatesCache.catch(() => (templatesCache = null));
  }
  return templatesCache;
}

/** Open a document in the block editor ("blocks"), or back in the classic one. The Markdown is unchanged. */
export function setEditor(slug: string, editor: EditorKind, secret?: string | null) {
  return call<PageDocument>(`/api/v1/documents/${enc(slug)}/editor`, { method: "PUT", body: JSON.stringify({ editor }), secret });
}

export function listChildren(slug: string) {
  return call<ChildPage[]>(`/api/v1/documents/${enc(slug)}/children`);
}

/** Thrown by movePage when the move would change who can read the page (confirm and try again). */
export interface AccessChange {
  readers_before: unknown;
  readers_after: unknown;
}

/**
 * `PUT /documents/{slug}/parent`: under another page (`parent`, a slug) or at the top (null).
 * `after` places it among its new siblings (null: first; omitted: last). The API orders siblings
 * by `after` once it supports it (DEVIATIONS "Frontend → backend requests"); until then it ignores
 * the field and lists sub-pages oldest first.
 */
export function movePage(slug: string, parent: string | null, confirmAccessChange = false, after?: string | null) {
  return changed(call<PageDocument>(`/api/v1/documents/${enc(slug)}/parent`, {
    method: "PUT",
    body: JSON.stringify({ parent, ...(after !== undefined ? { after } : {}), ...(confirmAccessChange ? { confirm_access_change: true } : {}) }),
  }));
}

/** The 409 a move gets when it would change who can read the page (confirm and send again). */
export function accessChangeOf(e: unknown): AccessChange | null {
  if (!(e instanceof PagesApiError) || e.status !== 409 || e.info.code !== "access_change") return null;
  return { readers_before: e.info.readers_before, readers_after: e.info.readers_after };
}

/** Your own documents outside any workspace that pages can go inside (Markdown, not encrypted). */
export async function searchMyPages(q: string): Promise<Array<{ slug: string; title: string | null; editor: "blocks" | null; updated_at: string | null }>> {
  const p = new URLSearchParams({ page: "1", limit: "50" });
  if (q) p.set("q", q);
  const r = await call<{ documents: Array<Record<string, unknown>> }>(`/api/v1/me/documents?${p}`);
  return (r.documents ?? [])
    .filter((d) => d.kind !== "artifact" && !d.encrypted && !d.workspace_id && typeof d.slug === "string")
    .map((d) => ({
      slug: String(d.slug),
      title: (d.title as string | null) ?? null,
      editor: d.editor === "blocks" ? "blocks" : null,
      updated_at: (d.updated_at as string | null) ?? null,
    }));
}

/** Delete a page; with sub-pages, `children` says whether they go too or move up a level. */
export function deletePage(slug: string, children?: "delete" | "lift", secret?: string | null) {
  const q = children ? `?children=${children}` : "";
  return changed(call<void>(`/api/v1/documents/${enc(slug)}${q}`, { method: "DELETE", secret }));
}

/* ── saving, the edit lock ──────────────────────────────────────────────── */

/**
 * `PUT /documents/{slug}` with `base_rev`: 409 when someone saved a newer version, 423 `{code:
 * "locked", holder}` while someone else holds the edit lock.
 */
export function savePage(slug: string, input: { title: string | null; content: string; baseRev: number | null }, secret?: string | null) {
  // A save may rename the page or change its icon: the caches patch its row (autosave runs
  // often; nothing is fetched, except for a new image icon, whose link only the API knows).
  return changed(call<PageDocument>(`/api/v1/documents/${enc(slug)}`, {
    method: "PUT",
    secret,
    body: JSON.stringify({
      title: input.title?.trim() || null,
      content: input.content || "\n",
      ...(typeof input.baseRev === "number" && input.baseRev > 0 ? { base_rev: input.baseRev } : {}),
    }),
  }), { slug, title: input.title, icon: readPageProps(input.content).icon });
}

/** Take (or refresh) the edit lock: held 2 minutes, refreshed every 30 s. 423 when someone else has it. */
export function lockPage(slug: string, secret?: string | null) {
  return call<LockInfo>(`/api/v1/documents/${enc(slug)}/lock`, { method: "POST", secret });
}

export function unlockPage(slug: string, opts?: { keepalive?: boolean; secret?: string | null }) {
  // The page is closing: a beacon, with the session token as its body. A keepalive DELETE needs a
  // CORS preflight (the API is on another origin) that browsers don't make while a page unloads, so
  // the lock would stay taken for two more minutes.
  const t = opts?.keepalive ? getToken() : null;
  if (t && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try {
      if (navigator.sendBeacon(`${API_BASE}/api/v1/documents/${enc(slug)}/lock/release`, new Blob([t], { type: "text/plain" }))) {
        return Promise.resolve();
      }
    } catch {
      /* fall through to the DELETE */
    }
  }
  return call<void>(`/api/v1/documents/${enc(slug)}/lock`, { method: "DELETE", keepalive: opts?.keepalive, secret: opts?.secret });
}

/** The holder's name from a 423 refusal. */
export function lockHolder(e: unknown): string | null {
  if (!(e instanceof PagesApiError) || e.status !== 423) return null;
  const h = e.info.holder as { name?: unknown } | undefined;
  return typeof h?.name === "string" && h.name.trim() ? h.name : null;
}

/* ── images ─────────────────────────────────────────────────────────────── */

export const PAGE_IMAGE_MAX = 10 * 1024 * 1024;

export function uploadPageAsset(slug: string, file: File, secret?: string | null) {
  const form = new FormData();
  form.append("file", file);
  return call<UploadedAsset>(`/api/v1/documents/${enc(slug)}/assets`, { method: "POST", body: form, secret });
}

export function refreshAssetUrls(slug: string) {
  return call<{ assets: Record<string, AssetUrl> }>(`/api/v1/documents/${enc(slug)}/assets/urls`);
}

/* ── embeds ─────────────────────────────────────────────────────────────── */

export const EMBED_BATCH = 100;

/** Resolve embeds and mentions for this viewer (at most 100 a call; more are batched). */
export async function resolveEmbeds(pageSlug: string, slugs: string[]): Promise<Record<string, ResolvedEmbed>> {
  const unique = [...new Set(slugs)];
  const out: Record<string, ResolvedEmbed> = {};
  for (let i = 0; i < unique.length; i += EMBED_BATCH) {
    const part = unique.slice(i, i + EMBED_BATCH);
    const r = await call<{ embeds: Record<string, ResolvedEmbed> }>(`/api/v1/documents/${enc(pageSlug)}/embeds`, {
      method: "POST",
      body: JSON.stringify({ slugs: part }),
    });
    Object.assign(out, r.embeds ?? {});
  }
  return out;
}

/* ── bookmarks, people, backlinks (DEVIATIONS "Frontend → backend requests") ─── */

export interface LinkPreview {
  url?: string;
  title?: string | null;
  description?: string | null;
  site_name?: string | null;
  favicon_url?: string | null;
  image_url?: string | null;
}

/** A link's preview for a bookmark block, fetched by the server (SSRF-safe). */
export function linkPreview(url: string) {
  return call<LinkPreview>("/api/v1/link-preview", { method: "POST", body: JSON.stringify({ url }) });
}

/** Members of a workspace whose name matches `q` (for `@person`). */
export function searchPeople(workspaceId: string, q: string) {
  return call<Array<{ id: string; name: string; avatar_url?: string | null }>>(`/api/v1/workspaces/${enc(workspaceId)}/members/search?q=${enc(q)}`);
}

/** Pages that mention or embed this one, that the caller can read. */
export function listBacklinks(slug: string) {
  return call<Array<{ slug: string; title: string | null; icon?: string | null }>>(`/api/v1/documents/${enc(slug)}/backlinks`);
}

/* ── the embed picker's search ──────────────────────────────────────────── */

export interface PickableItem {
  slug: string;
  title: string | null;
  kind: "markdown" | "artifact";
  renderer?: string | null;
  type_label?: string | null;
  mime?: string | null;
  updated_at?: string | null;
  where: "mine" | "workspace";
  encrypted?: boolean;
}

/** Your own documents and files (GET /me/documents). */
export async function searchMine(q: string, page = 1): Promise<{ items: PickableItem[]; more: boolean }> {
  const p = new URLSearchParams({ page: String(page), limit: "20" });
  if (q) p.set("q", q);
  const r = await call<{ documents: Array<Record<string, unknown>>; pages: number; page: number }>(`/api/v1/me/documents?${p}`);
  return {
    items: (r.documents ?? []).map((d) => ({
      slug: String(d.slug),
      title: (d.title as string | null) ?? null,
      kind: d.kind === "artifact" ? "artifact" : "markdown",
      renderer: (d.renderer as string | null) ?? null,
      type_label: (d.type_label as string | null) ?? null,
      mime: (d.mime as string | null) ?? null,
      updated_at: (d.updated_at as string | null) ?? null,
      encrypted: !!d.encrypted,
      where: "mine" as const,
    })),
    more: (r.page ?? 1) < (r.pages ?? 1),
  };
}

/** A workspace's items the caller can open (GET /workspaces/{id}/items, every folder). */
export async function searchWorkspace(workspaceId: string, q: string, cursor?: string | null): Promise<{ items: PickableItem[]; cursor: string | null }> {
  const p = new URLSearchParams({ folder: "all", limit: "30" });
  if (q) p.set("q", q);
  if (cursor) p.set("cursor", cursor);
  const r = await call<{ items: Array<Record<string, unknown>>; next_cursor: string | null }>(`/api/v1/workspaces/${enc(workspaceId)}/items?${p}`);
  return {
    items: (r.items ?? [])
      .filter((x) => typeof x.slug === "string" && !x.redacted)
      .map((d) => ({
        slug: String(d.slug),
        title: (d.title as string | null) ?? null,
        kind: d.kind === "artifact" ? "artifact" : "markdown",
        renderer: (d.renderer as string | null) ?? null,
        mime: (d.mime as string | null) ?? null,
        updated_at: (d.updated_at as string | null) ?? null,
        encrypted: !!d.encrypted,
        where: "workspace" as const,
      })),
    cursor: r.next_cursor ?? null,
  };
}
