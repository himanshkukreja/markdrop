/**
 * Workspace and personal page templates (backend services/page_user_templates.py): save a page as
 * a template, list them for the New page gallery, preview one, rename, reorder and delete.
 * Making a page from one is `createPage({ template: <id> })` (lib/pages).
 */
import { API_BASE, getToken } from "@/lib/api";
import { PagesApiError, type AssetUrl, type PageTemplate } from "@/lib/pages";

export type TemplateScope = "workspace" | "personal";

/** A template as the gallery lists it. */
export interface UserTemplate {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** An emoji (the template's own, else the page's), or null. */
  icon: string | null;
  icon_url?: string | null;
  scope: TemplateScope;
  workspace_id: string | null;
  order: number;
  /** Sub-pages that come with it. */
  subpages: number;
  created_by?: string | null;
  updated_at?: string | null;
  excerpt: string;
  cover?: string | null;
  /** Rename and delete (its saver, or a workspace admin). */
  can_manage: boolean;
}

export interface UserTemplateFull extends UserTemplate {
  content: string;
  assets: Record<string, AssetUrl>;
}

export interface TemplateListing {
  builtin: PageTemplate[];
  workspace: UserTemplate[];
  personal: UserTemplate[];
  workspace_id: string | null;
  /** The workspace's name, for members (the section's heading). */
  workspace_name?: string | null;
  workspace_role: "owner" | "admin" | "member" | "viewer" | null;
  can_save_workspace: boolean;
  can_reorder_workspace: boolean;
  /** With `folder`: the folder and the template New page there starts from (a built-in id or a template id). */
  folder?: { id: string; name: string; default_template: string | null; can_set_default: boolean } | null;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const t = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      cache: "no-store",
      ...init,
      headers: { ...(typeof init?.body === "string" ? { "Content-Type": "application/json" } : {}), ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    });
  } catch {
    throw new PagesApiError("Couldn't reach Markdrop. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    const msg = typeof body?.detail === "string" ? body.detail : Array.isArray(body?.detail) ? "That value isn't valid." : `Request failed (${res.status})`;
    throw new PagesApiError(msg, res.status, (body as Record<string, unknown>) ?? {});
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const enc = encodeURIComponent;

/**
 * Everything the gallery offers here: built-ins, this workspace's (members and up) and yours. With
 * `parent` (Add a sub-page) the server reads the workspace and folder from that page instead.
 */
export function listTemplates(workspace?: string | null, folder?: string | null, parent?: string | null) {
  const q = new URLSearchParams();
  if (parent) q.set("parent", parent);
  else {
    if (workspace) q.set("workspace", workspace);
    if (workspace && folder) q.set("folder", folder);
  }
  return call<TemplateListing>(`/api/v1/page-templates/all${q.size ? `?${q}` : ""}`);
}

/** Admins: what New page in this folder starts from (null: blank). */
export function setFolderDefault(workspace: string, folder: string, template: string | null) {
  return call<{ folder_id: string; folder: string | null; default_template: string | null }>(
    `/api/v1/workspaces/${enc(workspace)}/folders/${enc(folder)}/default-template`,
    { method: "PUT", body: JSON.stringify({ template }) },
  );
}

/** Turn a page itself into a template, or back. */
export function setPageTemplate(slug: string, template: boolean) {
  return call<{ slug: string; template: boolean; id: string | null }>(`/api/v1/documents/${enc(slug)}/template`, { method: "PUT", body: JSON.stringify({ template }) });
}

const full = new Map<string, Promise<UserTemplateFull>>();
/** One template with its Markdown and image links (cached briefly: hover prefetches it). */
export function getTemplate(id: string, fresh = false): Promise<UserTemplateFull> {
  if (fresh || !full.has(id)) {
    const p = call<UserTemplateFull>(`/api/v1/page-templates/${enc(id)}`);
    full.set(id, p);
    p.catch(() => full.delete(id));
    setTimeout(() => full.get(id) === p && full.delete(id), 60_000);
  }
  return full.get(id)!;
}

export function saveAsTemplate(slug: string, body: { name?: string; description?: string; icon?: string | null; include_subpages?: boolean; scope?: TemplateScope; workspace?: string | null }) {
  return call<UserTemplate>(`/api/v1/documents/${enc(slug)}/save-as-template`, { method: "POST", body: JSON.stringify(body) });
}

export function updateTemplate(id: string, patch: { name?: string; description?: string; icon?: string }) {
  full.delete(id);
  return call<UserTemplate>(`/api/v1/page-templates/${enc(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function reorderTemplates(workspace: string | null, ids: string[]) {
  return call<{ templates: UserTemplate[] }>("/api/v1/page-templates/order", { method: "PUT", body: JSON.stringify({ workspace, ids }) });
}

export function deleteTemplate(id: string) {
  full.delete(id);
  return call<void>(`/api/v1/page-templates/${enc(id)}`, { method: "DELETE" });
}

/** The gallery's preview: {{author}} as the person making the page and {{folder}} as where it goes (the server fills them the same way). */
export function fillAuthor(content: string, author: string, folder?: string | null) {
  const out = content.replace(/\{\{\s*author\s*\}\}/g, author);
  return folder == null ? out : out.replace(/\{\{\s*folder\s*\}\}/g, folder);
}

/** Emoji people pick most for a template. */
export const TEMPLATE_EMOJI = ["📝", "📋", "🚀", "🧭", "🗓️", "✅", "🐞", "📣", "💡", "📚", "🤝", "🔁"];
