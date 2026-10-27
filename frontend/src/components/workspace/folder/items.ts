/**
 * Workspace items (v2 `GET /workspaces/{id}/items`) shaped for the dashboard's DocRow, which was
 * written for personal rows (MyDocListItem). Plain module: no React.
 */
import type { MyDocListItem } from "@/lib/api";
import type { ItemAccess, WorkspaceItem } from "@/lib/workspaces";

export function toDocRow(it: WorkspaceItem, workspaceId: string): MyDocListItem {
  return {
    id: it.id ?? it.slug,
    slug: it.slug,
    url: it.markdrop_url || it.url,
    title: it.title,
    content_preview: "",
    created_at: it.created_at ?? it.updated_at,
    updated_at: it.updated_at,
    expires_at: null,
    views: it.views ?? 0,
    export_pdf_count: 0,
    copy_url_count: 0,
    is_password_protected: !!it.has_password,
    encrypted: !!it.encrypted,
    kind: it.kind,
    mime: it.mime ?? null,
    renderer: (it.renderer as MyDocListItem["renderer"]) ?? null,
    size_bytes: it.size_bytes ?? null,
    original_filename: it.original_filename ?? null,
    workspace_id: workspaceId,
    folder_id: it.folder?.id ?? null,
    folder_path: it.folder?.path ? it.folder.path.split("/").filter(Boolean) : [],
    access_level: it.access,
    is_mine: it.owner.is_you,
    shared_by_name: it.owner.name,
  };
}

export const itemTitle = (it: WorkspaceItem) => (it.encrypted ? it.slug : it.title?.trim() || it.original_filename || it.slug);

/** Who can open it, in words (never colour alone). */
export function accessWords(access: ItemAccess, workspaceName: string, hasPassword?: boolean): string {
  if (access === "private") return "Only people they choose";
  if (access === "workspace") return `Everyone in ${workspaceName}`;
  return hasPassword ? "Anyone with the link and password" : "Anyone with the link";
}

/** The address shown under a row: the canonical URL without its scheme. */
export function displayAddress(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url.replace(/^https?:\/\//, "");
  }
}
