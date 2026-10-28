/**
 * Workspace items (v2 `GET /workspaces/{id}/items`) shaped for the dashboard's DocRow, which was
 * written for personal rows (MyDocListItem), and the simpler UI's access vocabulary. Plain module:
 * no React.
 */
import type { MyDocListItem } from "@/lib/api";
import type { ItemAccess, Workspace, WorkspaceItem } from "@/lib/workspaces";

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

export const itemTitle = (it: Pick<WorkspaceItem, "encrypted" | "title" | "original_filename" | "slug">) =>
  (it.encrypted ? it.slug : it.title?.trim() || it.original_filename || it.slug);

/* ── The access vocabulary (simpler UI): one set of words everywhere ─────── */

/** The short name a workspace's team goes by: its site name ("Acme"), else its name. */
export function teamName(ws: { name: string; branding?: Partial<Workspace["branding"]> | null } | null | undefined, fallback = "Workspace"): string {
  return ws?.branding?.site_name?.trim() || ws?.name || fallback;
}

export const ACCESS_ICON: Record<ItemAccess, string> = { private: "lock", workspace: "user", link: "globe" };

/** "Only people added" · "{Team} team" · "Anyone with the link". Words and an icon, never colour alone. */
export function accessLabel(access: ItemAccess, team: string | null | undefined): string {
  if (access === "private") return "Only people added";
  if (access === "workspace") return team ? `${team} team` : "Workspace team";
  return "Anyone with the link";
}

/** Who can open it, in words (kept for callers that pass a workspace name and a password flag). */
export function accessWords(access: ItemAccess, workspaceName: string, hasPassword?: boolean): string {
  if (access === "link" && hasPassword) return "Anyone with the link and the password";
  return accessLabel(access, workspaceName);
}

/** UI role labels (the backend's roles are unchanged): viewer → Can view, member → Can edit. */
export const ROLE_WORDS: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Can edit", viewer: "Can view" };

export const ROLE_HINT = "Can view: read. Can edit: add and change files. Admin: also invite people and manage folders.";

/** The address shown under a row: the canonical URL without its scheme. */
export function displayAddress(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url.replace(/^https?:\/\//, "");
  }
}
