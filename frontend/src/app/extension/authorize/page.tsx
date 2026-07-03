"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { createApiToken } from "@/lib/api";

function AuthorizeInner() {
  const params = useSearchParams();
  const { user, loading } = useAuth();
  const state = params.get("state") || "";
  const redirect = params.get("redirect") || "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const validRedirect = redirect.startsWith("vscode://") || redirect.startsWith("vscode-insiders://");

  if (loading) {
    return <p className="text-sm text-gray-400">Loading…</p>;
  }

  if (!user) {
    // Preserve the whole authorize URL so we return here after login.
    const next = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/extension/authorize";
    if (typeof window !== "undefined") window.location.href = `/login?next=${encodeURIComponent(next)}`;
    return <p className="text-sm text-gray-400">Redirecting to sign in…</p>;
  }

  async function authorize() {
    if (!validRedirect) { setError("Invalid redirect target."); return; }
    setBusy(true); setError("");
    try {
      const tok = await createApiToken("VS Code");
      const sep = redirect.includes("?") ? "&" : "?";
      const url = `${redirect}${sep}token=${encodeURIComponent(tok.token)}&state=${encodeURIComponent(state)}`;
      setDone(true);
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to authorize");
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm mx-auto text-center">
      <div className="text-4xl mb-3">🔌</div>
      <h1 className="text-xl font-bold mb-1">Connect VS Code</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        Authorize the Markdrop extension to sync documents to your account
        (<span className="font-medium text-gray-700 dark:text-gray-200">{user.email}</span>).
      </p>

      {!validRedirect && (
        <div className="mb-4 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          This page is meant to be opened from the VS Code extension.
        </div>
      )}
      {error && <div className="mb-4 text-sm text-red-500">{error}</div>}

      {done ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Opening VS Code… you can close this tab.</p>
      ) : (
        <button
          onClick={authorize}
          disabled={busy || !validRedirect}
          className="w-full px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          {busy ? "Authorizing…" : "Authorize VS Code"}
        </button>
      )}
      <p className="mt-4 text-xs text-gray-400">
        This creates a revocable API token you can remove anytime in <a href="/settings/tokens" className="text-blue-500 hover:underline">Settings → API tokens</a>.
      </p>
    </div>
  );
}

export default function AuthorizePage() {
  return (
    <div className="flex-1 flex items-center justify-center py-10">
      <Suspense fallback={null}>
        <AuthorizeInner />
      </Suspense>
    </div>
  );
}
