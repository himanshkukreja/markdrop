"use client";

/**
 * Share a folder (ShareFolder board): one dialog, two tabs.
 *
 * - Invite people: workspace invitations (emails + role) and who is in the workspace. Inviting adds
 *   someone to the whole workspace, which the dialog says plainly.
 * - Folder link: Not shared / {Team} team / Anyone with the link. A folder link never opens anything
 *   by itself (D2): each visitor sees only what they could already open, so the dialog counts what
 *   won't show and offers "See it as a visitor" (Preview as) to look before sharing.
 *
 * At a workspace's top level (no folder) only the Invite tab exists. Controls follow the caller's
 * role and the workspace settings; the server refuses anything else.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Avatar, Badge, Button, CopyButton, Dialog, Icon, Input, Select, Skeleton, Tabs, useToast,
} from "@/components/ui";
import { PresetCards } from "@/components/access/PresetCards";
import { plural } from "@/components/dashboard/format";
import {
  errorStatus, getFolderShare, inviteMember, listInvitations, listMembers, shareFolder, unshareFolder,
  type FolderShare, type FolderShareLevel, type Invitation, type Member, type Role, type TreeFolder,
} from "@/lib/workspaces";
import { workspaceChanged } from "@/lib/workspaceStore";
import { ROLE_HINT, ROLE_WORDS } from "./items";

type Level = "off" | FolderShareLevel;
export type ShareFolderTab = "invite" | "link";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ShareFolderDialog({
  open, workspaceId, workspaceName, team, folder, itemCount, startTab = "link", canInvite, canLink, onClose, onPreview,
}: {
  open: boolean;
  workspaceId: string;
  workspaceName: string;
  /** The team's short name ("Acme"). */
  team: string;
  /** null: the workspace's top level (invite only). */
  folder: TreeFolder | null;
  itemCount: number;
  startTab?: ShareFolderTab;
  /** Admins invite people. */
  canInvite: boolean;
  /** Admins, or members when the workspace lets them, share folders. */
  canLink: boolean;
  onClose: () => void;
  /** "See it as a visitor →": Preview as anyone. */
  onPreview: () => void;
}) {
  const hasLink = !!folder && canLink;
  const [tab, setTab] = useState<ShareFolderTab>(startTab);
  useEffect(() => {
    if (open) setTab(hasLink ? startTab : "invite");
  }, [open, startTab, hasLink]);

  // Keep the last folder while the dialog animates out.
  const last = useRef<TreeFolder | null>(folder);
  if (folder) last.current = folder;
  const f = folder ?? (open ? null : last.current);
  const name = f?.name ?? workspaceName;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      className="!max-w-[568px]"
      glyph={<Icon name={f ? "folder" : "users"} size={18} />}
      title={`Share “${name}”`}
      description={f ? `In ${workspaceName} · ${plural(itemCount, "item")}` : `${plural(itemCount, "item")} at the top level`}
      footer={<Button variant="secondary" onClick={onClose}>Done</Button>}
    >
      <div className="flex min-w-0 flex-col gap-5">
        {hasLink && (
          <Tabs
            aria-label="Share options"
            idPrefix="md-share-folder"
            value={tab}
            onChange={(v) => setTab(v as ShareFolderTab)}
            items={[
              { value: "invite", label: "Invite people", icon: "user" },
              { value: "link", label: "Folder link", icon: "link" },
            ]}
          />
        )}
        {hasLink ? (
          <>
            <div role="tabpanel" id="md-share-folder-panel-invite" aria-labelledby="md-share-folder-tab-invite" hidden={tab !== "invite"} className="min-w-0">
              <InvitePanel open={open} workspaceId={workspaceId} workspaceName={workspaceName} inFolder canInvite={canInvite} />
            </div>
            <div role="tabpanel" id="md-share-folder-panel-link" aria-labelledby="md-share-folder-tab-link" hidden={tab !== "link"} className="min-w-0">
              {f && <LinkPanel open={open} workspaceId={workspaceId} workspaceName={workspaceName} team={team} folder={f} onPreview={onPreview} />}
            </div>
          </>
        ) : (
          <InvitePanel open={open} workspaceId={workspaceId} workspaceName={workspaceName} inFolder={!!f} canInvite={canInvite} />
        )}
      </div>
    </Dialog>
  );
}

/* ── Invite people ───────────────────────────────────────────────────── */

function InvitePanel({
  open, workspaceId, workspaceName, inFolder, canInvite,
}: {
  open: boolean;
  workspaceId: string;
  workspaceName: string;
  inFolder: boolean;
  canInvite: boolean;
}) {
  const toast = useToast();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState<Exclude<Role, "owner">>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [m, i] = await Promise.all([
        listMembers(workspaceId),
        canInvite ? listInvitations(workspaceId).catch(() => [] as Invitation[]) : Promise.resolve([] as Invitation[]),
      ]);
      setMembers(m);
      setInvites(i.filter((x) => x.status === "pending"));
    } catch {
      setMembers([]);
    }
  }, [workspaceId, canInvite]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    const list = emails.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    if (!list.length) return;
    const bad = list.find((x) => !EMAIL.test(x));
    if (bad) { setError(`“${bad}” isn't an email address.`); return; }
    setBusy(true);
    setError("");
    const failed: string[] = [];
    for (const to of list) {
      try { await inviteMember(workspaceId, to, role); }
      catch (err) { failed.push(`${to}: ${err instanceof Error ? err.message : "didn't send"}`); }
    }
    setBusy(false);
    if (failed.length) setError(failed.join(" "));
    const sent = list.length - failed.length;
    if (sent) {
      toast.success(sent === 1 && !failed.length ? `Invitation sent to ${list[0]}` : `${plural(sent, "invitation")} sent`);
      setEmails("");
      void load();
    }
  }

  const ownerFirst = useMemo(() => {
    const order: Record<string, number> = { owner: 0, admin: 1, member: 2, viewer: 3 };
    return [...(members ?? [])].sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9));
  }, [members]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-[13px] leading-5 text-text-secondary">
        People you invite join <strong className="font-semibold text-text">{workspaceName}</strong>.
        They can open everything the team can{inFolder ? ", not just this folder" : ""}.
      </p>
      {canInvite ? (
        <form onSubmit={invite} className="flex min-w-0 flex-col gap-1.5" noValidate>
          <div className="flex min-w-0 flex-wrap gap-2">
            <Input
              aria-label="Email addresses"
              placeholder="name@company.com, …"
              value={emails}
              onChange={(e) => { setEmails(e.target.value); if (error) setError(""); }}
              autoComplete="off"
              inputMode="email"
              wrapClassName="min-w-0 flex-[1_1_240px]"
              className="min-w-0 flex-[1_1_240px]"
            />
            <Select
              aria-label="Role"
              value={role}
              onChange={(e) => setRole(e.target.value as Exclude<Role, "owner">)}
              options={[{ value: "viewer", label: "Can view" }, { value: "member", label: "Can edit" }, { value: "admin", label: "Admin" }]}
              className="w-[132px]"
            />
            <Button type="submit" variant="primary" loading={busy} disabled={!emails.trim()}>Invite</Button>
          </div>
          <p className="text-caption text-text-muted">{ROLE_HINT}</p>
          {error && <Alert tone="danger">{error}</Alert>}
        </form>
      ) : (
        <p className="text-caption text-text-muted">Only admins can invite people. {ROLE_HINT}</p>
      )}

      <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label={`People in ${workspaceName}`}>
        {members === null
          ? [0, 1, 2].map((i) => <li key={i}><Skeleton variant="rect" height={44} /></li>)
          : (
            <>
              {ownerFirst.map((m) => (
                <li key={m.user_id} className="flex min-w-0 items-center gap-3 px-1 py-2">
                  <Avatar name={m.name || m.email || "?"} size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-body-strong text-text" dir="auto">{m.name || m.email}</div>
                    {m.name && <div className="truncate text-caption text-text-muted">{m.email}</div>}
                  </div>
                  <span className="shrink-0 text-[13px] text-text-secondary">{ROLE_WORDS[m.role] ?? m.role}</span>
                </li>
              ))}
              {invites.map((i) => (
                <li key={i.id} className="flex min-w-0 items-center gap-3 px-1 py-2">
                  <Avatar name={i.email} size="md" neutral />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-body-strong text-text">{i.email}</div>
                    <div className="truncate text-caption text-text-muted">Invited · {ROLE_WORDS[i.role] ?? i.role}</div>
                  </div>
                  <Badge size="sm" tone="warning" icon="clock">Invited</Badge>
                </li>
              ))}
            </>
          )}
      </ul>
    </div>
  );
}

/* ── Folder link ─────────────────────────────────────────────────────── */

function LinkPanel({
  open, workspaceId, workspaceName, team, folder, onPreview,
}: {
  open: boolean;
  workspaceId: string;
  workspaceName: string;
  team: string;
  folder: TreeFolder;
  onPreview: () => void;
}) {
  const toast = useToast();
  const [share, setShare] = useState<FolderShare | null>(null);
  const [level, setLevel] = useState<Level>(folder.share?.level ?? "off");
  const [state, setState] = useState<"idle" | "loading" | "saving">("idle");
  const [error, setError] = useState("");

  // Read the current share without changing it (GET, never a PUT: that rewrites the share).
  useEffect(() => {
    if (!open) return;
    const current = folder.share?.level ?? null;
    setLevel(current ?? "off");
    setShare(null);
    setError("");
    if (!current) return;
    let live = true;
    setState("loading");
    getFolderShare(workspaceId, folder.id)
      .then((s) => { if (live) { setShare(s); setLevel(s ? s.level : "off"); } })
      .catch((e) => { if (live) setError(e instanceof Error && e.message ? e.message : "Couldn't load the folder's link."); })
      .finally(() => { if (live) setState("idle"); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, folder.id]);

  async function apply(next: Level) {
    if (next === level || state === "saving") return;
    setState("saving");
    setError("");
    try {
      if (next === "off") {
        await unshareFolder(workspaceId, folder.id);
        setShare(null);
        toast.success(`“${folder.name}” is no longer shared`);
      } else {
        const s = await shareFolder(workspaceId, folder.id, next);
        setShare(s);
        toast.success(next === "link" ? "Anyone with the link can open the folder page" : `Shared with the ${team} team`);
      }
      setLevel(next);
      workspaceChanged(workspaceId);
    } catch (e) {
      const st = errorStatus(e);
      setError(
        st === 403 ? "Only admins can share folders in this workspace."
          : st === 404 || st === 405 || st === 501 ? "Folder sharing isn't available on this server yet."
            : e instanceof Error && e.message ? e.message : "That didn't save. Try again.",
      );
    } finally {
      setState("idle");
    }
  }

  const total = share?.total_count ?? folder.total_count;
  const hidden = share?.level === "link" ? share.hidden_count : 0;

  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      {error && <Alert tone="danger">{error}</Alert>}
      <PresetCards<Level>
        legend="Who can open this folder's page"
        name="md-folder-link"
        value={level}
        onChange={(v) => void apply(v)}
        busy={state === "saving"}
        options={[
          { value: "off", label: "Not shared", icon: "lock", hint: `Only people in ${workspaceName} see this folder, here in Markdrop.` },
          { value: "workspace", label: `${team} team`, icon: "user", hint: "A link for teammates. They sign in to open it." },
          { value: "link", label: "Anyone with the link", icon: "globe", hint: "No sign-in. Visitors see only the items open to anyone." },
        ]}
      />
      {state === "saving" && <p className="text-caption text-text-muted" role="status">Saving…</p>}

      {level !== "off" && (
        state === "loading" && !share ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <span className="md-visually-hidden">Loading the folder link</span>
            <Skeleton height={36} />
          </div>
        ) : share ? (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <Input readOnly mono value={share.url} aria-label="Folder link" wrapClassName="min-w-0 flex-1" className="min-w-0 flex-1 bg-surface-inset" onFocus={(e) => e.currentTarget.select()} />
              <CopyButton text={share.url} label="Copy link" variant="primary" size="md" announceText="Folder link copied" />
            </div>
            {share.level === "link" && hidden > 0 && (
              <Alert tone="warning" title={`${hidden} of ${plural(total, "item")} won’t show for visitors`}>
                They&apos;re team-only or private. The folder page lists only what each person can already open.
              </Alert>
            )}
            {share.level === "link" && hidden === 0 && (
              <p className="flex items-center gap-1.5 text-caption text-text-secondary">
                <Icon name="checkCircle" size={14} className="text-success" /> Everything in it is open to anyone with the link.
              </p>
            )}
            {share.level === "workspace" && (
              <p className="text-caption text-text-secondary">
                Teammates see what they can open. People outside {workspaceName} get a sign-in page, then nothing.
              </p>
            )}
          </>
        ) : null
      )}

      <button type="button" onClick={onPreview} className="md-focus cursor-pointer self-start rounded-sm bg-transparent p-0 text-[13px] font-semibold text-accent-text hover:underline hover:underline-offset-3">
        See it as a visitor →
      </button>
    </div>
  );
}
