"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import MarkdropLoader from "@/components/MarkdropLoader";
import { createWorkspace, listWorkspaces, type Workspace } from "@/lib/workspaces";

export default function WorkspacesPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    listWorkspaces()
      .then(setWorkspaces)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { router.replace("/login?next=/settings/workspaces"); return; }
    load();
  }, [authLoading, user, router, load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const w = await createWorkspace(name.trim());
      router.push(`/settings/workspaces/${w.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the workspace");
      setBusy(false);
    }
  }

  if (authLoading || (!user && loading)) {
    return (
      <div className="flex-1 min-h-[60vh] flex items-center justify-center">
        <MarkdropLoader label="Loading your settings…" />
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto max-w-2xl mx-auto w-full">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-bold">Workspaces</h1>
        <a href="/dashboard" className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">← Dashboard</a>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
        A workspace holds your own domains, branding and team. Documents outside a workspace keep
        working exactly as they do now.
      </p>

      <form onSubmit={create} className="flex gap-2 mb-5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          placeholder="Workspace name (e.g. Senseloaf)"
          className="flex-1 bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition-colors"
        />
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          {busy ? "Creating…" : "Create"}
        </button>
      </form>

      {error && <p className="text-sm text-red-500 mb-4">{error}</p>}

      {loading ? (
        <div className="py-6 flex justify-center">
          <MarkdropLoader label="Loading workspaces…" size="sm" />
        </div>
      ) : workspaces.length === 0 ? (
        <div className="text-center py-12 text-sm text-gray-500 dark:text-gray-400 border border-dashed border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] rounded-xl">
          No workspaces yet. Create one to use your own domain and branding.
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] divide-y divide-gray-100 dark:divide-gray-800 vscode:divide-[#3c3c3c]">
          {workspaces.map((w) => (
            <a
              key={w.id}
              href={`/settings/workspaces/${w.id}`}
              className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-900/40 transition-colors"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{w.name}</p>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  {w.branding.site_name ? `Branded as “${w.branding.site_name}” · ` : ""}
                  Created {new Date(w.created_at).toLocaleDateString()}
                </p>
              </div>
              <span className="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 vscode:bg-[#2d2d2d] text-gray-500 dark:text-gray-400 capitalize">
                {w.role}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
