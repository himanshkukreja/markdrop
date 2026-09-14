"use client";

import { useEffect, useState } from "react";
import { can, listFolders, listWorkspaces, type Folder, type Workspace } from "@/lib/workspaces";

export interface PublishTargetValue {
  workspaceId: string | null;
  folderId: string | null;
}

/**
 * Where a new document should go: private, or into a workspace and a folder.
 *
 * Offered at creation because that is when the decision is actually made.
 * Sharing afterwards from the dashboard still works and always will, but
 * "publish it, then go somewhere else and file it" is two jobs for what the
 * author already knew when they hit the button.
 *
 * Private stays the default, and is what anyone signed out or workspace-less
 * sees — this renders nothing at all for them, rather than a disabled control
 * advertising a feature they don't have.
 *
 * Folders are part of the address, so the picker shows the path that will
 * result rather than just a folder name: the consequence of the choice is a URL,
 * and that URL should be visible before the choice is made.
 */
export default function PublishTarget({
  value,
  onChange,
  disabled,
}: {
  value: PublishTargetValue;
  onChange: (next: PublishTargetValue) => void;
  disabled?: boolean;
}) {
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

  // Folders belong to the chosen workspace, so they're fetched when it changes
  // rather than all up front.
  useEffect(() => {
    let cancelled = false;
    if (!value.workspaceId) { setFolders([]); return; }
    listFolders(value.workspaceId)
      .then((f) => { if (!cancelled) setFolders(f); })
      .catch(() => { if (!cancelled) setFolders([]); });
    return () => { cancelled = true; };
  }, [value.workspaceId]);

  // Nothing to choose between: render nothing rather than an empty control.
  if (!workspaces || workspaces.length === 0) return null;

  const workspace = workspaces.find((w) => w.id === value.workspaceId) || null;
  const folder = folders.find((f) => f.id === value.folderId) || null;
  const host = workspace?.primary_host;

  const preview = workspace
    ? `${host ?? "markdrop.in"}/${[...(folder?.path ?? []), "…"].join("/")}`
    : null;

  const select =
    "text-xs bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-md px-2 py-1 text-gray-700 dark:text-gray-300 outline-none focus:border-blue-500 transition-colors cursor-pointer disabled:opacity-50";

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <label className="text-xs text-gray-500 dark:text-gray-400">Publish to</label>

      <select
        className={select}
        disabled={disabled}
        value={value.workspaceId ?? ""}
        onChange={(e) =>
          // Changing workspace must drop the folder: folder ids are scoped to a
          // workspace, and carrying one across would be rejected on save.
          onChange({ workspaceId: e.target.value || null, folderId: null })
        }
      >
        <option value="">Just me (private)</option>
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>{w.name}</option>
        ))}
      </select>

      {value.workspaceId && (
        <select
          className={select}
          disabled={disabled}
          value={value.folderId ?? ""}
          onChange={(e) => onChange({ ...value, folderId: e.target.value || null })}
        >
          <option value="">No folder</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>{f.path.join(" / ") || f.name}</option>
          ))}
        </select>
      )}

      {preview && (
        <span className="text-[11px] font-mono text-gray-400 truncate max-w-[240px]" title={preview}>
          {preview}
        </span>
      )}

      {value.workspaceId && (
        <span className="text-[11px] text-amber-600 dark:text-amber-400">
          Everyone in the workspace can read it.
        </span>
      )}
    </div>
  );
}
