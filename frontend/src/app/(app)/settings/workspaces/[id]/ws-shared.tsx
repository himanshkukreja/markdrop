"use client";

import type { ReactElement } from "react";
import { Tooltip } from "@/components/ui";
import type { Domain, Invitation, Member, Workspace } from "@/lib/workspaces";

/** Mirrors MAX_DEPTH in services/folder.py. The UI stops offering a parent at
 *  the limit rather than letting the server refuse the create. */
export const MAX_FOLDER_DEPTH = 8;

export type TabId = "people" | "look" | "advanced";
export const TAB_IDS: TabId[] = ["people", "look", "advanced"];

/** Old `?tab=` names (before the simpler settings) and where they live now. "folders" isn't a tab
 *  any more: it opens the workspace's folder view. */
export const OLD_TABS: Record<string, TabId | "folders"> = {
  general: "look", brand: "look", domains: "look", people: "people", folders: "folders",
};

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
  /** Re-fetch the workspace (header counts) and the given resources. */
  refresh: (...resources: Resource[]) => Promise<void>;
  /** Replace the workspace object after a PUT (avoids a refetch). */
  setWs: (w: Workspace) => void;
}

export type Resource = "domains" | "people";

/** Which resources each tab needs. Keyed on the resource so a resource two tabs share loads once. */
export const TAB_NEEDS: Record<TabId, Resource[]> = {
  people: ["people"],
  look: ["domains"],
  advanced: [],
};

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

/**
 * The same for a native select: aria-disabled, and neither the pointer nor the keyboard opens it or
 * changes its value (Tab still moves on, so the tooltip is reachable). Inputs use readOnly instead.
 */
export function lockSelectProps(locked: boolean) {
  return locked
    ? {
        "aria-disabled": true as const,
        onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
        onKeyDown: (e: React.KeyboardEvent) => { if (e.key !== "Tab" && e.key !== "Escape") e.preventDefault(); },
      }
    : {};
}

/** Wraps a control in the "Admins only" tooltip when it is locked. */
export function Locked({ locked, reason = ADMINS_ONLY, className, children }: { locked: boolean; reason?: string; className?: string; children: ReactElement }) {
  if (!locked) return children;
  return <Tooltip content={reason} className={className}>{children}</Tooltip>;
}

/** URL-safe folder segment (one implementation, `lib/folderSlug.ts`, mirroring the server). */
export { folderSlug } from "@/lib/folderSlug";
