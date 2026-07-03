"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { listApiTokens, createApiToken, revokeApiToken, ApiTokenItem } from "@/lib/api";
import Modal from "@/components/Modal";

export default function TokensPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [tokens, setTokens] = useState<ApiTokenItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setTokens(await listApiTokens()); } catch { /* redirect below */ } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { router.replace("/login?next=/settings/tokens"); return; }
    load();
  }, [authLoading, user, router, load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const t = await createApiToken(newName.trim() || "API token");
      setFreshToken(t.token);
      setNewName("");
      load();
    } catch { /* ignore */ } finally { setCreating(false); }
  }

  async function doRevoke() {
    if (!revokeId) return;
    try { await revokeApiToken(revokeId); setTokens((t) => t.filter((x) => x.id !== revokeId)); } catch { /* ignore */ }
    setRevokeId(null);
  }

  if (authLoading || (!user && loading)) {
    return <div className="flex-1 flex items-center justify-center text-sm text-gray-400">Loading…</div>;
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto max-w-2xl mx-auto w-full">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-bold">API tokens</h1>
        <a href="/dashboard" className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">← Dashboard</a>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
        Tokens let the Markdrop VS Code extension sync documents to your account. Keep them secret; revoke anytime.
      </p>

      <form onSubmit={create} className="flex gap-2 mb-5">
        <input
          value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80}
          placeholder="Token name (e.g. My laptop)"
          className="flex-1 bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition-colors"
        />
        <button type="submit" disabled={creating} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium transition-colors">
          {creating ? "Creating…" : "Create token"}
        </button>
      </form>

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : tokens.length === 0 ? (
        <div className="text-center py-12 text-sm text-gray-500 dark:text-gray-400 border border-dashed border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] rounded-xl">
          No tokens yet.
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] divide-y divide-gray-100 dark:divide-gray-800 vscode:divide-[#3c3c3c]">
          {tokens.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{t.name}</p>
                <p className="text-xs text-gray-400 font-mono">{t.prefix}••••••••</p>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  Created {new Date(t.created_at).toLocaleDateString()} ·{" "}
                  {t.last_used_at ? `last used ${new Date(t.last_used_at).toLocaleDateString()}` : "never used"}
                </p>
              </div>
              <button onClick={() => setRevokeId(t.id)} className="shrink-0 text-xs text-red-500 hover:text-red-600 px-2 py-1 rounded hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors">
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Fresh token modal — shown once */}
      {freshToken && (
        <Modal title="Copy your token now" onClose={() => setFreshToken(null)}>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">This is the only time the full token is shown. Paste it into the VS Code extension.</p>
          <div className="flex items-center gap-2 bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg px-3 py-2.5">
            <code className="flex-1 text-xs font-mono break-all text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4]">{freshToken}</code>
            <button
              onClick={() => { navigator.clipboard.writeText(freshToken); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              className="shrink-0 px-2.5 py-1 text-xs rounded-md bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <div className="flex justify-end mt-4">
            <button onClick={() => setFreshToken(null)} className="px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Done</button>
          </div>
        </Modal>
      )}

      {/* Revoke confirm */}
      {revokeId && (
        <Modal title="Revoke token?" onClose={() => setRevokeId(null)}>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">Any VS Code extension using this token will stop syncing. This cannot be undone.</p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setRevokeId(null)} className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
            <button onClick={doRevoke} className="px-4 py-2 text-sm rounded-lg bg-red-600 hover:bg-red-500 text-white font-medium transition-colors">Revoke</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
