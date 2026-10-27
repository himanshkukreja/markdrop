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
import {
  addItems, can, listMembers, listWorkspaces, moveItems, purgeDocument, removeItems, type Workspace,
} from "@/lib/workspaces";
import { ancestry, childrenMap, documentsChanged, useWorkspaceTree, workspaceChanged } from "@/lib/workspaceStore";

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

/** "Who can open it": the levels name the workspace (P4). Where it lives is a separate row. */
function levelOptions(wsName: string | null, hasPassword: boolean) {
  return [
    { id: "private" as AccessLevel, label: "Only people you choose", hint: "You, and the people on the list above. Nobody else, link or not." },
    {
      id: "workspace" as AccessLevel,
      label: wsName ? `Everyone in ${wsName}` : "Everyone in the workspace",
      hint: wsName ? `Members of ${wsName} sign in to open it.` : "Put it in a workspace first, under Location.",
    },
    {
      id: "link" as AccessLevel,
      label: hasPassword ? "Anyone with the link and the password" : "Anyone with the link",
      hint: hasPassword ? "No sign-in, but readers are asked for the password." : "No sign-in needed. This is how Markdrop links have always worked.",
    },
  ];
}

/** Workspaces once per page (names, roles, hosts). */
let wsListCache: Promise<Workspace[]> | null = null;
function useWorkspaceList() {
  const [list, setList] = useState<Workspace[] | null>(null);
  useEffect(() => {
    let live = true;
    let signedIn = false;
    try { signedIn = !!localStorage.getItem("markdrop_token"); } catch { /* no storage */ }
    if (!signedIn) { setList([]); return; }
    wsListCache ??= listWorkspaces().catch((e) => { wsListCache = null; throw e; });
    wsListCache.then((w) => live && setList(w)).catch(() => live && setList([]));
    return () => { live = false; };
  }, []);
  return list;
}

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
  slug, title, documentId, shareUrl, location, startWithLocation, onClose, onChanged,
}: {
  slug: string;
  title: string;
  /** The document's id (kept for callers; v2 filing works by slug). */
  documentId?: string | null;
  /** What the footer's "Copy link" copies (with `#k=` for encrypted documents).
   *  Omitted → no copy button, rather than a link that may not open it. */
  shareUrl?: string;
  /** Where the caller knows the document is filed (the access endpoint names only the workspace). */
  location?: { workspaceId: string | null; folderId: string | null } | null;
  /** Open with the Location editor showing ("Add to a workspace…"). */
  startWithLocation?: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  void documentId;
  const toast = useToast();
  const [state, setState] = useState<AccessState | null>(null);
  const [error, setError] = useState("");
  const [emails, setEmails] = useState<string[]>([]);
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [notify, setNotify] = useState(true);
  const [message, setMessage] = useState("");
  const [showMessage, setShowMessage] = useState(false);
  const [busy, setBusy] = useState("");
  const [suggestions, setSuggestions] = useState<ComboboxSuggestion[]>([]);
  const workspaces = useWorkspaceList();
  // Where it is filed. The access endpoint says which workspace (and, on v2, which folder); the
  // caller's hint fills in the folder for older backends.
  const [folderHint, setFolderHint] = useState<string | null>(location?.folderId ?? null);

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
  const shownLevel: AccessLevel = state?.level ?? "link";

  // ── Location ──
  const wsId = state ? (state.workspace_id ?? (state.in_workspace ? location?.workspaceId ?? null : null)) : location?.workspaceId ?? null;
  const stateFolder = (state as (AccessState & { folder_id?: string | null }) | null)?.folder_id;
  const folderId = stateFolder !== undefined ? stateFolder : folderHint;
  const ws = workspaces?.find((w) => w.id === wsId) ?? null;
  const { tree } = useWorkspaceTree(wsId);
  const wsName = tree?.workspace.name ?? ws?.name ?? (wsId ? "the workspace" : null);
  const wsRole = tree?.workspace.role ?? ws?.role;
  const trailNames = tree ? ancestry(tree.folders, folderId).map((f) => f.name) : [];
  const host = tree?.workspace.primary_host ?? ws?.primary_host ?? null;
  const folderPath = tree ? ancestry(tree.folders, folderId).map((f) => f.slug) : [];
  const memberOf = (workspaces ?? []).filter((w) => can(w.role, "member"));
  const canMoveHere = !!wsId && can(wsRole, "member");
  const canRemove = !!wsId && (canManage || can(wsRole, "admin"));
  const canChangeLocation = canManage ? memberOf.length > 0 || !!wsId : canMoveHere;
  const [locOpen, setLocOpen] = useState(!!startWithLocation);

  const levels = levelOptions(wsId ? wsName : null, !!state?.is_password_protected);

  function chooseLevel(next: AccessLevel) {
    if (!state || next === shownLevel) return;
    if (next === "workspace" && !wsId) return;
    run("level", () => setAccessLevel(slug, next), () => toast.success("Who can open it is updated."));
  }

  async function saveLocation(next: { workspaceId: string | null; folderId: string | null }) {
    const from = wsId;
    await run("location", async () => {
      const wasWorkspaceLevel = state?.level === "workspace";
      if (!next.workspaceId) {
        const r = await removeItems(from!, [slug]);
        const after = r.find((x) => x.slug === slug)?.access_after;
        toast.success(after === "private" ? `Removed from ${wsName}. It's private now.` : `Removed from ${wsName}.`);
      } else if (from && next.workspaceId === from) {
        await moveItems(from, [slug], next.folderId);
        toast.success("Moved.");
      } else {
        if (from) await removeItems(from, [slug]);
        // Moving between workspaces keeps "Everyone in the workspace" meaning the new one.
        await addItems(next.workspaceId, [slug], next.folderId, wasWorkspaceLevel ? "workspace" : undefined);
        const name = workspaces?.find((w) => w.id === next.workspaceId)?.name ?? "the workspace";
        toast.success(`Added to ${name}.`);
      }
      setFolderHint(next.folderId);
      if (from) workspaceChanged(from);
      if (next.workspaceId && next.workspaceId !== from) workspaceChanged(next.workspaceId);
      documentsChanged();
      setLocOpen(false);
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

            {/* ── Location (where it's filed; separate from who can open it) ── */}
            <LocationRow
              wsId={wsId}
              wsName={wsName}
              trail={trailNames}
              folderId={folderId ?? null}
              canChange={canChangeLocation}
              canRemove={canRemove}
              isOwner={canManage}
              workspaces={canManage ? memberOf : ws ? [ws] : []}
              open={locOpen}
              onOpenChange={setLocOpen}
              busy={busy === "location"}
              onSave={(next) => void saveLocation(next)}
              level={shownLevel}
            />

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
                        {g.active === false ? (
                          <span className="block text-caption text-text-muted">No longer active: whoever shared it lost access</span>
                        ) : !g.notified && <span className="block text-caption text-text-muted">Added without an email</span>}
                      </span>
                      <span className="shrink-0 text-caption text-text-secondary">
                        {g.active === false ? "No access" : (g.effective_role ?? g.role) === "editor" ? "Can edit" : "Can view"}
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

            {/* ── Who can open it ────────────────────────────────────── */}
            <div className="flex flex-col gap-2">
              <p id="md-share-general" className="text-eyebrow text-text-muted">Who can open it</p>
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
                    disabled: !canManage || busy === "level" || (l.id === "workspace" && !wsId),
                  }))}
                />
              </div>
              {busy === "level" && <p className="text-caption text-text-muted" role="status">Updating…</p>}
              {canManage && (
                <p className="text-caption text-text-muted">
                  One setting for every address it has: <span className="font-mono">markdrop.in/{slug}</span>
                  {host && wsId ? <> and <span className="font-mono [overflow-wrap:anywhere]">{[host, ...folderPath, slug].join("/")}</span></> : null}.
                </p>
              )}
              {!canManage && (
                <p className="text-caption text-text-muted">Only the owner can change who can open it.</p>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/**
 * "In Acme › Guides · Change · Remove from workspace" (P4). Filing is about where it lives and its
 * address on the workspace's domain; it never decides who can open it, which is the next block.
 */
function LocationRow({
  wsId, wsName, trail, folderId, canChange, canRemove, isOwner, workspaces, open, onOpenChange, busy, onSave, level,
}: {
  wsId: string | null;
  wsName: string | null;
  trail: string[];
  folderId: string | null;
  canChange: boolean;
  canRemove: boolean;
  isOwner: boolean;
  /** Where it may go: an owner's member+ workspaces; anyone else only the current one. */
  workspaces: Workspace[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  busy: boolean;
  onSave: (next: { workspaceId: string | null; folderId: string | null }) => void;
  level: AccessLevel;
}) {
  const [draftWs, setDraftWs] = useState<string | null>(wsId);
  const [draftFolder, setDraftFolder] = useState<string | null>(folderId);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    if (open) { setDraftWs(wsId ?? workspaces[0]?.id ?? null); setDraftFolder(folderId); }
  }, [open, wsId, folderId, workspaces]);
  const { tree } = useWorkspaceTree(open ? draftWs : null);

  const folderOptions = useMemo(() => {
    if (!tree) return [];
    const kids = childrenMap(tree.folders);
    const out: Array<{ value: string; label: string }> = [];
    const walk = (p: string | null, prefix: string[]) => {
      for (const f of kids.get(p) ?? []) {
        const names = [...prefix, f.name];
        out.push({ value: f.id, label: names.join(" › ") });
        walk(f.id, names);
      }
    };
    walk(null, []);
    return out;
  }, [tree]);

  const where = wsId ? [wsName ?? "Workspace", ...trail].join(" › ") : null;
  const unchanged = draftWs === wsId && (draftFolder ?? null) === (folderId ?? null);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-eyebrow text-text-muted">Location</p>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-surface-inset px-3 py-2">
        <Icon name={wsId ? "folder" : "user"} size={16} className="shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1 text-body text-text">
          {where ? (
            <>In <span className="font-medium [overflow-wrap:anywhere]" dir="auto">{where}</span></>
          ) : (
            <span className="text-text-secondary">Personal: not in a workspace</span>
          )}
        </span>
        {!open && (
          <span className="flex shrink-0 items-center gap-1">
            {canChange && (
              <Button size="sm" variant="ghost" onClick={() => onOpenChange(true)}>
                {wsId ? "Change" : "Add to a workspace"}
              </Button>
            )}
            {canRemove && wsId && (
              <Button size="sm" variant="ghost" className="text-danger" onClick={() => setConfirmRemove(true)} aria-label={`Remove from ${wsName ?? "the workspace"}`}>
                Remove
              </Button>
            )}
          </span>
        )}
      </div>

      {confirmRemove && !open && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3" role="group" aria-label="Remove from workspace">
          <p className="text-caption text-text-secondary">
            It leaves {wsName} and goes back to its owner.{level === "workspace" ? ` It's open to everyone in ${wsName} now, so it becomes private.` : " Who can open it doesn't change."}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="danger" loading={busy} onClick={() => { setConfirmRemove(false); onSave({ workspaceId: null, folderId: null }); }}>Remove</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {open && (
        <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-3">
          <div className="grid min-w-0 gap-2 sm:grid-cols-2">
            <Select
              aria-label="Workspace"
              value={draftWs ?? ""}
              disabled={!isOwner}
              onChange={(e) => { setDraftWs(e.target.value || null); setDraftFolder(null); }}
              className="min-w-0"
            >
              {isOwner && <option value="">Personal (no workspace)</option>}
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
            {draftWs && (
              <Select
                aria-label="Folder"
                value={draftFolder ?? ""}
                onChange={(e) => setDraftFolder(e.target.value || null)}
                className="min-w-0"
                disabled={!tree}
              >
                <option value="">Top level</option>
                {folderOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            )}
          </div>
          <p className="text-caption text-text-muted">
            {draftWs
              ? "Who can open it stays as set below. On the workspace's domain, its address follows the folder."
              : level === "workspace" ? "It becomes private: only you and the people you named." : "It goes back to your personal documents. Who can open it doesn't change."}
          </p>
          <div className="flex gap-2">
            <Button size="sm" loading={busy} disabled={unchanged} onClick={() => onSave({ workspaceId: draftWs, folderId: draftWs ? draftFolder : null })}>
              Save location
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
