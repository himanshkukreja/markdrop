"use client";

/**
 * The other Teams screens:
 * - TeamPages   /w/<ws>/teams/<team>/pages — the team's pages, documents and files (items?space=team:<id>), searchable.
 * - ProjectHome /w/<ws>/projects/<project> — a cross-team project space: its pages, meetings, combined memory, linked teams.
 * - CreateProjectDialog (leads of a linked team, admins).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, Avatar, AvatarGroup, Button, Dialog, EmptyState, Field, Input, Skeleton, Textarea, useToast } from "@/components/ui";
import { useAssistantHere } from "@/components/assistant/store";
import { getWorkspace, listWorkspaceItems, type Workspace } from "@/lib/workspaces";
import { listMeetings } from "@/lib/meetings";
import {
  browseHref, createProject, getBrief, getProjectHome, getTeamHome, getTeams, projectHref, reviewHref, teamHref, teamPagesHref,
  type Brief, type ProjectHome as PHome, type TeamCard, type TeamColor, type TeamHome as THome, type TeamHomeLocked, type TeamItem, type TeamMeetingCard, type TeamsSidebar,
} from "@/lib/teams";
import { ColorSwatches, PeoplePicker, TeamChecklist, TeamTile, VisibilityBadge, useWorkspaceMembers } from "./parts";
import { Crumbs, ItemRow, MeetingRow, MemoryCard } from "./TeamHome";
import "./teams.css";

/* ── a team's pages ── */

export function TeamPages({ ws, team: teamRef }: { ws: string; team: string }) {
  const [team, setTeam] = useState<TeamCard | null>(null);
  const [items, setItems] = useState<TeamItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  useAssistantHere({ workspace: ws });
  useEffect(() => {
    getTeamHome(ws, teamRef).then((h) => setTeam(h.team)).catch((e) => setError(e instanceof Error ? e.message : "Couldn't load this team."));
  }, [ws, teamRef]);
  const load = useCallback(async (more?: string | null) => {
    if (!team) return;
    try {
      const r = await listWorkspaceItems(ws, { folder: "all", space: `team:${team.id}`, q: q.trim() || undefined, cursor: more ?? null, limit: 50 });
      setItems((prev) => (more && prev ? [...prev, ...r.items] : r.items)); setCursor(r.next_cursor);
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't load pages."); }
  }, [ws, team, q]);
  useEffect(() => { const t = window.setTimeout(() => void load(), q ? 250 : 0); return () => window.clearTimeout(t); }, [load, q]);
  if (error && !team) return <div className="tz-page"><Alert tone="danger">{error}</Alert></div>;
  const member = !!(team && (team.my_role || team.can_admin));
  return (
    <div className="tz-page" data-testid="team-pages">
      <Crumbs ws={ws} trail={[{ label: "Teams", href: browseHref(ws) }, ...(team ? [{ label: team.name, href: teamHref(ws, team) }] : []), { label: "Pages" }]} />
      <header className="tz-head">
        <div className="tz-head__main">
          {team && <TeamTile team={team} size={40} />}
          <div className="tz-head__titles"><h1 className="tz-title">{team ? `${team.name} pages` : " "}</h1>
            <p className="tz-sub">Pages, documents and files in this team. Share one to another team from its Share menu.</p></div>
        </div>
        {team && member && <div className="tz-actions"><Button iconLeft="plus" href={`/pages/new?workspace=${encodeURIComponent(ws)}&team=${encodeURIComponent(team.id)}`}>New page</Button></div>}
      </header>
      {team?.can_read === false ? <Alert tone="neutral" icon="lock">This is a private team. Only its members see its pages.</Alert> : (
        <>
          <div className="mb-3 max-w-md"><Input iconPrefix="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this team's pages" aria-label="Search this team's pages" /></div>
          <section className="tz-card tz-card--flush">
            {items === null ? <div className="p-3"><Skeleton variant="rect" height={160} /></div> : items.length === 0 ? (
              <EmptyState icon="doc" title={q ? "Nothing matches" : "No pages yet"} description={q ? undefined : member ? "Create one, or move a page here from its Share menu." : undefined} />
            ) : <ul className="tz-rows">{items.map((it) => <ItemRow key={it.slug} it={it} />)}</ul>}
          </section>
          {cursor && <div className="mt-3"><Button variant="secondary" onClick={() => void load(cursor)}>Load more</Button></div>}
        </>
      )}
    </div>
  );
}

/* ── a project space ── */

export function ProjectHome({ ws, project: ref }: { ws: string; project: string }) {
  const [data, setData] = useState<PHome | null>(null);
  const [error, setError] = useState<string | null>(null);
  useAssistantHere({ workspace: ws });
  useEffect(() => { getProjectHome(ws, ref).then(setData).catch((e) => setError(e instanceof Error ? e.message : "Couldn't load this project.")); }, [ws, ref]);
  if (error) return <div className="tz-page"><EmptyState icon="layers" title="Can't open this project" description={error} actions={<Button href={browseHref(ws)}>Browse teams</Button>} /></div>;
  if (!data) return <div className="tz-page" aria-busy="true"><Skeleton variant="text" width={240} height={32} /><Skeleton variant="rect" height={240} className="mt-6" /></div>;
  const p = data.project;
  return (
    <div className="tz-page" data-testid="project-home">
      <Crumbs ws={ws} trail={[...(p.teams[0] ? [{ label: p.teams[0].name, href: teamHref(ws, p.teams[0]) }] : []), { label: p.name }]} />
      <header className="tz-head">
        <div className="tz-head__main">
          <TeamTile team={p} size={44} />
          <div className="tz-head__titles">
            <h1 className="tz-title" dir="auto">{p.name}</h1>
            {p.description && <p className="tz-sub" dir="auto">{p.description}</p>}
            <div className="tz-meta">
              <VisibilityBadge v={p.visibility} />
              <span>Project of {p.teams.map((t) => t.name).join(", ")}</span>
              <span>{p.member_count} people</span>
            </div>
          </div>
        </div>
        <div className="tz-actions">
          <Button variant="secondary" iconLeft="sparkle" href={`/ask?workspace=${encodeURIComponent(ws)}${p.teams[0] ? `&team=${encodeURIComponent(p.teams[0].id)}` : ""}`}>Ask</Button>
        </div>
      </header>
      <div className="tz-grid">
        <div className="tz-col">
          <section className="tz-card tz-card--flush" aria-labelledby="pj-recent">
            <div className="tz-sec__head px-2.5 pt-2.5"><h2 className="tz-h2" id="pj-recent">Pages</h2></div>
            {data.recent.length ? <ul className="tz-rows">{data.recent.map((it) => <ItemRow key={it.slug} it={it} />)}</ul> : <p className="tz-empty">No pages in this project yet. Add one from a page&apos;s Share menu.</p>}
          </section>
          <section className="tz-card tz-card--flush" aria-labelledby="pj-meet">
            <div className="tz-sec__head px-2.5 pt-2.5"><h2 className="tz-h2" id="pj-meet">Meetings</h2></div>
            {data.meetings.length ? <ul className="tz-rows">{data.meetings.map((m) => <MeetingRow key={m.id} m={m} />)}</ul> : <p className="tz-empty">No meetings in this project yet.</p>}
          </section>
        </div>
        <div className="tz-col">
          <MemoryCard memory={data.memory} href={`/team/${encodeURIComponent(ws)}?space=${encodeURIComponent(`project:${p.id}`)}`} />
          <section className="tz-card" aria-labelledby="pj-teams">
            <h2 className="tz-h2 mb-2" id="pj-teams">Teams</h2>
            <ul className="tz-rows">{p.teams.map((t) => (
              <li key={t.id}><Link className="tz-row md-focus" href={teamHref(ws, t)}><TeamTile team={t} size={20} /><span className="tz-row__main"><span className="tz-row__title">{t.name}</span></span></Link></li>
            ))}</ul>
            {p.members.length > 0 && <AvatarGroup className="mt-2">{p.members.slice(0, 10).map((m) => <Avatar key={m.id} name={m.name || m.email} src={m.picture ?? undefined} size="sm" />)}</AvatarGroup>}
          </section>
        </div>
      </div>
    </div>
  );
}

export function CreateProjectDialog({ ws, open, teams, initialTeam, onClose }: { ws: string; open: boolean; teams: TeamCard[]; initialTeam?: string; onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const members = useWorkspaceMembers(ws);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [color, setColor] = useState<TeamColor>("violet");
  const [description, setDescription] = useState("");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [extra, setExtra] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setName(""); setIcon(""); setDescription(""); setTeamIds(initialTeam ? [initialTeam] : []); setExtra([]); } }, [open, initialTeam]);
  const submit = async () => {
    setBusy(true);
    try {
      const p = await createProject(ws, { name: name.trim(), team_ids: teamIds, icon: icon.trim() || null, color, description: description.trim(), member_ids: extra });
      toast.success(`${p.name} is ready`); onClose(); router.push(projectHref(ws, p));
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't create the project"); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} size="lg" className="tz-dialog" dismissible={!busy} title="New project"
      description="A shared space for work across teams (“Q4 launch”): its own pages and meetings, and the memory of every linked team."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!name.trim() || !teamIds.length} onClick={submit} data-testid="create-project">Create project</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="tz-field-row">
          <Field label="Icon" hint="An emoji"><Input className="tz-emoji" value={icon} onChange={(e) => setIcon([...e.target.value].slice(0, 2).join(""))} aria-label="Icon" /></Field>
          <Field label="Name" required className="min-w-0 flex-1"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Q4 launch" autoFocus /></Field>
        </div>
        <Field label="Colour"><ColorSwatches value={color} onChange={setColor} /></Field>
        <Field label="What it's for"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={280} rows={2} /></Field>
        <fieldset className="flex min-w-0 flex-col gap-2"><legend className="mb-1 text-body font-medium">Teams</legend>
          <TeamChecklist teams={teams} value={teamIds} onChange={setTeamIds} label="Linked teams" /></fieldset>
        {members && <fieldset className="flex min-w-0 flex-col gap-2"><legend className="mb-1 text-body font-medium">Also add people</legend>
          <p className="tz-muted">Everyone in the linked teams is in the project already.</p>
          <PeoplePicker members={members} value={extra} onChange={setExtra} label="Extra people" /></fieldset>}
      </form>
    </Dialog>
  );
}

/* ── the company home ── */

export type { THome, TeamHomeLocked };
