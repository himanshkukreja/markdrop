"use client";

import { useMemo, useState } from "react";
import {
  Avatar, Badge, Button, ConfirmDialog, Dialog, Disclosure, Field, Input, RadioGroup, RowMenu, Select,
  Skeleton, Table, useToast, type Column,
} from "@/components/ui";
import {
  inviteMember, removeMember, revokeInvitation, setMemberRole,
  type Invitation, type Member, type Role,
} from "@/lib/workspaces";
import { relativeDays, shortDate } from "../../../settings-shared";
import { Locked, ROLE_LABEL, ROLE_OPTIONS, SectionHead, lockProps, type WsTabProps } from "../ws-shared";

type InviteRole = Exclude<Role, "owner">;
const ROLE_SELECT = ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.label }));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function expiryBadge(iso: string) {
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  const soon = days <= 1;
  return (
    <Badge size="sm" tone={soon ? "warning" : "neutral"} icon="clock">
      {days < 0 ? "Expired" : days === 0 ? "Expires today" : days === 1 ? "Expires tomorrow" : `Expires in ${days} days`}
    </Badge>
  );
}

/**
 * People (REVAMP_PLAN 7.12): invite dialog with role descriptions; members with a labelled role
 * Select and Remove (confirmed); pending invitations with Resend and Revoke (confirmed); history in
 * a Disclosure. Tables on wide screens, stacked rows on phones.
 */
export default function PeopleTab({ id, ws, isAdmin, meId, members, invites, refresh }: WsTabProps) {
  const toast = useToast();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const [inviteError, setInviteError] = useState("");
  const [busy, setBusy] = useState("");
  const [removing, setRemoving] = useState<Member | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);

  const pending = useMemo(() => (invites ?? []).filter((i) => i.status === "pending"), [invites]);
  const resolved = useMemo(() => (invites ?? []).filter((i) => i.status !== "pending"), [invites]);
  const historySummary = useMemo(() => {
    const c: Record<string, number> = {};
    resolved.forEach((i) => { c[i.status] = (c[i.status] ?? 0) + 1; });
    return Object.entries(c).map(([k, n]) => `${n} ${k}`).join(" · ");
  }, [resolved]);

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    const to = email.trim();
    if (!EMAIL.test(to)) { setInviteError("Enter an email address like name@company.com."); return; }
    setBusy("invite");
    setInviteError("");
    try {
      await inviteMember(id, to, role);
      await refresh("people");
      setInviteOpen(false);
      setEmail("");
      toast.success(`Invitation sent to ${to}.`);
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Couldn't send the invitation. Try again.");
    } finally {
      setBusy("");
    }
  }

  async function changeRole(m: Member, next: InviteRole) {
    setBusy(`r${m.user_id}`);
    try {
      await setMemberRole(id, m.user_id, next);
      await refresh("people");
      toast.success(`${m.name || m.email} is now ${ROLE_LABEL[next].toLowerCase() === "admin" ? "an admin" : `a ${ROLE_LABEL[next].toLowerCase()}`}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't change the role. Try again.");
    } finally {
      setBusy("");
    }
  }

  async function resend(i: Invitation) {
    setBusy(`ri${i.id}`);
    try {
      await inviteMember(id, i.email, i.role as InviteRole);
      await refresh("people");
      toast.success(`Invitation resent to ${i.email}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't resend the invitation. Try again.");
    } finally {
      setBusy("");
    }
  }

  const who = (m: Member) => (
    <span className="flex min-w-0 items-center gap-3">
      <Avatar name={m.name || m.email || "?"} size="md" />
      <span className="min-w-0">
        <span className="block truncate text-body-strong text-text" dir="auto">
          {m.name || m.email}
          {m.user_id === meId && <span className="font-normal text-text-muted"> (you)</span>}
        </span>
        {m.name && <span className="block truncate text-caption text-text-muted">{m.email}</span>}
      </span>
    </span>
  );

  const roleCell = (m: Member) => {
    const label = `Role for ${m.name || m.email}`;
    if (m.user_id === ws.owner_id || m.role === "owner") return <Badge size="sm" tone="info" icon="user">Owner</Badge>;
    if (!isAdmin || m.user_id === meId) return <Badge size="sm">{ROLE_LABEL[m.role] ?? m.role}</Badge>;
    return (
      <Select
        aria-label={label}
        value={m.role}
        disabled={busy === `r${m.user_id}`}
        options={ROLE_SELECT}
        onChange={(e) => changeRole(m, e.target.value as InviteRole)}
        className="min-w-[120px]"
      />
    );
  };

  const memberMenu = (m: Member) =>
    isAdmin && m.user_id !== ws.owner_id && m.user_id !== meId ? (
      <RowMenu portal align="right" label={`More actions for ${m.name || m.email}`}
        items={[{ label: "Remove from workspace", icon: "userX", danger: true, onClick: () => setRemoving(m) }]} />
    ) : null;

  const memberCols: Column<Member>[] = [
    { key: "member", header: "Member", render: who },
    { key: "role", header: "Role", width: 150, render: roleCell },
    { key: "joined", header: "Joined", width: 96, render: (m) => shortDate(m.created_at) },
    { key: "menu", header: <span className="md-visually-hidden">Actions</span>, width: 56, align: "right", render: (m) => memberMenu(m) },
  ];

  const inviteActions = (i: Invitation) =>
    isAdmin ? (
      <span className="flex items-center justify-end gap-1">
        <Button size="sm" variant="secondary" loading={busy === `ri${i.id}`} onClick={() => resend(i)} aria-label={`Resend invitation to ${i.email}`}>Resend</Button>
        <Button size="sm" variant="ghost" className="text-danger" onClick={() => setRevoking(i)} aria-label={`Revoke invitation to ${i.email}`}>Revoke</Button>
      </span>
    ) : null;

  const invitee = (i: Invitation) => (
    <span className="flex min-w-0 items-center gap-3">
      <Avatar name={i.email} size="md" neutral />
      <span className="min-w-0">
        <span className="block truncate text-body-strong text-text">{i.email}</span>
        <span className="block truncate text-caption text-text-muted">
          Invited{i.invited_by_name ? ` by ${i.invited_by_name}` : ""} on {shortDate(i.created_at)}
        </span>
      </span>
    </span>
  );

  const pendingCols: Column<Invitation>[] = [
    { key: "who", header: "Invitee", render: invitee },
    { key: "role", header: "Role", width: 96, render: (i) => ROLE_LABEL[i.role] ?? i.role },
    { key: "exp", header: "Expires", width: 150, render: (i) => expiryBadge(i.expires_at) },
    { key: "act", header: <span className="md-visually-hidden">Actions</span>, width: 170, align: "right", render: inviteActions },
  ];

  const inviteButton = (
    <Locked locked={!isAdmin}>
      <Button variant="primary" iconLeft="userPlus" {...lockProps(!isAdmin)}
        onClick={isAdmin ? () => { setInviteOpen(true); setInviteError(""); } : lockProps(true).onClick}>
        Invite people
      </Button>
    </Locked>
  );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <SectionHead
        title="People"
        description="Roles decide who can publish here and who can change branding, domains and people."
        actions={inviteButton}
      />

      <section aria-label="Members" className="min-w-0">
        {members === null ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading members">
            {[0, 1, 2].map((i) => <Skeleton key={i} variant="rect" height={52} />)}
          </div>
        ) : (
          <>
            <Table<Member> className="hidden sm:block" columns={memberCols} rows={members} rowKey={(m) => m.user_id} hover={false} caption="Members" />
            <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface sm:hidden">
              {members.map((m) => (
                <li key={m.user_id} className="flex min-w-0 flex-col gap-2 px-4 py-3">
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    {who(m)}
                    {memberMenu(m)}
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-2 pl-11">
                    {roleCell(m)}
                    <span className="text-caption text-text-muted">Joined {shortDate(m.created_at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {pending.length > 0 && (
        <section aria-labelledby="ws-pending" className="flex min-w-0 flex-col gap-3">
          <div>
            <h3 id="ws-pending" className="flex items-center gap-2 text-h4 text-text">
              Pending invitations <Badge size="sm">{pending.length}</Badge>
            </h3>
            <p className="mt-0.5 text-body text-text-muted">They get an email with a link. Nothing changes until they accept it.</p>
          </div>
          <Table<Invitation> className="hidden sm:block" columns={pendingCols} rows={pending} rowKey={(i) => i.id} hover={false} caption="Pending invitations" />
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface sm:hidden">
            {pending.map((i) => (
              <li key={i.id} className="flex min-w-0 flex-col gap-2 px-4 py-3">
                {invitee(i)}
                <div className="flex min-w-0 flex-wrap items-center gap-2 pl-11">
                  {expiryBadge(i.expires_at)}
                  <span className="text-caption text-text-muted">{ROLE_LABEL[i.role] ?? i.role}</span>
                </div>
                {isAdmin && <div className="pl-11">{inviteActions(i)}</div>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {resolved.length > 0 && (
        <Disclosure
          summary={<span className="flex flex-wrap items-baseline gap-x-2">Invitation history <span className="text-caption font-normal text-text-muted">{historySummary}</span></span>}
          className="rounded-xl border border-border bg-surface"
          buttonClassName="w-full px-4 py-3 text-body-strong"
          panelClassName="border-t border-border"
        >
          <ul className="flex flex-col divide-y divide-border">
            {resolved.map((i) => (
              <li key={i.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate text-body text-text-secondary">{i.email}</span>
                <Badge size="sm" tone={i.status === "accepted" ? "success" : i.status === "declined" ? "danger" : "neutral"}
                  icon={i.status === "accepted" ? "check" : i.status === "declined" ? "x" : i.status === "expired" ? "clock" : "minus"}>
                  {i.status.charAt(0).toUpperCase() + i.status.slice(1)}
                </Badge>
                <span className="w-28 shrink-0 text-right text-caption text-text-muted">{i.responded_at ? relativeDays(i.responded_at) : ""}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}

      <Dialog
        open={inviteOpen}
        onClose={() => busy !== "invite" && setInviteOpen(false)}
        dismissible={busy !== "invite"}
        title="Invite people"
        description="They get an email with a link. Nothing changes until they accept it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setInviteOpen(false)} disabled={busy === "invite"}>Cancel</Button>
            <Button variant="primary" type="submit" form="invite-form" iconLeft="send" loading={busy === "invite"}>Send invitation</Button>
          </>
        }
      >
        <form id="invite-form" onSubmit={sendInvite} className="flex min-w-0 flex-col gap-5" noValidate>
          <Field label="Email" error={inviteError || undefined}>
            <Input type="email" value={email} onChange={(e) => { setEmail(e.target.value); if (inviteError) setInviteError(""); }} placeholder="name@company.com" autoComplete="email" />
          </Field>
          <div className="flex flex-col gap-2">
            <span id="invite-role" className="md-field__label">Role</span>
            <RadioGroup
              name="invite-role"
              aria-labelledby="invite-role"
              value={role}
              onChange={(v) => setRole(v as InviteRole)}
              options={ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.label, description: o.description }))}
            />
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={removing ? `Remove ${removing.name || removing.email}?` : "Remove member?"}
        body="They lose access to this workspace's library and settings right away. Documents they shared stay in the workspace, and they still own them."
        confirmLabel="Remove from workspace"
        onConfirm={async () => {
          const m = removing!;
          await removeMember(id, m.user_id);
          setRemoving(null);
          await refresh("people");
          toast.success(`${m.name || m.email} was removed.`);
        }}
      />
      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title={revoking ? `Revoke the invitation to ${revoking.email}?` : "Revoke invitation?"}
        body="The link in their email stops working. You can invite them again later."
        confirmLabel="Revoke invitation"
        onConfirm={async () => {
          const i = revoking!;
          await revokeInvitation(id, i.id);
          setRevoking(null);
          await refresh("people");
          toast.success("Invitation revoked.");
        }}
      />
    </div>
  );
}
