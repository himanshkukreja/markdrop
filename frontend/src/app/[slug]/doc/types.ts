/** DocumentView's props. The contract `page.tsx` and the tenant route render with — unchanged. */
export interface DocumentViewProps {
  slug: string;
  title: string | null;
  content: string;
  url: string;
  createdAt: string;
  expiresAt: string | null;
  views?: number;
  editSecret?: string;
  isPasswordProtected?: boolean;
  /**
   * Which gate the anonymous server render hit, if any. "password" is a shared
   * secret anyone may type; "signin" means the document is not public and the
   * reader has to be somebody. They are different questions and must not be
   * asked with the same box.
   */
  gate?: "password" | "signin" | null;
  /** Absolute sign-in URL. Set only on a workspace domain, which has no
   *  `/login` of its own. */
  signInUrl?: string | null;
  isOwned?: boolean;
  syncedWithVscode?: boolean;
  /** `content` is a sealed envelope; the key is in the URL fragment, not here. */
  encrypted?: boolean;
  /** The server render's `rev` for `content` (sent back as `base_rev` on save). */
  rev?: number | null;
  /** Opaque analytics reference (API `ref`); never the slug. Null behind a gate. */
  docRef?: string | null;
  /** Only ever set on a workspace's own domain. "minimal" behaves like "full" (D24). */
  viewerChrome?: "full" | "minimal" | "none";
  /** The server render's `read_ticket` (beacons + live socket, §2.7). Client reads replace it. */
  readTicket?: string | null;
  /** A page (the block editor): its page fields from the server render. Client reads replace them. */
  page?: PageFields | null;
}

/** What a document read says about it as a page (lib/pages PageDocument). */
export interface PageFields {
  editor?: "blocks" | null;
  parent?: { slug: string; title: string | null } | null;
  breadcrumbs?: Array<{ slug: string; title: string | null }>;
  children_count?: number;
  access_inherit?: boolean | null;
  assets?: Record<string, { url: string; expires_at?: string | null }>;
  workspace_id?: string | null;
  /** The workspace folders' slugs only (not the ancestors). */
  folder_path?: string[];
  /** Every ancestor page's slug, top first (readable or not). */
  page_path?: string[];
  /** The page's properties as the API reads them, with per-viewer URLs for an uploaded icon or cover. */
  props?: { icon?: string | null; icon_url?: string | null; cover?: string | null; cover_url?: string | null } | null;
  /** This page is a workspace or personal template ({id, …}), or part of one ({part_of}). */
  template?: { id?: string; description?: string; icon?: string | null; scope?: "workspace" | "personal"; part_of?: boolean } | null;
  /** Auto covers: the cover was picked automatically / one is on its way (the editor fades it in). */
  cover_auto?: boolean;
  cover_pending?: boolean;
}

/** The page fields of a document read (null when it says nothing about pages). */
export function pageFieldsOf(doc: Record<string, unknown> | null | undefined): PageFields | null {
  if (!doc) return null;
  const d = doc as PageFields & Record<string, unknown>;
  return {
    editor: d.editor === "blocks" ? "blocks" : null,
    parent: d.parent && typeof d.parent === "object" ? d.parent : null,
    breadcrumbs: Array.isArray(d.breadcrumbs) ? d.breadcrumbs : [],
    children_count: typeof d.children_count === "number" ? d.children_count : 0,
    access_inherit: typeof d.access_inherit === "boolean" ? d.access_inherit : null,
    assets: withPropAssets(d.assets && typeof d.assets === "object" ? d.assets : {}, d.page),
    workspace_id: typeof d.workspace_id === "string" ? d.workspace_id : null,
    // The API's folder_path is the whole prefix (folders, then every ancestor's slug) and
    // page_path the ancestors alone; keep the folders here (links add the ancestors back).
    folder_path: foldersOnly(d.folder_path, (d as { page_path?: unknown }).page_path),
    page_path: Array.isArray((d as { page_path?: unknown }).page_path) ? ((d as { page_path: unknown[] }).page_path.filter((s) => typeof s === "string") as string[]) : [],
    props: d.page && typeof d.page === "object" ? (d.page as PageFields["props"]) : null,
    template: d.template && typeof d.template === "object" ? d.template : null,
    cover_auto: d.cover_auto === true,
    cover_pending: d.cover_pending === true,
  };
}

/** An uploaded icon or cover (`asset:<id>`) resolves like the page's other images. */
function withPropAssets(assets: Record<string, { url: string; expires_at?: string | null }>, page: unknown) {
  const out = { ...assets };
  const p = (page && typeof page === "object" ? page : {}) as Record<string, unknown>;
  for (const [key, url] of [["icon", "icon_url"], ["cover", "cover_url"]] as const) {
    const id = /^asset:([A-Za-z0-9_-]+)$/.exec(String(p[key] ?? ""))?.[1];
    if (id && typeof p[url] === "string" && !out[id]) out[id] = { url: p[url] as string };
  }
  return out;
}

function foldersOnly(full: unknown, ancestors: unknown): string[] {
  const f = Array.isArray(full) ? full.filter((s): s is string => typeof s === "string") : [];
  const a = Array.isArray(ancestors) ? ancestors.length : 0;
  return a && a <= f.length ? f.slice(0, f.length - a) : f;
}
