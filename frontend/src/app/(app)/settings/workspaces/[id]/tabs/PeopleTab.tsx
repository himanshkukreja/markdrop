"use client";

import { useMemo, useState } from "react";
import {
  Avatar, Badge, Button, ConfirmDialog, Dialog, Field, Input, RadioGroup, RowMenu, Select, Skeleton, useToast,
} from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { PresetCards } from "@/components/access/PresetCards";
import { ROLE_HINT, ROLE_WORDS, teamName } from "@/components/workspace/folder/items";
import {
  inviteMember, removeMember, revokeInvitation, setMemberRole, updateWorkspace,
  type Invitation, type ItemAccess, type Member, type Role,
} from "@/lib/workspaces";
import { relativeDays } from "../../../settings-shared";
import { Locked, lockProps, type WsTabProps } from "../ws-shared";

type InviteRole = Exclude<Role, "owner">;
type Privacy = "open" | "team" | "locked";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROLE_SELECT = [
  { value: "viewer", label: "Can view" },
  { value: "member", label: "Can edit" },
  { value: "admin", label: "Admin" },
];

const ROLE_CHOICES = [
  { value: "viewer", label: "Can view", description: "Read what the workspace publishes." },
  { value: "member", label: "Can edit", description: "Add and change files." },
  { value: "admin", label: "Admin", description: "Also invite people and manage folders." },
];

/** The privacy preset the stored settings amount to, or null ("Custom") when they match none. */
export function privacyOf(requireAuth: boolean, defaultAccess: ItemAccess): Privacy | null {
  if (!requireAuth && defaultAccess === "link") return "open";
  if (!requireAuth && defaultAccess === "workspace") return "team";
  if (requireAuth && defaultAccess === "workspace") return "locked";
  return null;
}

const PRESET: Record<Privacy, { require_auth_to_view: boolean; default_access: ItemAccess }> = {
  open: { require_auth_to_view: false, default_access: "link" },
  team: { require_auth_to_view: false, default_access: "workspace" },
  locked: { require_auth_to_view: true, default_access: "workspace" },
};

/**
 * People (Settings board): Privacy (Open · Team · Locked, mapped onto the existing settings; "Custom"
 * when Advanced doesn't match one), then everyone in the workspace with a three-role select
 * (Can view · Can edit · Admin; the owner is a badge), pending invitations, and Invite people.
 */
export default function PeopleTab({ id, ws, isAdmin, meId, members, invites, refresh, setWs }: WsTabProps) {
  const toast = useToast();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const [inviteError, setInviteError] = useState("");
  const [busy, setBusy] = useState("");
  const [removing, setRemoving] = useState<Member | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const team = teamName(ws);
  const defaultAccess: ItemAccess = ws.settings.default_access ?? ws.default_access ?? "workspace";
  // The server says which preset the settings amount to; older servers: work it out the same way.
  const privacy = ws.privacy ? (ws.privacy === "custom" ? null : ws.privacy) : privacyOf(ws.settings.require_auth_to_view, defaultAccess);

  const pending = useMemo(() => (invites ?? []).filter((i) => i.status === "pending"), [invites]);
  const people = useMemo(() => {
    const order: Record<string, number> = { owner: 0, admin: 1, member: 2, viewer: 3 };
    return [...(members ?? [])].sort((a, b) =>
      (a.user_id === ws.owner_id ? -1 : 0) - (b.user_id === ws.owner_id ? -1 : 0) || (order[a.role] ?? 9) - (order[b.role] ?? 9));
  }, [members, ws.owner_id]);

  async function choosePrivacy(p: Privacy) {
    if (!isAdmin || p === privacy) return;
    setBusy("privacy");
    try {
      setWs(await updateWorkspace(id, { settings: { ...ws.settings, ...PRESET[p] } }));
      toast.success(p === "open" ? "Open: links work for anyone they're open to." : p === "team" ? "Team: new items are for the team." : "Locked: only members and people added by name.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That didn't save. Try again.");
    } finally {
      setBusy("");
    }
  }

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    const list = email.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    const bad = list.find((x) => !EMAIL.test(x));
    if (!list.length || bad) { setInviteError(`Enter an email address like name@company.com${bad ? ` (“${bad}” isn't one)` : ""}.`); return; }
    setBusy("invite");
    setInviteError("");
    try {
      for (const to of list) await inviteMember(id, to, role);
      await refresh("people");
      setInviteOpen(false);
      setEmail("");
      toast.success(list.length === 1 ? `Invitation sent to ${list[0]}.` : `${list.length} invitations sent.`);
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
      toast.success(`${m.name || m.email}: ${ROLE_WORDS[next]}.`);
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

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section aria-labelledby="ws-privacy-h" className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 id="ws-privacy-h" className="text-h3 text-text">Privacy</h2>
          {!privacy && <Badge size="sm" tone="info">Custom</Badge>}
          <ReadMore topic="workspacePrivacy" className="ml-auto text-caption" />
        </div>
        <PresetCards<Privacy>
          legend="Privacy"
          legendHidden
          name="ws-privacy"
          layout="auto"
          value={privacy}
          onChange={(v) => void choosePrivacy(v)}
          disabled={!isAdmin || busy === "privacy"}
          busy={busy === "privacy"}
          options={[
            { value: "open", label: "Open", hint: "Links work for anyone. Each item still chooses who can open it." },
            { value: "team", label: "Team", hint: "New items are for the team. Public links stay possible, one by one." },
            { value: "locked", label: "Locked", hint: "Only members and people added by name. No public links." },
          ]}
        />
        {!privacy && (
          <p className="text-caption text-text-muted">
            Custom: the switches in Advanced don&apos;t match a preset. Pick one to replace them.
          </p>
        )}
        {!isAdmin && <p className="text-caption text-text-muted">Only admins change privacy.</p>}
      </section>

      <section aria-labelledby="ws-people-h" className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-5">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h2 id="ws-people-h" className="flex-1 text-h3 text-text">People</h2>
          <Locked locked={!isAdmin}>
            <Button variant="primary" iconLeft="plus" {...lockProps(!isAdmin)}
              onClick={isAdmin ? () => { setInviteOpen(true); setInviteError(""); } : lockProps(true).onClick}>
              Invite people
            </Button>
          </Locked>
        </div>
        <p className="text-caption text-text-muted">{ROLE_HINT} <ReadMore topic="members" /></p>

        {members === null ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading people">
            {[0, 1, 2].map((i) => <Skeleton key={i} variant="rect" height={52} />)}
          </div>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {people.map((m) => {
              const owner = m.user_id === ws.owner_id || m.role === "owner";
              const editable = isAdmin && !owner && m.user_id !== meId;
              return (
                <li key={m.user_id} className="flex min-w-0 flex-wrap items-center gap-3 border-t border-border py-2.5">
                  <Avatar name={m.name || m.email || "?"} size="md" />
                  <div className="min-w-0 flex-[1_1_220px]">
                    <div className="truncate text-body-strong text-text" dir="auto">
                      {m.name || m.email}
                      {m.user_id === meId && <span className="font-normal text-text-muted"> (you)</span>}
                    </div>
                    {m.name && <div className="truncate text-caption text-text-muted">{m.email}</div>}
                  </div>
                  {owner ? (
                    <Badge tone="info">Owner</Badge>
                  ) : editable ? (
                    <Select
                      aria-label={`Role for ${m.name || m.email}`}
                      value={m.role}
                      disabled={busy === `r${m.user_id}`}
                      options={ROLE_SELECT}
                      onChange={(e) => void changeRole(m, e.target.value as InviteRole)}
                      className="w-[132px]"
                    />
                  ) : (
                    <span className="text-[13px] text-text-secondary">{ROLE_WORDS[m.role] ?? m.role}</span>
                  )}
                  {editable && (
                    <RowMenu portal align="right" label={`More actions for ${m.name || m.email}`}
                      items={[{ label: "Remove from workspace", icon: "userX", danger: true, onClick: () => setRemoving(m) }]} />
                  )}
                </li>
              );
            })}
            {pending.map((i) => (
              <li key={i.id} className="flex min-w-0 flex-wrap items-center gap-3 border-t border-border py-2.5">
                <Avatar name={i.email} size="md" neutral />
                <div className="min-w-0 flex-[1_1_220px]">
                  <div className="truncate text-body-strong text-text">{i.email}</div>
                  <div className="flex flex-wrap items-center gap-x-1 text-caption text-text-muted">
                    <span>Invite sent {relativeDays(i.created_at).toLowerCase()} · {ROLE_WORDS[i.role] ?? i.role}</span>
                    {isAdmin && (
                      <>
                        <span aria-hidden>·</span>
                        <button type="button" className="md-focus cursor-pointer rounded-sm bg-transparent p-0 font-semibold text-accent-text hover:underline disabled:opacity-60"
                          disabled={busy === `ri${i.id}`} onClick={() => void resend(i)} aria-label={`Resend the invitation to ${i.email}`}>
                          Resend
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <Badge tone="warning" icon="clock">Invited</Badge>
                {isAdmin && (
                  <RowMenu portal align="right" label={`More actions for ${i.email}`}
                    items={[{ label: "Revoke invitation", icon: "x", danger: true, onClick: () => setRevoking(i) }]} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog
        open={inviteOpen}
        onClose={() => busy !== "invite" && setInviteOpen(false)}
        dismissible={busy !== "invite"}
        title={`Invite people to ${ws.name}`}
        description={`They get an email with a link, and can open everything the ${team} team can once they accept.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setInviteOpen(false)} disabled={busy === "invite"}>Cancel</Button>
            <Button variant="primary" type="submit" form="invite-form" iconLeft="send" loading={busy === "invite"}>Send invitation</Button>
          </>
        }
      >
        <form id="invite-form" onSubmit={sendInvite} className="flex min-w-0 flex-col gap-5" noValidate>
          <Field label="Email addresses" error={inviteError || undefined} hint="Separate several with commas.">
            <Input type="text" inputMode="email" value={email} onChange={(e) => { setEmail(e.target.value); if (inviteError) setInviteError(""); }} placeholder="name@company.com, …" autoComplete="off" />
          </Field>
          <div className="flex flex-col gap-2">
            <span id="invite-role" className="md-field__label">Their access</span>
            <RadioGroup
              name="invite-role"
              aria-labelledby="invite-role"
              value={role}
              onChange={(v) => setRole(v as InviteRole)}
              options={ROLE_CHOICES}
            />
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={removing ? `Remove ${removing.name || removing.email}?` : "Remove member?"}
        body="They lose access to this workspace right away. Files they added stay in the workspace, and they still own them."
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
