"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert, Avatar, Button, Checkbox, CopyButton, Dialog, Icon, RadioGroup, RowMenu, Select, Skeleton,
  Switch, Textarea,
} from "@/components/ui";
import { Combobox, type ComboboxSuggestion } from "@/components/kit/Combobox";
import { useToast } from "@/components/Toast";
import { API_BASE } from "@/lib/api";
import {
  addPerson, getAccess, removePerson, setAccessLevel, setResharing,
  type AccessLevel, type AccessState,
} from "@/lib/access";
import { useWorkspaceTargets, type PublishTargetValue } from "@/lib/useWorkspaceTargets";
import { listMembers, purgeDocument, shareToWorkspace } from "@/lib/workspaces";

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
 * People comes first and general access is one block, because that ordering is
 * how often each is used (REVAMP_PLAN 7.6 "Share"; Viewer board share-dialog,
 * MobileReading frame 4). Everything optional stays folded away until the
 * moment it applies.
 *
 * The permission rules are not re-implemented here. The server returns
 * `can_manage` and `can_share`, and this only renders what they allow; a client
 * that decided for itself would eventually decide differently.
 *
 * Suggestions come only from `GET /api/v1/me/contacts` (people this user has
 * shared with, and members of workspaces they belong to), falling back to the
 * document's own workspace members when that endpoint isn't there. Never a
 * global user search: the dialog must not be a way to discover addresses.
 */

const LEVELS: { id: AccessLevel; label: string; hint: string }[] = [
  { id: "private", label: "Only people I choose", hint: "Nobody can open it unless they're on the list above." },
  { id: "link", label: "Anyone with the link", hint: "No sign-in needed. This is how Markdrop links have always worked." },
  { id: "workspace", label: "Everyone in the workspace", hint: "Members of the workspace this document is shared into." },
];

async function fetchContacts(): Promise<ComboboxSuggestion[] | null> {
  const t = typeof window === "undefined" ? null : localStorage.getItem("markdrop_token");
  if (!t) return null;
  try {
    const res = await fetch(`${API_BASE}/api/v1/me/contacts`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${t}` },
    });
    if (!res.ok) return null; // 404 until the endpoint ships: fall back quietly
    const body = (await res.json()) as { contacts?: { email: string; name?: string | null; source?: string }[] };
    return (body.contacts ?? []).map((c) => ({
      email: c.email,
      name: c.name ?? undefined,
      role: c.source === "workspace" ? "Workspace" : c.source === "shared" ? "Shared before" : undefined,
    }));
  } catch {
    return null;
  }
}

export default function ShareDialog({
  slug, title, documentId, shareUrl, onClose, onChanged,
}: {
  slug: string;
  title: string;
  /** Needed to put the document into a workspace from here. Without it the
   *  workspace option is hidden rather than shown and then failing. */
  documentId?: string | null;
  /** What the footer's "Copy link" copies (with `#k=` for encrypted documents).
   *  Omitted → no copy button, rather than a link that may not open it. */
  shareUrl?: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const toast = useToast();
  const [state, setState] = useState<AccessState | null>(null);
  const [error, setError] = useState("");
  const [emails, setEmails] = useState<string[]>([]);
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [notify, setNotify] = useState(true);
  const [message, setMessage] = useState("");
  const [showMessage, setShowMessage] = useState(false);
  const [busy, setBusy] = useState("");
  // "Everyone in the workspace" for a document that isn't in one yet: the
  // select shows the choice while the picker below collects what is missing.
  const [wantWorkspace, setWantWorkspace] = useState(false);
  const [wsTarget, setWsTarget] = useState<PublishTargetValue>({ workspaceId: null, folderId: null });
  const ws = useWorkspaceTargets(wsTarget);
  const [suggestions, setSuggestions] = useState<ComboboxSuggestion[]>([]);

  const load = useCallback(async () => {
    try { setState(await getAccess(slug)); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't load sharing. Close this and try again."); }
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  // Suggestions: the contacts endpoint, else this document's workspace members.
  useEffect(() => {
    let cancelled = false;
    fetchContacts().then(async (contacts) => {
      if (cancelled) return;
      if (contacts) { setSuggestions(contacts); return; }
      const id = state?.workspace_id;
      if (!id) return;
      try {
        const members = await listMembers(id);
        if (!cancelled) {
          setSuggestions(members.filter((m) => m.email).map((m) => ({
            email: m.email as string, name: m.name ?? undefined, role: m.role,
          })));
        }
      } catch { /* suggestions are a convenience, never a blocker */ }
    });
    return () => { cancelled = true; };
  }, [state?.workspace_id]);

  async function run(key: string, fn: () => Promise<unknown>, after?: () => void) {
    setBusy(key); setError("");
    try {
      await fn();
      // Everything in this dialog changes who may read the document, and the
      // page is served from a cached *anonymous* render. Without this, tightening
      // access leaves that render in place: for a full minute the public copy
      // keeps handing out a document that is no longer public. Narrowing access
      // has to take effect when it is narrowed.
      purgeDocument(slug);
      await load(); onChanged?.(); after?.();
    }
    catch (e) { toast.error(e instanceof Error ? e.message : "That didn't save. Try again."); }
    finally { setBusy(""); }
  }

  async function invite() {
    const to = emails.map((e) => e.trim()).filter(Boolean);
    if (!to.length) return;
    await run("add", async () => {
      const results: string[] = [];
      for (const addr of to) {
        const g = await addPerson(slug, addr, role, notify, message.trim() || undefined);
        // Says what actually happened rather than what was requested: a grant is
        // real whether or not its email left the building.
        results.push(
          notify && g.notified ? `Shared with ${addr} and emailed them.`
          : notify ? `Shared with ${addr}, but the email didn't send.`
          : `Shared with ${addr}.`
        );
      }
      toast.success(results.length === 1 ? results[0] : `Shared with ${results.length} people.`);
      setEmails([]); setMessage(""); setShowMessage(false);
    });
  }

  const already = useMemo(() => new Set((state?.grants ?? []).map((g) => g.email.toLowerCase())), [state]);
  const offered = suggestions.filter((s) => !already.has(s.email.toLowerCase()) && s.email !== state?.your_email);

  const canManage = state?.can_manage ?? false;
  const canShare = state?.can_share ?? false;
  const canOfferWorkspace = state?.in_workspace || (canManage && !!documentId && ws.available);
  const levels = LEVELS.filter((l) => l.id !== "workspace" || canOfferWorkspace);
  const shownLevel: AccessLevel = wantWorkspace ? "workspace" : (state?.level ?? "link");

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

  const ownerName = state?.owner_name || state?.owner_email || "Owner";

  return (
    <Dialog
      open
      onClose={onClose}
      title="Share"
      description={<span className="block truncate" dir="auto">{title}</span>}
      size="md"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-caption text-text-muted">Changes save as you make them.</span>
          {shareUrl && <CopyButton text={shareUrl} label="Copy link" variant="secondary" size="sm" />}
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {error && <Alert tone="danger">{error}</Alert>}
        {!state ? (
          !error && (
            <div className="flex flex-col gap-3" aria-busy="true">
              <span className="md-visually-hidden">Loading sharing</span>
              <Skeleton height={36} />
              <Skeleton width="60%" />
              <Skeleton height={44} />
              <Skeleton height={44} />
            </div>
          )
        ) : (
          <>
            {/* An encrypted document cannot be unlocked by a permission — the
                key is in the link's fragment and never reached the server. */}
            {state.encrypted && (
              <Alert tone="warning" title="The link is the key">
                These settings control who can fetch it. Anyone you share with still needs the full
                link, including everything after the <span className="font-mono">#</span>.
              </Alert>
            )}

            {/* ── People ─────────────────────────────────────────────── */}
            {canShare && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <Combobox
                    tags={emails}
                    onTagsChange={setEmails}
                    suggestions={offered}
                    label="Add people by email"
                    className="min-w-0 flex-1"
                  />
                  <div className="flex gap-2">
                    <Select
                      aria-label="Access for the people you add"
                      value={role}
                      onChange={(e) => setRole(e.target.value as "viewer" | "editor")}
                      className="min-w-[8.5rem]"
                    >
                      <option value="viewer">Can view</option>
                      {/* A delegate cannot grant above their own level, so the
                          option is hidden rather than shown and then refused. */}
                      {(canManage || state.your_role === "editor") && <option value="editor">Can edit</option>}
                    </Select>
                    <Button onClick={invite} loading={busy === "add"} disabled={!emails.length} className="shrink-0">
                      Share
                    </Button>
                  </div>
                </div>

                {emails.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <Checkbox label="Email them" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                      {notify && !showMessage && (
                        <Button variant="link" size="sm" onClick={() => setShowMessage(true)}>
                          Add a message
                        </Button>
                      )}
                    </div>
                    {notify && showMessage && (
                      <Textarea
                        aria-label="Message (optional)"
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        placeholder="Add a message (optional)"
                        maxLength={500}
                        rows={2}
                        autoFocus
                      />
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <p className="text-eyebrow text-text-muted">People with access</p>
              <ul className="flex flex-col">
                <li className="flex min-h-11 items-center gap-3 py-1.5">
                  <Avatar name={ownerName} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-text">
                      {ownerName}
                      {state.your_role === "owner" && <span className="text-text-muted"> (you)</span>}
                    </span>
                    {state.owner_name && state.owner_email && (
                      <span className="block truncate text-caption text-text-muted">{state.owner_email}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-caption text-text-muted">Full access</span>
                </li>
                {state.grants.length === 0 ? (
                  <li className="py-2 text-caption text-text-muted">Nobody else yet.</li>
                ) : (
                  state.grants.map((g) => (
                    <li key={g.email} className="flex min-h-11 items-center gap-3 py-1.5">
                      <Avatar name={g.email.split("@")[0] || g.email} size="sm" neutral />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body text-text">{g.email}</span>
                        {!g.notified && <span className="block text-caption text-text-muted">Added without an email</span>}
                      </span>
                      <span className="shrink-0 text-caption text-text-secondary">
                        {g.role === "editor" ? "Can edit" : "Can view"}
                      </span>
                      {(canManage || g.email === state.your_email) && (
                        <RowMenu
                          label={`More actions for ${g.email}`}
                          items={[{
                            label: g.email === state.your_email ? "Remove me" : "Remove",
                            icon: "x",
                            busy: busy === g.email,
                            onClick: () => run(g.email, () => removePerson(slug, g.email),
                              () => toast.success(`Removed ${g.email}.`)),
                          }]}
                        />
                      )}
                    </li>
                  ))
                )}
              </ul>

              {canManage && (
                <Switch
                  className="mt-1"
                  checked={state.allow_resharing}
                  disabled={busy === "resharing"}
                  onChange={(e) => run("resharing", () => setResharing(slug, e.target.checked))}
                  label={
                    <span className="flex flex-col">
                      <span className="text-body text-text">Let people I share with add others</span>
                      <span className="text-caption text-text-muted">They can never give more access than they have themselves.</span>
                    </span>
                  }
                />
              )}
            </div>

            {/* ── General access ─────────────────────────────────────── */}
            <div className="flex flex-col gap-2">
              <p id="md-share-general" className="text-eyebrow text-text-muted">General access</p>
              <div aria-busy={busy === "level" || undefined}>
                <RadioGroup
                  name="md-share-level"
                  aria-labelledby="md-share-general"
                  value={shownLevel}
                  onChange={(v) => chooseLevel(v as AccessLevel)}
                  options={levels.map((l) => ({
                    value: l.id,
                    label: l.label,
                    description: l.hint,
                    disabled: !canManage || busy === "level",
                  }))}
                />
              </div>
              {busy === "level" && <p className="text-caption text-text-muted" role="status">Updating…</p>}

              {wantWorkspace && canManage && !state.in_workspace && (
                <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-inset p-3">
                  <p className="text-caption text-text-secondary">Put this document in a workspace first:</p>
                  <div className="flex flex-wrap gap-2">
                    <Select
                      aria-label="Workspace"
                      value={wsTarget.workspaceId ?? ""}
                      onChange={(e) => setWsTarget({ workspaceId: e.target.value || null, folderId: null })}
                      className="min-w-0 flex-1"
                    >
                      <option value="">Choose a workspace…</option>
                      {ws.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </Select>
                    {wsTarget.workspaceId && ws.folders.length > 0 && (
                      <Select
                        aria-label="Folder"
                        value={wsTarget.folderId ?? ""}
                        onChange={(e) => setWsTarget({ ...wsTarget, folderId: e.target.value || null })}
                        className="min-w-0 flex-1"
                      >
                        <option value="">No folder</option>
                        {ws.folders.map((f) => (
                          <option key={f.id} value={f.id}>{f.path.join(" / ") || f.name}</option>
                        ))}
                      </Select>
                    )}
                  </div>
                  {wsTarget.workspaceId && (
                    <p className="text-caption text-text-secondary">
                      Everyone in {ws.workspace?.name} will be able to read it; members and admins can edit it.
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <Button size="sm" onClick={moveIntoWorkspace} loading={busy === "workspace"} disabled={!wsTarget.workspaceId}>
                      Add and share
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setWantWorkspace(false)}>Cancel</Button>
                  </div>
                </div>
              )}

              {state.is_password_protected && (
                <p className="flex items-center gap-1.5 text-caption text-text-secondary">
                  <Icon name="lock" aria-hidden /> A password is also set, so readers are asked for it either way.
                </p>
              )}
              {!canManage && (
                <p className="text-caption text-text-muted">Only the owner can change who this is visible to.</p>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
