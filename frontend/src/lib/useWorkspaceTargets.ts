"use client";

import { useEffect, useState } from "react";
import { can, listFolders, listWorkspaces, type Folder, type Workspace } from "@/lib/workspaces";

export interface PublishTargetValue {
  workspaceId: string | null;
  folderId: string | null;
}

/**
 * The workspaces someone can publish into, and the folders inside the one they
 * picked.
 *
 * Extracted so the two places that offer a destination — the chip bar on /new
 * and the inline row on /upload — share one definition of *which* workspaces
 * qualify. Duplicating that rule is how the two surfaces quietly start
 * disagreeing about whether a viewer can publish.
 */
export function useWorkspaceTargets(value: PublishTargetValue) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);

  useEffect(() => {
    let cancelled = false;
    listWorkspaces()
      // A viewer reads a shared library; they don't add to it. Offering a
      // workspace the server would refuse is a slower way to show an error.
      .then((all) => { if (!cancelled) setWorkspaces(all.filter((w) => can(w.role, "member"))); })
      .catch(() => { if (!cancelled) setWorkspaces([]); });
    return () => { cancelled = true; };
  }, []);

  // Folders belong to the chosen workspace, so they load when it changes rather
  // than all up front.
  useEffect(() => {
    let cancelled = false;
    if (!value.workspaceId) { setFolders([]); return; }
    listFolders(value.workspaceId)
      .then((f) => { if (!cancelled) setFolders(f); })
      .catch(() => { if (!cancelled) setFolders([]); });
    return () => { cancelled = true; };
  }, [value.workspaceId]);

  const workspace = workspaces?.find((w) => w.id === value.workspaceId) ?? null;
  const folder = folders.find((f) => f.id === value.folderId) ?? null;

  return {
    workspaces: workspaces ?? [],
    folders,
    workspace,
    folder,
    /** False until the list has loaded, so nothing flickers into view. */
    available: (workspaces?.length ?? 0) > 0,
    /** Where this will publish, once a workspace is chosen. */
    preview: workspace
      ? `${workspace.primary_host ?? "markdrop.in"}/${[...(folder?.path ?? []), "…"].join("/")}`
      : null,
  };
}
