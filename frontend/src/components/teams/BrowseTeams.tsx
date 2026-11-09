"use client";

/**
 * /w/<ws>/teams: Browse teams — every team in the workspace (yours, open ones you can join, private ones by name
 * only), admins' suggested teams (from the old Team groups) and "New team" (admins). ?create=1 opens the dialog.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert, Button, Dialog, EmptyState, Field, Input, RadioGroup, Skeleton, Textarea, useToast } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import {
  acceptSuggested, addTeamMembers, browseTeams, createTeam, dismissSuggested, getTeams, reviewHref, teamHref,
  type SuggestedTeam, type TeamCard, type TeamColor, type TeamsSidebar, type Visibility,
} from "@/lib/teams";
import { AdminsNote, ColorSwatches, PeoplePicker, TeamTile, VISIBILITY_OPTIONS, VisibilityBadge, useWorkspaceMembers } from "./parts";
import { Crumbs } from "./TeamHome";
import "./teams.css";

export default function BrowseTeams({ ws }: { ws: string }) {
  const [teams, setTeams] = useState<TeamCard[] | null>(null);
  const [side, setSide] = useState<TeamsSidebar | null>(null);
  const [error, setError] = useState<string | null>(null);
  const params = useSearchParams();
  const router = useRouter();
  const [creating, setCreating] = useState<null | { from?: SuggestedTeam }>(params.get("create") ? {} : null);
  const load = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([browseTeams(ws), getTeams(ws)]);
      setTeams(b.teams); setSide(s); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't load teams."); }
  }, [ws]);
  useEffect(() => { void load(); }, [load]);

  const groups = useMemo(() => {
    const all = teams ?? [];
    return {
      mine: all.filter((t) => t.my_role),
      open: all.filter((t) => !t.my_role && t.visibility === "open"),
      priv: all.filter((t) => !t.my_role && t.visibility === "private"),
    };
  }, [teams]);
  const canCreate = !!side?.can_create;

  return (
    <div className="tz-page" data-testid="browse-teams">
      <Crumbs ws={ws} trail={[{ label: "Teams" }]} />
      <header className="tz-head">
        <div className="tz-head__titles">
          <h1 className="tz-title">Teams</h1>
          <p className="tz-sub">Each team has its own pages, meetings, memory and Ask. Open teams can be browsed by anyone in the workspace; private teams show only their name and weekly brief.</p>
        </div>
        <div className="tz-actions">
          {side?.review?.pending ? <Button variant="secondary" iconLeft="listTree" href={reviewHref(ws)}>Sort content into teams</Button> : null}
          {canCreate && <Button iconLeft="plus" onClick={() => setCreating({})} data-testid="new-team">New team</Button>}
        </div>
      </header>
      {error && <Alert tone="danger" className="mb-4">{error}</Alert>}
      {!teams ? (
        <div className="tz-cards" aria-busy="true">{[0, 1, 2].map((i) => <Skeleton key={i} variant="rect" height={150} />)}</div>
      ) : (
        <>
          {side && side.suggested.length > 0 && (
            <section className="tz-group" aria-labelledby="tz-sugg">
              <h2 id="tz-sugg">Suggested from your groups</h2>
              <div className="tz-cards">
                {side.suggested.map((g) => (
                  <article key={g.group_id} className="tz-tcard" data-testid="suggested-team">
                    <div className="tz-tcard__top">
                      <TeamTile team={{ name: g.name }} size={36} />
                      <div className="min-w-0"><h3 className="tz-tcard__name">{g.name}</h3><p className="tz-muted">{g.member_count} people · from a Team group</p></div>
                    </div>
                    <div className="tz-tcard__foot">
                      <Button size="sm" onClick={() => setCreating({ from: g })}>Make it a team</Button>
                      <Button size="sm" variant="ghost" onClick={async () => { await dismissSuggested(ws, g.group_id).catch(() => undefined); void load(); }}>Dismiss</Button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
          {teams.length === 0 ? (
            <EmptyState icon="users" title="No teams yet"
              description={canCreate ? "Make a team for each group that works together: Sales, Marketing, Engineering. Each gets its own space." : "A workspace admin creates teams. Ask one to set them up."}
              actions={canCreate ? <Button iconLeft="plus" onClick={() => setCreating({})}>New team</Button> : undefined} />
          ) : (
            <>
              <TeamGroup ws={ws} title="Your teams" teams={groups.mine} onChange={load} />
              <TeamGroup ws={ws} title="Open teams" teams={groups.open} onChange={load} />
              <TeamGroup ws={ws} title="Private teams" teams={groups.priv} onChange={load} />
            </>
          )}
        </>
      )}
      <CreateTeamDialog ws={ws} open={!!creating} from={creating?.from} onClose={() => setCreating(null)}
        onCreated={(t) => { setCreating(null); router.push(teamHref(ws, t)); }} />
    </div>
  );
}

function TeamGroup({ ws, title, teams, onChange }: { ws: string; title: string; teams: TeamCard[]; onChange: () => void }) {
  if (!teams.length) return null;
  const id = `tz-g-${title.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <section className="tz-group" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <div className="tz-cards">{teams.map((t) => <TeamCardView key={t.id} ws={ws} t={t} onChange={onChange} />)}</div>
    </section>
  );
}

function TeamCardView({ ws, t, onChange }: { ws: string; t: TeamCard; onChange: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <article className="tz-tcard" data-testid={`team-card-${t.slug}`}>
      <div className="tz-tcard__top">
        <TeamTile team={t} size={36} />
        <div className="min-w-0">
          <h3 className="tz-tcard__name"><Link href={teamHref(ws, t)} className="md-focus">{t.name}</Link></h3>
          <p className="tz-muted">{t.member_count} {t.member_count === 1 ? "member" : "members"}{t.my_role === "lead" ? " · You lead it" : t.my_role ? " · You're in it" : ""}</p>
        </div>
      </div>
      {t.description && <p className="tz-tcard__desc" dir="auto">{t.description}</p>}
      <div className="tz-tcard__foot">
        <VisibilityBadge v={t.visibility} />
        {!t.my_role && t.visibility === "open" && user ? (
          <Button size="sm" variant="secondary" loading={busy} onClick={async () => {
            setBusy(true);
            try { await addTeamMembers(ws, t.id, [user.id]); toast.success(`You joined ${t.name}`); onChange(); }
            catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't join"); }
            finally { setBusy(false); }
          }}>Join</Button>
        ) : !t.can_read ? <span className="tz-muted">Brief only</span> : (
          <Button size="sm" variant="ghost" href={teamHref(ws, t)}>Open</Button>
        )}
      </div>
    </article>
  );
}

export function CreateTeamDialog({ ws, open, from, onClose, onCreated }: {
  ws: string; open: boolean; from?: SuggestedTeam; onClose: () => void; onCreated: (t: TeamCard) => void;
}) {
  const toast = useToast();
  const { user } = useAuth();
  const members = useWorkspaceMembers(ws);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [color, setColor] = useState<TeamColor>("blue");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("open");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [leadIds, setLeadIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(from?.name ?? ""); setIcon(""); setColor("blue"); setDescription(""); setVisibility("open");
    setMemberIds(from?.member_ids ?? []); setLeadIds(user ? [user.id] : []);
  }, [open, from, user]);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const leads = leadIds.length ? leadIds : user ? [user.id] : [];
      const t = from
        ? await acceptSuggested(ws, from.group_id, { name: name.trim(), visibility, lead_ids: leads })
        : await createTeam(ws, { name: name.trim(), icon: icon.trim() || null, color, description: description.trim(), visibility, lead_ids: leads, member_ids: [...new Set([...memberIds, ...leads])] });
      toast.success(`${t.name} is ready`);
      onCreated(t);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't create the team"); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} size="lg" dismissible={!busy} className="tz-dialog"
      title={from ? `Make “${from.name}” a team` : "New team"}
      description="A team gets its own pages, meetings, memory and Ask. People can be in several teams."
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={submit} loading={busy} disabled={!name.trim()} data-testid="create-team">{from ? "Create team" : "Create team"}</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="tz-field-row">
          <Field label="Icon" hint="An emoji"><Input className="tz-emoji" value={icon} onChange={(e) => setIcon([...e.target.value].slice(0, 2).join(""))} placeholder="🚀" aria-label="Icon" /></Field>
          <Field label="Name" required className="min-w-0 flex-1"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Sales" autoFocus data-testid="team-name" /></Field>
        </div>
        {!from && <Field label="Colour"><ColorSwatches value={color} onChange={setColor} /></Field>}
        {!from && <Field label="What it's for"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={280} rows={2} placeholder="Pipeline, deals and customer calls." /></Field>}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-body font-medium">Who can see it</legend>
          <RadioGroup name="visibility" value={visibility} onChange={(v) => setVisibility(v as Visibility)} options={VISIBILITY_OPTIONS} aria-label="Who can see it" />
          {visibility === "private" && <AdminsNote />}
        </fieldset>
        {members && (
          <>
            <fieldset className="flex min-w-0 flex-col gap-2">
              <legend className="mb-1 text-body font-medium">Leads</legend>
              <p className="tz-muted">Leads add and remove members and edit the weekly brief.</p>
              <PeoplePicker members={members} value={leadIds} onChange={setLeadIds} label="Leads" />
            </fieldset>
            {!from && (
              <fieldset className="flex min-w-0 flex-col gap-2">
                <legend className="mb-1 text-body font-medium">Members</legend>
                <PeoplePicker members={members} value={memberIds} onChange={setMemberIds} exclude={leadIds} label="Members" />
              </fieldset>
            )}
          </>
        )}
      </form>
    </Dialog>
  );
}
