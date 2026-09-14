"use client";

import { useCallback, useEffect, useState } from "react";
import Modal from "@/components/Modal";
import { useToast } from "@/components/Toast";
import {
  addPerson, getAccess, removePerson, setAccessLevel, setResharing,
  type AccessLevel, type AccessState,
} from "@/lib/access";

/**
 * Who can open this document, and who has been named on it.
 *
 * Two controls, deliberately kept apart because they answer different
 * questions. **Level** is how the document is reachable by people nobody named:
 * private, anyone with the link, or the workspace it lives in. **People** is a
 * list of named addresses, layered on top — which is why "anyone with the link
 * can read, and these three can edit" needs no extra mode.
 *
 * The permission rules are not re-implemented here. The server returns
 * `can_manage` and `can_share`, and this only renders what they allow; a client
 * that decided for itself would eventually decide differently.
 */

const LEVELS: { id: AccessLevel; label: string; hint: string; icon: React.ReactNode }[] = [
  {
    id: "private", label: "Only people I choose",
    hint: "Nobody can open it unless they're on the list below.",
    icon: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  },
  {
    id: "link", label: "Anyone with the link",
    hint: "No sign-in needed. This is how Markdrop links have always worked.",
    icon: <><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></>,
  },
  {
    id: "workspace", label: "Everyone in the workspace",
    hint: "Members of the workspace this document is shared into.",
    icon: <><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9.5" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /></>,
  },
];

function Icon({ d, className = "w-4 h-4" }: { d: React.ReactNode; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
  );
}

function initials(s: string) {
  return s.trim().slice(0, 2).toUpperCase() || "?";
}

export default function ShareDialog({
  slug, title, onClose, onChanged,
}: {
  slug: string;
  title: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const toast = useToast();
  const [state, setState] = useState<AccessState | null>(null);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [notify, setNotify] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try { setState(await getAccess(slug)); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load sharing"); }
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, after?: () => void) {
    setBusy(key); setError("");
    try { await fn(); await load(); onChanged?.(); after?.(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(""); }
  }

  async function invite() {
    const to = email.trim();
    if (!to) return;
    await run("add", async () => {
      const g = await addPerson(slug, to, role, notify, message.trim() || undefined);
      // Says what actually happened rather than what was requested: a grant is
      // real whether or not its email left the building.
      toast.success(
        notify && g.notified ? `Shared with ${to} and emailed them.`
        : notify ? `Shared with ${to}, but the email didn't send.`
        : `Shared with ${to}.`
      );
      setEmail(""); setMessage("");
    });
  }

  const canManage = state?.can_manage ?? false;
  const canShare = state?.can_share ?? false;
  const levels = LEVELS.filter((l) => l.id !== "workspace" || state?.in_workspace);

  return (
    <Modal title="Share" onClose={onClose}>
      <div className="space-y-5">
        <p className="-mt-1 truncate text-sm text-gray-500 dark:text-gray-400">{title}</p>

        {error && <p className="text-sm text-red-500">{error}</p>}
        {!state ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : (
          <>
            {/* An encrypted document cannot be unlocked by a permission — the
                key is in the link's fragment and never reached the server. */}
            {state.encrypted && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
                This document is end-to-end encrypted. These settings control who can
                <em> fetch </em> it, but the key lives in the link — anyone you share with
                needs the full URL, including everything after the <span className="font-mono">#</span>.
              </div>
            )}

            {/* ── Who can open it ─────────────────────────────────────────── */}
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                Who can open it
              </p>
              <div className="space-y-1.5">
                {levels.map((l) => {
                  const active = state.level === l.id;
                  return (
                    <button
                      key={l.id}
                      disabled={!canManage || busy === "level"}
                      onClick={() => run("level", () => setAccessLevel(slug, l.id),
                        () => toast.success("Visibility updated."))}
                      className={`flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                        active
                          ? "border-blue-500/45 bg-blue-500/10"
                          : "border-gray-200 dark:border-white/[0.08] hover:bg-gray-50 dark:hover:bg-white/[0.04]"
                      }`}
                    >
                      <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg ${
                        active ? "bg-blue-500/20 text-blue-300" : "bg-gray-100 dark:bg-white/[0.06] text-gray-500"
                      }`}>
                        <Icon d={l.icon} className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0">
                        <span className={`block text-[13px] font-medium ${active ? "text-blue-700 dark:text-blue-200" : "text-gray-800 dark:text-gray-200"}`}>
                          {l.label}
                        </span>
                        <span className="mt-0.5 block text-[11.5px] leading-snug text-gray-500 dark:text-gray-400">
                          {l.hint}
                        </span>
                      </span>
                      {active && <span className="ml-auto mt-1 h-2 w-2 shrink-0 rounded-full bg-blue-400" />}
                    </button>
                  );
                })}
              </div>
              {state.is_password_protected && (
                <p className="mt-2 text-[11.5px] text-gray-500 dark:text-gray-400">
                  A password is also set, so readers are asked for it either way.
                </p>
              )}
              {!canManage && (
                <p className="mt-2 text-[11.5px] text-gray-400">
                  Only the owner can change who this is visible to.
                </p>
              )}
            </div>

            {/* ── Named people ────────────────────────────────────────────── */}
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                People with access
              </p>

              {canShare && (
                <div className="mb-3 space-y-2">
                  <div className="flex gap-2">
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") invite(); }}
                      placeholder="name@company.com"
                      className="min-w-0 flex-1 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 py-2 text-sm outline-none focus:border-blue-500 transition-colors"
                    />
                    <select
                      value={role}
                      onChange={(e) => setRole(e.target.value as "viewer" | "editor")}
                      className="shrink-0 cursor-pointer rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-2 py-2 text-sm outline-none focus:border-blue-500"
                    >
                      <option value="viewer">Can view</option>
                      {/* A delegate cannot grant above their own level, so the
                          option is hidden rather than shown and then refused. */}
                      {(canManage || state.your_role === "editor") && <option value="editor">Can edit</option>}
                    </select>
                  </div>
                  {notify && (
                    <input
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder="Add a message (optional)"
                      maxLength={500}
                      className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 py-2 text-[13px] outline-none focus:border-blue-500 transition-colors"
                    />
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-gray-600 dark:text-gray-400">
                      <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)}
                             className="accent-blue-600" />
                      Email them
                    </label>
                    <button
                      onClick={invite}
                      disabled={!email.trim() || busy === "add"}
                      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-40"
                    >
                      {busy === "add" ? "Sharing…" : "Share"}
                    </button>
                  </div>
                </div>
              )}

              <div className="divide-y divide-gray-100 dark:divide-white/[0.06] rounded-xl border border-gray-200 dark:border-white/[0.08]">
                <div className="flex items-center gap-2.5 px-3 py-2.5">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-blue-600 text-[10px] font-bold text-white">
                    {initials(title)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-gray-800 dark:text-gray-200">
                    Owner
                  </span>
                  <span className="shrink-0 text-[11.5px] text-gray-400">Full access</span>
                </div>

                {state.grants.length === 0 ? (
                  <p className="px-3 py-3 text-[12.5px] text-gray-400">
                    Nobody yet. {state.level === "link" ? "Anyone with the link can already read it." : ""}
                  </p>
                ) : (
                  state.grants.map((g) => (
                    <div key={g.email} className="flex items-center gap-2.5 px-3 py-2.5">
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gray-200 dark:bg-white/[0.09] text-[10px] font-bold text-gray-600 dark:text-gray-300">
                        {initials(g.email)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-gray-800 dark:text-gray-200">{g.email}</span>
                        {!g.notified && (
                          <span className="text-[11px] text-gray-400">added without an email</span>
                        )}
                      </span>
                      <span className="shrink-0 text-[11.5px] text-gray-500 dark:text-gray-400">
                        {g.role === "editor" ? "Can edit" : "Can view"}
                      </span>
                      {(canManage || g.email === state.your_email) && (
                        <button
                          disabled={busy === g.email}
                          onClick={() => run(g.email, () => removePerson(slug, g.email),
                            () => toast.success(`Removed ${g.email}.`))}
                          className="shrink-0 rounded px-1.5 text-[11.5px] text-gray-400 transition-colors hover:text-red-500"
                        >
                          {busy === g.email ? "…" : "Remove"}
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>

              {canManage && (
                <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-[12.5px] text-gray-600 dark:text-gray-400">
                  <input
                    type="checkbox"
                    checked={state.allow_resharing}
                    disabled={busy === "resharing"}
                    onChange={(e) => run("resharing", () => setResharing(slug, e.target.checked))}
                    className="mt-0.5 accent-blue-600"
                  />
                  <span>
                    Let people I share with add others
                    <span className="block text-[11.5px] text-gray-400">
                      They can never give more access than they have themselves.
                    </span>
                  </span>
                </label>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
