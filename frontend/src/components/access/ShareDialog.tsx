"use client";

import { useCallback, useEffect, useState } from "react";
import Modal from "@/components/Modal";
import { useToast } from "@/components/Toast";
import {
  addPerson, getAccess, removePerson, setAccessLevel, setResharing,
  type AccessLevel, type AccessState,
} from "@/lib/access";
import { useWorkspaceTargets, type PublishTargetValue } from "@/lib/useWorkspaceTargets";
import { listMembers, shareToWorkspace, type Member } from "@/lib/workspaces";

/**
 * Who can open this document, and who has been named on it.
 *
 * Two controls, deliberately kept apart because they answer different
 * questions. **People** is a list of named addresses. **General access** is how
 * the document is reachable by everyone nobody named: private, anyone with the
 * link, or the workspace it lives in. The list is layered *on top* of the
 * level, which is why "anyone with the link can read, and these three can edit"
 * needs no extra mode.
 *
 * People comes first and general access is one line, because that ordering is
 * how often each is used. An earlier version led with three large cards for the
 * level, then a workspace box, then a message field, then a checkbox, and only
 * then the address input — so the thing people opened this dialog to do was the
 * last thing they could reach. Everything optional is now folded away until the
 * moment it applies; nothing was removed to get there.
 *
 * The permission rules are not re-implemented here. The server returns
 * `can_manage` and `can_share`, and this only renders what they allow; a client
 * that decided for itself would eventually decide differently.
 */

const LEVELS: { id: AccessLevel; label: string; hint: string; icon: React.ReactNode }[] = [
  {
    id: "private", label: "Only people I choose",
    hint: "Nobody can open it unless they're on the list above.",
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

/**
 * Two letters for an avatar.
 *
 * The domain is dropped before splitting, because it is not part of anybody's
 * name: `newcomer@outside.com` split whole gives N and O, and an avatar reading
 * "NO" next to someone's address looks like a verdict on them. Only the local
 * part is ever initialised, so that address gives "N" and `john.doe@…` gives
 * "JD".
 */
function initials(s: string) {
  const local = s.trim().split("@")[0] || s.trim();
  const words = local.split(/[\s._-]+/).filter(Boolean);
  return (words.slice(0, 2).map((w) => w[0]).join("") || "?").toUpperCase();
}

function Avatar({ name, accent = false }: { name: string; accent?: boolean }) {
  return (
    <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-bold ${
      accent
        ? "bg-blue-600 text-white"
        : "bg-gray-200 dark:bg-white/[0.09] text-gray-600 dark:text-gray-300"
    }`}>
      {initials(name)}
    </span>
  );
}

export default function ShareDialog({
  slug, title, documentId, onClose, onChanged,
}: {
  slug: string;
  title: string;
  /** Needed to put the document into a workspace from here. Without it the
   *  workspace option is hidden rather than shown and then failing. */
  documentId?: string | null;
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
  const [showMessage, setShowMessage] = useState(false);
  const [busy, setBusy] = useState("");
  // Putting a document *into* a workspace used to be a separate modal reached
  // from a different menu item, which meant "everyone in the workspace" was an
  // option you could only pick if you had already used the other one. It lives
  // here now, where the question is asked — but only once it is asked.
  const [wantWorkspace, setWantWorkspace] = useState(false);
  const [wsTarget, setWsTarget] = useState<PublishTargetValue>({ workspaceId: null, folderId: null });
  const ws = useWorkspaceTargets(wsTarget);
  // Teammates, offered as suggestions. Sharing with a colleague should not
  // require remembering how their address is spelled.
  const [members, setMembers] = useState<Member[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const load = useCallback(async () => {
    try { setState(await getAccess(slug)); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load sharing"); }
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  // Only for a document that lives in a workspace — that is the only set of
  // people we can name without leaking who else uses Markdrop.
  useEffect(() => {
    const id = state?.workspace_id;
    if (!id) return;
    let cancelled = false;
    listMembers(id)
      .then((m) => { if (!cancelled) setMembers(m); })
      .catch(() => { /* suggestions are a convenience, never a blocker */ });
    return () => { cancelled = true; };
  }, [state?.workspace_id]);

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
      setEmail(""); setMessage(""); setShowMessage(false);
    });
  }

  const already = new Set((state?.grants ?? []).map((g) => g.email));
  const q = email.trim().toLowerCase();
  const suggestions = members
    .filter((m) => m.email && !already.has(m.email.toLowerCase()))
    .filter((m) => !q || (m.email ?? "").toLowerCase().includes(q)
                      || (m.name ?? "").toLowerCase().includes(q))
    .slice(0, 6);

  const canManage = state?.can_manage ?? false;
  const canShare = state?.can_share ?? false;
  // Offered once the document is in a workspace, or once one can be chosen.
  const canOfferWorkspace = state?.in_workspace || (canManage && !!documentId && ws.available);
  const levels = LEVELS.filter((l) => l.id !== "workspace" || canOfferWorkspace);
  // `wantWorkspace` is a level the user has asked for but that cannot be set
  // yet: the server refuses "workspace" for a document that is not in one. The
  // select shows their choice while the picker below collects what is missing.
  const shownLevel: AccessLevel = wantWorkspace ? "workspace" : (state?.level ?? "link");
  const active = LEVELS.find((l) => l.id === shownLevel) ?? LEVELS[1];

  function chooseLevel(next: AccessLevel) {
    if (!state || next === shownLevel) return;
    if (next === "workspace" && !state.in_workspace) { setWantWorkspace(true); return; }
    setWantWorkspace(false);
    run("level", () => setAccessLevel(slug, next), () => toast.success("Visibility updated."));
  }

  async function moveIntoWorkspace() {
    if (!documentId || !wsTarget.workspaceId) return;
    await run("workspace", async () => {
      await shareToWorkspace(wsTarget.workspaceId!, documentId, wsTarget.folderId, slug);
      await setAccessLevel(slug, "workspace");
      setWantWorkspace(false);
      toast.success("Shared with the workspace.");
    });
  }

  const label = "text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500";
  const field = "rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-sm outline-none focus:border-blue-500 transition-colors";

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

            {/* ── People ──────────────────────────────────────────────────── */}
            {canShare && (
              <div className="space-y-2">
                <div className="relative flex gap-2">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); setPickerOpen(true); }}
                    onFocus={() => setPickerOpen(true)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { setPickerOpen(false); invite(); }
                      if (e.key === "Escape") setPickerOpen(false);
                    }}
                    placeholder={suggestions.length ? "Add people by name or email" : "Add people by email"}
                    autoComplete="off"
                    className={`min-w-0 flex-1 px-3 py-2 ${field}`}
                  />
                  {pickerOpen && suggestions.length > 0 && (
                    <ul
                      role="listbox"
                      className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 max-h-52 overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 py-1 shadow-2xl"
                    >
                      {suggestions.map((m) => (
                        <li key={m.user_id}>
                          <button
                            type="button"
                            onClick={() => { setEmail(m.email ?? ""); setPickerOpen(false); }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-white/[0.06]"
                          >
                            <Avatar name={m.name || m.email || "?"} />
                            <span className="min-w-0">
                              <span className="block truncate text-[13px] text-gray-800 dark:text-gray-200">
                                {m.name || m.email}
                              </span>
                              {m.name && (
                                <span className="block truncate text-[11px] text-gray-400">{m.email}</span>
                              )}
                            </span>
                            <span className="ml-auto shrink-0 text-[10.5px] capitalize text-gray-400">{m.role}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value as "viewer" | "editor")}
                    className={`shrink-0 cursor-pointer px-2 py-2 ${field}`}
                  >
                    <option value="viewer">Can view</option>
                    {/* A delegate cannot grant above their own level, so the
                        option is hidden rather than shown and then refused. */}
                    {(canManage || state.your_role === "editor") && <option value="editor">Can edit</option>}
                  </select>
                </div>

                {/* Everything about *how* the invitation is sent stays out of
                    the way until there is an invitation to send. */}
                {email.trim() && (
                  <>
                    {showMessage && (
                      <input
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        placeholder="Add a message (optional)"
                        maxLength={500}
                        autoFocus
                        className={`w-full px-3 py-2 ${field}`}
                      />
                    )}
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-gray-600 dark:text-gray-400">
                          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)}
                                 className="accent-blue-600" />
                          Email them
                        </label>
                        {notify && !showMessage && (
                          <button
                            type="button"
                            onClick={() => setShowMessage(true)}
                            className="shrink-0 text-[12.5px] text-blue-600 hover:underline dark:text-blue-400"
                          >
                            Add a message
                          </button>
                        )}
                      </div>
                      <button
                        onClick={invite}
                        disabled={busy === "add"}
                        className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-40"
                      >
                        {busy === "add" ? "Sharing…" : "Share"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            <div>
              <p className={`mb-2 ${label}`}>People with access</p>
              <div className="divide-y divide-gray-100 dark:divide-white/[0.06] rounded-xl border border-gray-200 dark:border-white/[0.08]">
                <div className="flex items-center gap-2.5 px-3 py-2.5">
                  <Avatar name={state.owner_name || state.owner_email || "?"} accent />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-gray-800 dark:text-gray-200">
                      {state.owner_name || state.owner_email || "Owner"}
                      {state.your_role === "owner" && (
                        <span className="font-normal text-gray-400"> · you</span>
                      )}
                    </span>
                    {state.owner_name && state.owner_email && (
                      <span className="block truncate text-[11px] text-gray-400">{state.owner_email}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-[11.5px] text-gray-400">Full access</span>
                </div>

                {state.grants.length === 0 ? (
                  <p className="px-3 py-3 text-[12.5px] text-gray-400">Nobody else yet.</p>
                ) : (
                  state.grants.map((g) => (
                    <div key={g.email} className="flex items-center gap-2.5 px-3 py-2.5">
                      <Avatar name={g.email} />
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
                <label className="mt-2.5 flex cursor-pointer items-start gap-2.5 text-[12.5px] text-gray-600 dark:text-gray-400">
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

            {/* ── General access ──────────────────────────────────────────── */}
            <div>
              <p className={`mb-2 ${label}`}>General access</p>
              <div className="flex items-center gap-2.5">
                <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${
                  shownLevel === "private"
                    ? "bg-gray-100 text-gray-500 dark:bg-white/[0.06] dark:text-gray-400"
                    : "bg-blue-500/15 text-blue-600 dark:text-blue-300"
                }`}>
                  <Icon d={active.icon} className="h-4 w-4" />
                </span>
                <select
                  value={shownLevel}
                  disabled={!canManage || busy === "level"}
                  onChange={(e) => chooseLevel(e.target.value as AccessLevel)}
                  className={`min-w-0 flex-1 cursor-pointer px-2.5 py-2 disabled:cursor-not-allowed disabled:opacity-60 ${field}`}
                >
                  {levels.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                </select>
              </div>
              <p className="mt-1.5 text-[11.5px] leading-snug text-gray-500 dark:text-gray-400">
                {busy === "level" ? "Updating…" : active.hint}
              </p>

              {/* The chosen level needs something the document does not have
                  yet. Shown only now, rather than as a permanent box nobody
                  asked for. */}
              {wantWorkspace && canManage && !state.in_workspace && (
                <div className="mt-2 rounded-xl border border-blue-500/30 bg-blue-500/[0.04] p-3">
                  <p className="mb-2 text-[11.5px] text-gray-600 dark:text-gray-300">
                    Put this document in a workspace first:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <select
                      value={wsTarget.workspaceId ?? ""}
                      onChange={(e) => setWsTarget({ workspaceId: e.target.value || null, folderId: null })}
                      className={`min-w-0 flex-1 cursor-pointer px-2.5 py-1.5 ${field}`}
                    >
                      <option value="">Choose a workspace…</option>
                      {ws.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                    {wsTarget.workspaceId && ws.folders.length > 0 && (
                      <select
                        value={wsTarget.folderId ?? ""}
                        onChange={(e) => setWsTarget({ ...wsTarget, folderId: e.target.value || null })}
                        className={`min-w-0 flex-1 cursor-pointer px-2.5 py-1.5 ${field}`}
                      >
                        <option value="">No folder</option>
                        {ws.folders.map((f) => (
                          <option key={f.id} value={f.id}>{f.path.join(" / ") || f.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                  {wsTarget.workspaceId && (
                    <p className="mt-2 text-[11.5px] leading-relaxed text-gray-500 dark:text-gray-400">
                      Everyone in {ws.workspace?.name} will be able to read it; members and
                      admins can edit it.
                    </p>
                  )}
                  <div className="mt-2.5 flex items-center gap-2">
                    <button
                      onClick={moveIntoWorkspace}
                      disabled={!wsTarget.workspaceId || busy === "workspace"}
                      className="rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-40"
                    >
                      {busy === "workspace" ? "Adding…" : "Add and share"}
                    </button>
                    <button
                      onClick={() => setWantWorkspace(false)}
                      className="text-[12.5px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {state.is_password_protected && (
                <p className="mt-1.5 text-[11.5px] text-gray-500 dark:text-gray-400">
                  A password is also set, so readers are asked for it either way.
                </p>
              )}
              {!canManage && (
                <p className="mt-1.5 text-[11.5px] text-gray-400">
                  Only the owner can change who this is visible to.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
