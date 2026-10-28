"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert, Avatar, Button, Checkbox, CopyButton, Dialog, Field, Icon, Input, RowMenu, Select, Skeleton,
  Switch, Textarea,
} from "@/components/ui";
import { Combobox, type ComboboxSuggestion } from "@/components/kit/Combobox";
import { useToast } from "@/components/Toast";
import { API_BASE, updateArtifactSettings, type ExpiresIn } from "@/lib/api";
import {
  addPerson, getAccess, removePerson, setAccessLevel, setResharing,
  type AccessLevel, type AccessState,
} from "@/lib/access";
import {
  addItems, can, listMembers, listWorkspaces, moveItems, purgeDocument, removeItems, type Workspace,
} from "@/lib/workspaces";
import { ancestry, childrenMap, documentsChanged, useWorkspaceTree, workspaceChanged } from "@/lib/workspaceStore";
import { teamName } from "@/components/workspace/folder/items";
import { PresetCards } from "./PresetCards";

/**
 * Share an item (ShareItem board): where it lives, who can open it, and who has been named on it.
 *
 * - The header says where it is filed ("In Acme Docs › Guides · Move · Remove from workspace").
 *   Filing never decides who can open it.
 * - "Who can open it" is three presets: Only people added · {Team} team · Anyone with the link.
 *   The team preset needs the item to be in a workspace. Password and expiry live under "More
 *   options". One setting covers every address of the file.
 * - People with access: add by email (Can view / Can edit), the owner, the team when it applies,
 *   and everyone named.
 *
 * The permission rules are not re-implemented here. The server returns `can_manage` and
 * `can_share`, and this only renders what they allow. Suggestions come only from
 * `GET /api/v1/me/contacts` (falling back to the document's own workspace members), never a global
 * user search: the dialog must not be a way to discover addresses.
 */

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

const EXPIRY: Array<{ value: "" | ExpiresIn; label: string }> = [
  { value: "", label: "Don't change" },
  { value: "never", label: "Never" },
  { value: "1d", label: "In 1 day" },
  { value: "7d", label: "In 7 days" },
  { value: "30d", label: "In 30 days" },
];

export default function ShareDialog({
  slug, title, documentId, shareUrl, location, kind, startWithLocation, onClose, onChanged,
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
  /** "artifact" lets the owner set a password and expiry here; documents do it in the editor. */
  kind?: string | null;
  /** Open with the location editor showing ("Add to a workspace…"). */
  startWithLocation?: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  void documentId;
  const toast = useToast();
  const router = useRouter();
  const [state, setState] = useState<AccessState | null>(null);
  const [error, setError] = useState("");
  const [emails, setEmails] = useState<string[]>([]);
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [notify, setNotify] = useState(true);
  const [message, setMessage] = useState("");
  const [showMessage, setShowMessage] = useState(false);
  const [busy, setBusy] = useState("");
  const [suggestions, setSuggestions] = useState<ComboboxSuggestion[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
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
      // Everything in this dialog changes who may read the document, and the page is served from
      // a cached *anonymous* render: narrowing access has to take effect when it is narrowed.
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
        // Says what actually happened rather than what was requested.
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
  const stateFolder = state?.folder_id;
  const folderId = stateFolder !== undefined ? stateFolder : folderHint;
  const ws = workspaces?.find((w) => w.id === wsId) ?? null;
  const { tree } = useWorkspaceTree(wsId);
  const wsName = tree?.workspace.name ?? ws?.name ?? (wsId ? state?.workspace_name ?? "the workspace" : null);
  const team = wsId ? teamName(ws, wsName ?? "Workspace") : null;
  const wsRole = tree?.workspace.role ?? ws?.role;
  const trailNames = tree ? ancestry(tree.folders, folderId).map((f) => f.name) : [];
  const host = tree?.workspace.primary_host ?? ws?.primary_host ?? null;
  const folderPath = tree ? ancestry(tree.folders, folderId).map((f) => f.slug) : [];
  const memberOf = (workspaces ?? []).filter((w) => can(w.role, "member"));
  const canMoveHere = !!wsId && can(wsRole, "member");
  const canRemove = !!wsId && (canManage || can(wsRole, "admin"));
  const canChangeLocation = canManage ? memberOf.length > 0 || !!wsId : canMoveHere;
  const [locOpen, setLocOpen] = useState(!!startWithLocation);
  const [confirmRemove, setConfirmRemove] = useState(false);

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
        toast.success(after === "private" ? `Removed from ${wsName}. Only people added can open it now.` : `Removed from ${wsName}.`);
      } else if (from && next.workspaceId === from) {
        await moveItems(from, [slug], next.folderId);
        toast.success("Moved.");
      } else {
        if (from) await removeItems(from, [slug]);
        // Moving between workspaces keeps "{Team} team" meaning the new one.
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

  function preview() {
    if (!wsId) return;
    onClose();
    router.push(`/w/${encodeURIComponent(wsId)}${folderId ? `/f/${encodeURIComponent(folderId)}` : ""}?preview=anyone`);
  }

  const ownerName = state?.owner_name || state?.owner_email || "Owner";
  const where = wsId ? [wsName ?? "Workspace", ...trailNames].join(" › ") : null;
  const memberCount = ws?.member_count;
  const pw = !!state?.is_password_protected;

  const header = (
    <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-text-muted">
      <Icon name={wsId ? "folder" : "user"} size={14} className="shrink-0" />
      {where ? (
        <span>In <strong className="font-semibold text-text-secondary [overflow-wrap:anywhere]" dir="auto">{where}</strong></span>
      ) : (
        <span>Personal: not in a workspace</span>
      )}
      {state && canChangeLocation && !locOpen && (
        <>
          <span aria-hidden>·</span>
          <button type="button" className="md-focus cursor-pointer rounded-sm bg-transparent p-0 font-semibold text-accent-text hover:underline" onClick={() => setLocOpen(true)}>
            {wsId ? "Move" : "Add to a workspace"}
          </button>
        </>
      )}
      {state && canRemove && wsId && !locOpen && (
        <>
          <span aria-hidden>·</span>
          <button type="button" className="md-focus cursor-pointer rounded-sm bg-transparent p-0 font-semibold text-accent-text hover:underline" onClick={() => setConfirmRemove(true)}>
            Remove from workspace
          </button>
        </>
      )}
    </span>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={<span className="block [overflow-wrap:anywhere]" dir="auto">Share “{title}”</span>}
      description={header}
      size="lg"
      className="!max-w-[568px]"
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          {wsId && <Button variant="ghost" iconLeft="eye" onClick={preview}>Preview as</Button>}
          <span className="ml-auto" />
          {shareUrl && <CopyButton text={shareUrl} label="Copy link" variant="secondary" size="md" />}
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {!state ? (
          !error && (
            <div className="flex flex-col gap-3" aria-busy="true">
              <span className="md-visually-hidden">Loading sharing</span>
              <Skeleton height={88} />
              <Skeleton width="60%" />
              <Skeleton height={36} />
            </div>
          )
        ) : (
          <>
            {/* An encrypted document cannot be unlocked by a permission: the key is in the link's
                fragment and never reached the server. */}
            {state.encrypted && (
              <Alert tone="warning" title="The link is the key">
                These settings control who can fetch it. Anyone you share with still needs the full
                link, including everything after the <span className="font-mono">#</span>.
              </Alert>
            )}

            {confirmRemove && !locOpen && (
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-inset p-3" role="group" aria-label="Remove from workspace">
                <p className="text-caption text-text-secondary">
                  It leaves {wsName} and goes back to its owner.{shownLevel === "workspace" ? ` It's open to the ${team} team now, so it becomes “Only people added”.` : " Who can open it doesn't change."}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="danger" loading={busy === "location"} onClick={() => { setConfirmRemove(false); void saveLocation({ workspaceId: null, folderId: null }); }}>Remove</Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>Cancel</Button>
                </div>
              </div>
            )}

            {locOpen && (
              <LocationEditor
                wsId={wsId}
                folderId={folderId ?? null}
                isOwner={canManage}
                workspaces={canManage ? memberOf : ws ? [ws] : []}
                busy={busy === "location"}
                level={shownLevel}
                onCancel={() => setLocOpen(false)}
                onSave={(next) => void saveLocation(next)}
              />
            )}

            {/* ── Who can open it ───────────────────────────────────── */}
            <div className="flex flex-col gap-2">
              <PresetCards<AccessLevel>
                legend="Who can open it"
                name="md-share-level"
                layout="columns"
                value={shownLevel}
                onChange={chooseLevel}
                disabled={!canManage || busy === "level"}
                busy={busy === "level"}
                options={[
                  { value: "private", label: "Only people added", icon: "lock", hint: "You and the people below." },
                  {
                    value: "workspace", label: team ? `${team} team` : "Workspace team", icon: "user",
                    hint: wsName ? `Anyone in ${wsName}, after signing in.` : undefined,
                    disabled: !wsId, disabledReason: "Add it to a workspace first",
                  },
                  { value: "link", label: "Anyone with the link", icon: "globe", hint: pw ? "No sign-in. They're asked for the password." : "No sign-in needed." },
                ]}
              />
              {busy === "level" && <p className="text-caption text-text-muted" role="status">Updating…</p>}
              {canManage ? (
                <p className="mt-1 text-caption text-text-muted">
                  One setting for every address of this file: <code className="font-mono">markdrop.in/{slug}</code>
                  {host && wsId ? <> and <code className="font-mono [overflow-wrap:anywhere]">{[host, ...folderPath, slug].join("/")}</code></> : null}.
                </p>
              ) : (
                <p className="text-caption text-text-muted">Only the owner can change who can open it.</p>
              )}
            </div>

            {/* ── More options: password and expiry ─────────────────── */}
            {canManage && (
              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  aria-expanded={moreOpen}
                  aria-controls="md-share-more"
                  onClick={() => setMoreOpen((o) => !o)}
                  className="md-focus flex cursor-pointer items-center gap-2 self-start rounded-sm bg-transparent p-0 text-[13px] font-semibold text-accent-text"
                >
                  <Icon name={moreOpen ? "chevronDown" : "chevronRight"} size={14} />
                  More options: password and expiry
                </button>
                {moreOpen && (
                  <div id="md-share-more">
                    {kind === "artifact" ? (
                      <MoreOptions slug={slug} hasPassword={pw} onSaved={() => { purgeDocument(slug); void load(); onChanged?.(); }} />
                    ) : (
                      <p className="rounded-lg bg-surface-inset p-3 text-caption text-text-secondary">
                        {pw ? "It has a password. " : ""}A document&apos;s password and expiry are set in its editor.{" "}
                        {!state.encrypted && <a href={`/${encodeURIComponent(slug)}?edit=1`} className="font-semibold text-accent-text">Open the editor</a>}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── People with access ─────────────────────────────────── */}
            <div className="flex flex-col gap-2">
              <span className="text-[13px] font-semibold text-text">People with access</span>
              {canShare && (
                <div className="flex flex-col gap-2">
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start">
                    <Combobox
                      tags={emails}
                      onTagsChange={setEmails}
                      suggestions={offered}
                      label="Add people by email"
                      placeholder="Add people by email"
                      className="min-w-0 flex-1 [&>label]:sr-only"
                    />
                    <div className="flex gap-2">
                      <Select
                        aria-label="Their access"
                        value={role}
                        onChange={(e) => setRole(e.target.value as "viewer" | "editor")}
                        className="w-[120px]"
                      >
                        <option value="viewer">Can view</option>
                        {/* A delegate cannot grant above their own level, so the option is hidden
                            rather than shown and then refused. */}
                        {(canManage || state.your_role === "editor") && <option value="editor">Can edit</option>}
                      </Select>
                      {emails.length > 0 && (
                        <Button onClick={invite} loading={busy === "add"} className="shrink-0">Share</Button>
                      )}
                    </div>
                  </div>
                  {emails.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <Checkbox label="Email them" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                        {notify && !showMessage && (
                          <Button variant="link" size="sm" onClick={() => setShowMessage(true)}>Add a message</Button>
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

              <ul className="m-0 flex list-none flex-col p-0">
                <li className="flex min-h-10 items-center gap-3 px-0.5 py-1.5">
                  <Avatar name={ownerName} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-body text-text">
                    {ownerName}
                    {state.your_role === "owner" && <span className="text-text-muted"> (you)</span>}
                  </span>
                  <span className="shrink-0 text-[13px] text-text-muted">Owner</span>
                </li>
                {wsId && shownLevel !== "private" && (
                  <li className="flex min-h-10 items-center gap-3 px-0.5 py-1.5">
                    <Avatar name={`Everyone in ${wsName}`} size="sm" neutral />
                    <span className="min-w-0 flex-1 truncate text-body text-text">
                      Everyone in {wsName}
                      {memberCount ? <span className="text-text-muted"> · {memberCount === 1 ? "1 person" : `${memberCount} people`}</span> : null}
                    </span>
                    <span className="shrink-0 text-[13px] text-text-muted">Members can edit</span>
                  </li>
                )}
                {state.grants.map((g) => (
                  <li key={g.email} className="flex min-h-10 items-center gap-3 px-0.5 py-1.5">
                    <Avatar name={g.email.split("@")[0] || g.email} size="sm" neutral />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body text-text">{g.email}</span>
                      {g.active === false ? (
                        <span className="block text-caption text-text-muted">No longer active: whoever shared it lost access</span>
                      ) : !g.notified && <span className="block text-caption text-text-muted">Added without an email</span>}
                    </span>
                    <span className="shrink-0 text-[13px] text-text-secondary">
                      {g.active === false ? "No access" : (g.effective_role ?? g.role) === "editor" ? "Can edit" : "Can view"}
                    </span>
                    {(canManage || g.email === state.your_email) && (
                      <RowMenu
                        label={`More actions for ${g.email}`}
                        items={[{
                          label: g.email === state.your_email ? "Remove me" : "Remove",
                          icon: "x",
                          busy: busy === g.email,
                          onClick: () => run(g.email, () => removePerson(slug, g.email), () => toast.success(`Removed ${g.email}.`)),
                        }]}
                      />
                    )}
                  </li>
                ))}
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
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Artifacts: a password (only for people without access) and an expiry, owner only. */
function MoreOptions({ slug, hasPassword, onSaved }: { slug: string; hasPassword: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState<"" | ExpiresIn>("");
  const [busy, setBusy] = useState<"" | "save" | "remove">("");
  const dirty = !!password || !!expiry;

  async function save(remove = false) {
    setBusy(remove ? "remove" : "save");
    try {
      await updateArtifactSettings(slug, {
        readPassword: remove ? undefined : password || undefined,
        removePassword: remove,
        expiresIn: remove ? undefined : expiry || undefined,
      });
      setPassword(""); setExpiry("");
      toast.success(remove ? "Password removed." : "Saved.");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : "That didn't save. Try again.");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-surface-inset p-3">
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Field label="Password" hint="Only for people without access.">
          <Input type="password" placeholder={hasPassword ? "Set · type a new one" : "Add a password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" maxLength={100} />
        </Field>
        <Field label="Expires">
          <Select value={expiry} onChange={(e) => setExpiry(e.target.value as "" | ExpiresIn)} options={EXPIRY} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={!dirty} loading={busy === "save"} onClick={() => void save()}>Save options</Button>
        {hasPassword && <Button size="sm" variant="ghost" loading={busy === "remove"} onClick={() => void save(true)}>Remove password</Button>}
      </div>
    </div>
  );
}

/** "Move" / "Add to a workspace": pick a workspace (owners) and a folder. Who can open it stays. */
function LocationEditor({
  wsId, folderId, isOwner, workspaces, busy, level, onCancel, onSave,
}: {
  wsId: string | null;
  folderId: string | null;
  isOwner: boolean;
  /** Where it may go: an owner's member+ workspaces; anyone else only the current one. */
  workspaces: Workspace[];
  busy: boolean;
  level: AccessLevel;
  onCancel: () => void;
  onSave: (next: { workspaceId: string | null; folderId: string | null }) => void;
}) {
  const [draftWs, setDraftWs] = useState<string | null>(wsId ?? workspaces[0]?.id ?? null);
  const [draftFolder, setDraftFolder] = useState<string | null>(folderId);
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const { tree } = useWorkspaceTree(draftWs);

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

  const unchanged = draftWs === wsId && (draftFolder ?? null) === (folderId ?? null);

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface-inset p-3" role="group" aria-label="Where it lives">
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        <Select
          ref={first}
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
          <Select aria-label="Folder" value={draftFolder ?? ""} onChange={(e) => setDraftFolder(e.target.value || null)} className="min-w-0" disabled={!tree}>
            <option value="">Top level</option>
            {folderOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        )}
      </div>
      <p className="text-caption text-text-muted">
        {draftWs
          ? "Who can open it stays as it is. On the workspace's domain, its address follows the folder."
          : level === "workspace" ? "It becomes “Only people added”: you and the people you named." : "It goes back to your files. Who can open it doesn't change."}
      </p>
      <div className="flex gap-2">
        <Button size="sm" loading={busy} disabled={unchanged} onClick={() => onSave({ workspaceId: draftWs, folderId: draftWs ? draftFolder : null })}>
          Save location
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
