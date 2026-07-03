"use client";

import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { updateMyName } from "@/lib/api";
import Modal from "@/components/Modal";

/**
 * Shown once after login for accounts with no display name (passwordless email
 * signups — Google logins already provide a name). Global; rendered in layout.
 */
export default function NamePrompt() {
  const { user, loading, updateUser } = useAuth();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (loading || !user || user.name || dismissed) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const updated = await updateMyName(name.trim());
      updateUser(updated);
    } catch {
      /* keep the prompt open on failure */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="What should we call you?" onClose={() => setDismissed(true)}>
      <form onSubmit={save} className="space-y-3">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Add a display name for your account. You can change it later.
        </p>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          placeholder="Your name"
          className="w-full bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg px-3 py-2.5 text-sm text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] outline-none focus:border-blue-500 transition-colors"
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => setDismissed(true)} className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors">
            Skip
          </button>
          <button type="submit" disabled={busy || !name.trim()} className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition-colors">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
