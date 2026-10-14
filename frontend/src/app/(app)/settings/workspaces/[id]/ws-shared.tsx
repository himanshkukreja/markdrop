"use client";

import type { ReactElement, ReactNode } from "react";
import { Tooltip } from "@/components/ui";
import type { Domain, Folder, Invitation, Member, Workspace } from "@/lib/workspaces";

/** Mirrors MAX_DEPTH in services/folder.py. The UI stops offering a parent at
 *  the limit rather than letting the server refuse the create. */
export const MAX_FOLDER_DEPTH = 8;

export type TabId = "general" | "brand" | "domains" | "people" | "folders";
export const TAB_IDS: TabId[] = ["general", "brand", "domains", "people", "folders"];

/** What every tab gets from the page: the workspace, the caller's powers and the lazily loaded collections. */
export interface WsTabProps {
  id: string;
  ws: Workspace;
  isOwner: boolean;
  isAdmin: boolean;
  isMember: boolean;
  /** The current user's id (to mark "you" and skip your own row's actions). */
  meId: string | null;
  /** The address documents are served from: primary verified app domain, as the server picks it. */
  host: string | null;
  domains: Domain[] | null;
  members: Member[] | null;
  invites: Invitation[] | null;
  folders: Folder[] | null;
  /** Direct document counts per folder id ("unfiled" for the rest), or null until loaded. */
  folderCounts: Record<string, number> | null;
  /** Re-fetch the workspace (header counts) and the given resources. */
  refresh: (...resources: Resource[]) => Promise<void>;
  /** Replace the workspace object after a PUT (avoids a refetch). */
  setWs: (w: Workspace) => void;
}

export type Resource = "domains" | "people" | "folders" | "folderCounts";

/** Which resources each tab needs. Keyed on the resource so a resource two tabs share loads once. */
export const TAB_NEEDS: Record<TabId, Resource[]> = {
  general: [],
  brand: [],
  domains: ["domains"],
  people: ["people"],
  folders: ["folders", "folderCounts"],
};

export const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };

export const ROLE_OPTIONS = [
  { value: "viewer", label: "Viewer", description: "Read what the workspace publishes" },
  { value: "member", label: "Member", description: "Create and publish documents" },
  { value: "admin", label: "Admin", description: "Manage members, domains and branding" },
] as const;

export const ADMINS_ONLY = "Admins only";

/**
 * For controls a non-admin can see but not use (REVAMP_PLAN 7.12): aria-disabled keeps them
 * focusable so the "Admins only" tooltip is reachable by keyboard, and clicks do nothing.
 */
export function lockProps(locked: boolean) {
  return locked
    ? { "aria-disabled": true as const, onClick: (e: React.MouseEvent) => e.preventDefault() }
    : {};
}

/** Wraps a control in the "Admins only" tooltip when it is locked. */
export function Locked({ locked, reason = ADMINS_ONLY, children }: { locked: boolean; reason?: string; children: ReactElement }) {
  if (!locked) return children;
  return <Tooltip content={reason}>{children}</Tooltip>;
}

/** A tab's section heading row: h2 + one line, actions on the right (wrap under on phones). */
export function SectionHead({ id, title, description, actions }: { id?: string; title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0 flex-[1_1_16rem]">
        <h2 id={id} className="text-h3 text-text">{title}</h2>
        {description && <p className="mt-0.5 text-body text-text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** URL-safe folder segment, close to the server's slugify (the server may add a suffix on a clash). */
export function folderSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "folder";
}
