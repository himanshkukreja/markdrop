"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PublishWorkspace } from "@/components/kit/publish-utils";
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
    // Signed out there is nothing to list; asking anyway only produced a 401 on every visit.
    let signedIn = false;
    try { signedIn = !!localStorage.getItem("markdrop_token"); } catch {}
    if (!signedIn) { setWorkspaces([]); return; }
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

  // What PublishSettings takes: hosts, default access, and folders labelled by their names from
  // the root ("Guides › Onboarding"), depth-first, so two "Drafts" folders can be told apart.
  const publishWorkspaces = useMemo<PublishWorkspace[]>(() => {
    const byId = new Map(folders.map((f) => [f.id, f]));
    const names = (f: Folder) => {
      const out: string[] = [];
      let cur: Folder | undefined = f;
      let guard = 0;
      while (cur && guard++ < 16) { out.unshift(cur.name); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined; }
      return out;
    };
    const labelled = folders
      .map((f) => ({ id: f.id, name: f.name, path: f.path, label: names(f).join(" › ") }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return (workspaces ?? []).map((w) => ({
      id: w.id,
      name: w.name,
      host: w.primary_host ?? null,
      defaultAccess: w.default_access ?? null,
      folders: w.id === value.workspaceId ? labelled : undefined,
    }));
  }, [workspaces, folders, value.workspaceId]);

  return {
    workspaces: workspaces ?? [],
    publishWorkspaces,
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

/**
 * "New document here" / "Upload here" (`/new?ws=&folder=`, `/upload?ws=&folder=`): start in that
 * workspace folder, with the workspace's default access, once the workspace list has loaded. Runs
 * once; a workspace the person can't publish into is ignored rather than half-applied.
 */
export function usePrefilledTarget(
  ready: boolean,
  wsId: string | null,
  folderId: string | null,
  workspaces: Workspace[],
  apply: (target: PublishTargetValue, defaultAccess: "private" | "link" | "workspace" | null) => void,
) {
  const done = useRef(false);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    if (!ready || done.current || !wsId) return;
    const w = workspaces.find((x) => x.id === wsId);
    if (!w) return;
    done.current = true;
    applyRef.current({ workspaceId: w.id, folderId: folderId || null }, w.default_access ?? null);
  }, [ready, wsId, folderId, workspaces]);
}
