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
  folder_path?: string[];
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
    assets: d.assets && typeof d.assets === "object" ? d.assets : {},
    workspace_id: typeof d.workspace_id === "string" ? d.workspace_id : null,
    folder_path: Array.isArray(d.folder_path) ? d.folder_path : [],
  };
}
