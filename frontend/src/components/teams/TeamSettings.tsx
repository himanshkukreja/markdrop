"use client";

/**
 * /w/<ws>/teams/<team>/settings: name, icon, colour, description; Open / Private (admins; private says plainly that
 * workspace admins can see it); leads (admins); members (leads and admins; anyone can leave); the team's Slack
 * channel, Jira projects and weekly digest; delete (admins).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Avatar, Button, Checkbox, ConfirmDialog, Dialog, EmptyState, Field, Input, RadioGroup, Select, Skeleton, Switch, Textarea, useToast } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { slackChannels, type SlackChannel } from "@/lib/slack";
import { jiraProjects, type JiraProject } from "@/lib/jira";
import {
  addTeamMembers, browseHref, deleteTeam, getTeamHome, removeTeamMember, setTeamLeads, teamHref, updateTeam,
  type TeamColor, type TeamFull, type Visibility,
} from "@/lib/teams";
import { AdminsNote, ColorSwatches, PeoplePicker, TeamTile, VISIBILITY_OPTIONS, useWorkspaceMembers } from "./parts";
import { Crumbs } from "./TeamHome";
import "./teams.css";

export default function TeamSettings({ ws, team: teamRef }: { ws: string; team: string }) {
  const [team, setTeam] = useState<TeamFull | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const h = await getTeamHome(ws, teamRef);
      if (h.can_read === false) { setError("You can't manage this team."); return; }
      setTeam(h.team as TeamFull); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't load this team."); }
  }, [ws, teamRef]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <div className="tz-page"><Alert tone="danger">{error}</Alert></div>;
  if (!team) return <div className="tz-page" aria-busy="true"><Skeleton variant="text" width={240} height={32} /><Skeleton variant="rect" height={320} className="mt-6" /></div>;
  return (
    <div className="tz-page" data-testid="team-settings">
      <Crumbs ws={ws} trail={[{ label: "Teams", href: browseHref(ws) }, { label: team.name, href: teamHref(ws, team) }, { label: "Settings" }]} />
      <header className="tz-head">
        <div className="tz-head__main">
          <TeamTile team={team} size={40} />
          <div className="tz-head__titles"><h1 className="tz-title">Team settings</h1><p className="tz-sub">{team.name}</p></div>
        </div>
      </header>
      <div className="tz-settings">
        {team.can_manage ? <About ws={ws} team={team} onSaved={setTeam} /> : <Alert tone="neutral">Only this team&apos;s leads and workspace admins change its settings.</Alert>}
        <Visibility_ ws={ws} team={team} onSaved={setTeam} />
        <Members ws={ws} team={team} onSaved={setTeam} />
        {team.can_manage && <Integrations ws={ws} team={team} onSaved={setTeam} />}
        {team.can_admin && <Danger ws={ws} team={team} />}
      </div>
    </div>
  );
}

function useSave(ws: string, team: TeamFull, onSaved: (t: TeamFull) => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const save = async (body: Parameters<typeof updateTeam>[2], ok = "Saved") => {
    setBusy(true);
    try { onSaved(await updateTeam(ws, team.id, body)); toast.success(ok); return true; }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't save"); return false; }
    finally { setBusy(false); }
  };
  return { busy, save };
}

function About({ ws, team, onSaved }: { ws: string; team: TeamFull; onSaved: (t: TeamFull) => void }) {
  const [name, setName] = useState(team.name);
  const [icon, setIcon] = useState(team.icon ?? "");
  const [color, setColor] = useState<TeamColor>(team.color);
  const [description, setDescription] = useState(team.description ?? "");
  const { busy, save } = useSave(ws, team, onSaved);
  const dirty = name !== team.name || (icon || null) !== (team.icon || null) || color !== team.color || description !== (team.description ?? "");
  return (
    <section className="tz-card" aria-labelledby="ts-about">
      <h2 className="tz-h2 mb-3" id="ts-about">About</h2>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save({ name: name.trim(), icon: icon.trim() || null, color, description: description.trim() }); }}>
        <div className="tz-field-row">
          <Field label="Icon" hint="An emoji"><Input className="tz-emoji" value={icon} onChange={(e) => setIcon([...e.target.value].slice(0, 2).join(""))} aria-label="Icon" /></Field>
          <Field label="Name" className="min-w-0 flex-1"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></Field>
        </div>
        <Field label="Colour"><ColorSwatches value={color} onChange={setColor} /></Field>
        <Field label="What it's for"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={280} rows={2} /></Field>
        <div><Button type="submit" loading={busy} disabled={!dirty || !name.trim()}>Save</Button></div>
      </form>
    </section>
  );
}

function Visibility_({ ws, team, onSaved }: { ws: string; team: TeamFull; onSaved: (t: TeamFull) => void }) {
  const { busy, save } = useSave(ws, team, onSaved);
  return (
    <section className="tz-card" aria-labelledby="ts-vis" data-testid="team-visibility">
      <h2 className="tz-h2 mb-1" id="ts-vis">Who can see it</h2>
      {!team.can_admin && <p className="tz-muted mb-3">Workspace admins choose whether a team is open or private.</p>}
      <div className="mt-2 flex flex-col gap-3">
        <RadioGroup name="team-visibility" value={team.visibility} aria-label="Who can see it"
          options={VISIBILITY_OPTIONS.map((o) => ({ ...o, disabled: !team.can_admin || busy }))}
          onChange={(v) => void save({ visibility: v as Visibility }, v === "private" ? "The team is private now" : "The team is open now")} />
        {team.visibility === "private" && team.admins_can_see !== false && <AdminsNote />}
      </div>
    </section>
  );
}

function Members({ ws, team, onSaved }: { ws: string; team: TeamFull; onSaved: (t: TeamFull) => void }) {
  const toast = useToast();
  const router = useRouter();
  const { user } = useAuth();
  const members = useWorkspaceMembers(ws);
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const inTeam = useMemo(() => team.members.map((m) => m.id), [team.members]);
  const leads = team.members.filter((m) => m.role === "lead").map((m) => m.id);
  const run = async (fn: () => Promise<TeamFull>, ok: string) => {
    setBusy(true);
    try { onSaved(await fn()); toast.success(ok); return true; }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't save"); return false; }
    finally { setBusy(false); }
  };
  const mine = team.my_role != null;
  return (
    <section className="tz-card" aria-labelledby="ts-members" data-testid="team-members-settings">
      <div className="tz-sec__head">
        <h2 className="tz-h2" id="ts-members">Members <span className="tz-muted">{team.members.length}</span></h2>
        <div className="flex gap-2">
          {mine && <Button size="sm" variant="ghost" onClick={() => setLeaving(true)}>Leave team</Button>}
          {team.can_manage && <Button size="sm" iconLeft="userPlus" onClick={() => { setPick([]); setAdding(true); }} data-testid="add-members">Add people</Button>}
        </div>
      </div>
      {team.members.length === 0 ? <EmptyState icon="users" title="No members yet" /> : (
        <ul className="tz-members">
          {team.members.map((m) => (
            <li key={m.id} className="tz-member">
              <Avatar name={m.name || m.email} src={m.picture ?? undefined} size="sm" />
              <span className="tz-member__who"><b>{m.name || m.email}{m.id === user?.id ? " (you)" : ""}</b><span>{m.email}</span></span>
              {team.can_admin ? (
                <Select aria-label={`${m.name || m.email}'s role`} value={m.role} disabled={busy || (m.role === "lead" && leads.length === 1)}
                  onChange={(e) => void run(() => setTeamLeads(ws, team.id, e.target.value === "lead" ? [...leads, m.id] : leads.filter((x) => x !== m.id)), "Leads updated")}
                  options={[{ value: "lead", label: "Lead" }, { value: "member", label: "Member" }]} />
              ) : <span className="tz-muted">{m.role === "lead" ? "Lead" : "Member"}</span>}
              {team.can_manage && m.id !== user?.id && (
                <Button size="sm" variant="ghost" disabled={busy || (m.role === "lead" && leads.length === 1)}
                  onClick={() => void run(() => removeTeamMember(ws, team.id, m.id), `${m.name || "They"} left the team`)}>Remove</Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={adding} onClose={() => setAdding(false)} title={`Add people to ${team.name}`} size="md" className="tz-dialog"
        footer={<><Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button><Button loading={busy} disabled={!pick.length} onClick={async () => { if (await run(() => addTeamMembers(ws, team.id, pick), pick.length === 1 ? "Added 1 person" : `Added ${pick.length} people`)) setAdding(false); }} data-testid="add-members-confirm">Add{pick.length ? ` ${pick.length}` : ""}</Button></>}>
        {members ? <PeoplePicker members={members} value={pick} onChange={setPick} exclude={inTeam} label="People" /> : <Skeleton variant="rect" height={200} />}
      </Dialog>
      <ConfirmDialog open={leaving} onClose={() => setLeaving(false)} title={`Leave ${team.name}?`} confirmLabel="Leave team" tone="danger"
        description={team.visibility === "private" ? "You'll lose access to its pages, meetings and memory unless something was shared with you directly." : "You can join again any time: it's an open team."}
        onConfirm={async () => {
          if (!user) return;
          try { await removeTeamMember(ws, team.id, user.id); toast.success(`You left ${team.name}`); router.push(browseHref(ws)); }
          catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't leave"); }
        }} />
    </section>
  );
}

export function Integrations({ ws, team, onSaved, bare }: { ws: string; team: TeamFull; onSaved: (t: TeamFull) => void; bare?: boolean }) {
  const { busy, save } = useSave(ws, team, onSaved);
  const [channels, setChannels] = useState<SlackChannel[] | null | false>(null);
  const [projects, setProjects] = useState<JiraProject[] | null | false>(null);
  const [keys, setKeys] = useState<string[]>(team.jira_projects);
  const [keyText, setKeyText] = useState(team.jira_projects.join(", "));
  useEffect(() => {
    slackChannels(ws).then((r) => setChannels(r.channels)).catch(() => setChannels(false));
    jiraProjects(ws).then((r) => setProjects(r.projects)).catch(() => setProjects(false));
  }, [ws]);
  const digest = team.digest ?? { enabled: false, email: true, slack: false };
  const jiraDirty = (projects ? keys : keyText.split(/[\s,]+/).map((k) => k.trim().toUpperCase()).filter(Boolean)).join(",") !== team.jira_projects.join(",");
  return (
    <section className={bare ? undefined : "tz-card"} aria-labelledby={bare ? undefined : "ts-int"} aria-label={bare ? "Slack, Jira and the weekly digest" : undefined} data-testid="team-integrations">
      {!bare && <h2 className="tz-h2 mb-3" id="ts-int">Slack, Jira and the weekly digest</h2>}
      <div className="flex flex-col gap-5">
        <Field label="Slack channel" hint="The team's meeting posts, weekly brief and comment notices go here.">
          {channels === null ? <Skeleton variant="rect" height={36} /> : channels === false || channels.length === 0 ? (
            <Input value={team.slack_channel?.name ? `#${team.slack_channel.name}` : ""} disabled placeholder="A workspace admin connects Slack in Workspace settings › Integrations" aria-label="Slack channel" />
          ) : (
            <Select aria-label="Slack channel" value={team.slack_channel?.id ?? ""} disabled={busy}
              onChange={(e) => { const c = channels.find((x) => x.id === e.target.value); void save({ slack_channel: c ? { id: c.id, name: c.name } : null }, "Slack channel saved"); }}
              options={[{ value: "", label: "The workspace's channel" }, ...channels.map((c) => ({ value: c.id, label: `${c.private ? "🔒 " : "#"}${c.name}` }))]} />
          )}
        </Field>
        {team.slack_channel && (
          <Switch label="Post new and resolved comments on the team's pages" checked={team.slack_comments !== false} disabled={busy} data-testid="slack-comments"
            onChange={(e) => void save({ slack_comments: e.target.checked }, e.target.checked ? "Comments go to the channel" : "Comments stay out of the channel")} />
        )}
        <div className="flex flex-col gap-2">
          <span className="text-body font-medium">Jira projects</span>
          <p className="tz-muted">The team home shows these projects; issues created from its meetings go to the first one.</p>
          {projects === null ? <Skeleton variant="rect" height={36} /> : projects ? (
            <ul className="tz-picklist" aria-label="Jira projects">
              {projects.map((p) => (
                <li key={p.key}><label>
                  <Checkbox checked={keys.includes(p.key)} onChange={(e) => setKeys(e.target.checked ? [...keys, p.key].slice(0, 10) : keys.filter((k) => k !== p.key))} aria-label={p.name} />
                  <span><b>{p.key}</b> · {p.name}</span>
                </label></li>
              ))}
            </ul>
          ) : (
            <Input value={keyText} onChange={(e) => setKeyText(e.target.value)} placeholder="SALES, MKT" aria-label="Jira project keys" />
          )}
          <div><Button size="sm" variant="secondary" loading={busy} disabled={!jiraDirty}
            onClick={() => void save({ jira_projects: projects ? keys : keyText.split(/[\s,]+/).map((k) => k.trim().toUpperCase()).filter(Boolean).slice(0, 10) }, "Jira projects saved")}>Save Jira projects</Button></div>
        </div>
        <div className="flex flex-col gap-2">
          <Switch label="Send the weekly brief to members" checked={digest.enabled} disabled={busy} data-testid="digest-enabled"
            onChange={(e) => void save({ digest: { ...digest, enabled: e.target.checked } }, e.target.checked ? "Weekly digest on" : "Weekly digest off")} />
          {digest.enabled && (
            <div className="flex flex-wrap gap-4 pl-1">
              <Checkbox label="By email" checked={digest.email} disabled={busy} onChange={(e) => void save({ digest: { ...digest, email: e.target.checked } })} />
              <Checkbox label="In the Slack channel" checked={digest.slack} disabled={busy} onChange={(e) => void save({ digest: { ...digest, slack: e.target.checked } })} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Danger({ ws, team }: { ws: string; team: TeamFull }) {
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <section className="tz-card" aria-labelledby="ts-danger">
      <h2 className="tz-h2 mb-1" id="ts-danger">Delete team</h2>
      <p className="tz-muted mb-3">Its pages, meetings and memory stay. They move to General, or stay in their other teams.</p>
      <Button variant="danger" onClick={() => setOpen(true)}>Delete team</Button>
      <ConfirmDialog open={open} onClose={() => setOpen(false)} tone="danger" title={`Delete ${team.name}?`} confirmLabel="Delete team"
        description="Nothing inside is deleted: its content moves to General (or stays in its other teams). This can't be undone."
        onConfirm={async () => {
          try { await deleteTeam(ws, team.id); toast.success("Team deleted"); router.push(browseHref(ws)); }
          catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't delete"); }
        }} />
    </section>
  );
}
