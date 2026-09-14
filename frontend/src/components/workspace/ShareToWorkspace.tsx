"use client";

import { useEffect, useState } from "react";
import Modal from "@/components/Modal";
import {
  can, listWorkspaces, shareToWorkspace, unshareFromWorkspace,
  type Workspace,
} from "@/lib/workspaces";

/**
 * Sharing a personal document into a workspace — and the sentence that has to
 * be read before it happens.
 *
 * Markdrop has always been a personal tool, and most documents in it were
 * written on the assumption that nobody else would see them. Sharing is
 * therefore never implicit, never a side effect of joining a workspace, and
 * never something an admin can do on your behalf. It is this dialog, which says
 * plainly who gets to read the document and who gets to change it, and then a
 * deliberate click.
 *
 * Unsharing is offered in the same place and described honestly: it hands the
 * document back, it does not delete anything, and the link keeps working.
 */
export default function ShareToWorkspace({
  documentId,
  title,
  workspaceId,
  onChanged,
  hideTrigger = false,
  open: controlledOpen,
  onOpenChange,
}: {
  documentId: string;
  title: string;
  /** The workspace it is currently shared with, or null when private. */
  workspaceId: string | null;
  onChanged: () => void;
  /** Rendered without its own button, opened by the caller — used from the
   *  dashboard's overflow menu, where the trigger is a menu item. */
  hideTrigger?: boolean;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
}) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlledOpen ?? uncontrolled;
  const setOpen = (v: boolean) => {
    setUncontrolled(v);
    onOpenChange?.(v);
  };
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || workspaces) return;
    listWorkspaces()
      .then((ws) => {
        // Viewers read a library; they don't fill it. Offering a workspace the
        // server would refuse is just a slower way to show an error.
        const usable = ws.filter((w) => can(w.role, "member"));
        setWorkspaces(usable);
        setTarget(usable[0]?.id ?? "");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load your workspaces"));
  }, [open, workspaces]);

  const current = workspaces?.find((w) => w.id === workspaceId);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      setOpen(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!hideTrigger && (
      <button
        onClick={() => setOpen(true)}
        title={workspaceId ? "Shared with a workspace" : "Share with a workspace"}
        className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
          workspaceId
            ? "border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400"
            : "border-gray-300 dark:border-gray-700 vscode:border-[#3c3c3c] text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
        }`}
      >
        {workspaceId ? "Shared" : "Share to workspace"}
      </button>
      )}

      {open && (
        <Modal
          title={workspaceId ? "Shared with a workspace" : "Share to a workspace"}
          onClose={() => !busy && setOpen(false)}
        >
          <div className="space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-400 truncate">{title}</p>

            {workspaceId ? (
              <>
                <div className="rounded-lg border border-gray-200 dark:border-gray-800 px-3 py-2.5 text-sm">
                  Shared with{" "}
                  <strong>{current?.name ?? "a workspace you're no longer in"}</strong>
                </div>
                <p className="text-xs text-gray-500 leading-relaxed">
                  Removing it puts the document back in your own library. Nothing is deleted,
                  the link keeps working, and its views and analytics stay intact.
                </p>
                <div className="flex justify-end gap-2">
                  <button onClick={() => setOpen(false)} disabled={busy}
                    className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                    Close
                  </button>
                  <button
                    onClick={() => act(() => unshareFromWorkspace(workspaceId, documentId))}
                    disabled={busy}
                    className="px-4 py-2 text-sm rounded-lg border border-red-300 dark:border-red-900/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50 font-medium transition-colors"
                  >
                    {busy ? "Removing…" : "Remove from workspace"}
                  </button>
                </div>
              </>
            ) : workspaces === null ? (
              <p className="text-sm text-gray-400">Loading your workspaces…</p>
            ) : workspaces.length === 0 ? (
              <>
                <p className="text-sm text-gray-500 leading-relaxed">
                  You aren&apos;t a member of any workspace yet — or you only have viewer access,
                  which can read a shared library but not add to it.
                </p>
                <a href="/settings/workspaces" className="text-sm text-blue-500 hover:underline">
                  Manage workspaces →
                </a>
              </>
            ) : (
              <>
                <div>
                  <label className="text-[13px] font-medium text-gray-700 dark:text-gray-300 block mb-1.5">
                    Workspace
                  </label>
                  <select
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 cursor-pointer"
                  >
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                  </select>
                </div>

                {/* The consequences, before the click — not after it. */}
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
                  <p className="text-xs font-medium text-amber-700 dark:text-amber-400 mb-1.5">
                    What sharing means
                  </p>
                  <ul className="text-xs text-amber-700/90 dark:text-amber-400/90 space-y-1 leading-relaxed">
                    <li>· Everyone in the workspace can read this document.</li>
                    <li>· Members and admins can edit it, and admins can rename or delete it.</li>
                    <li>· It stays yours — you can take it back out at any time.</li>
                  </ul>
                </div>

                <div className="flex justify-end gap-2">
                  <button onClick={() => setOpen(false)} disabled={busy}
                    className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                    Cancel
                  </button>
                  <button
                    onClick={() => act(() => shareToWorkspace(target, documentId))}
                    disabled={busy || !target}
                    className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition-colors"
                  >
                    {busy ? "Sharing…" : "Share with the workspace"}
                  </button>
                </div>
              </>
            )}

            {error && <p className="text-xs text-red-500">{error}</p>}
          </div>
        </Modal>
      )}
    </>
  );
}
