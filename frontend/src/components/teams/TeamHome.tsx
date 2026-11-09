"use client";

/**
 * /w/<ws>/teams/<team>: a team's home — its weekly brief (leads edit or hide lines), recent pages, meetings, memory
 * highlights, its Jira projects and members. A private team you're not in shows only its name and brief (the
 * bridge between teams). Everything arrives filtered for the viewer (contract §2).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Alert, Avatar, Button, Dropdown, EmptyState, FileIcon, Icon, IconButton, Input, Skeleton, Textarea, useToast } from "@/components/ui";
import type { FileRenderer } from "@/components/ui/markdrop";
import { useAuth } from "@/contexts/AuthContext";
import { useWorkspaceTree } from "@/lib/workspaceStore";
import { useAssistantHere } from "@/components/assistant/store";
import { jiraTeam, type JiraTeam } from "@/lib/jira";
import {
  addBriefLine, addTeamMembers, draftBrief, editBriefLine, getBrief, getTeamHome, listBriefs, projectHref, teamAskHref, teamMeetingsHref,
  teamMemoryHref, teamPagesHref, teamSettingsHref,
  type Brief, type BriefKind, type BriefSummary, type MemoryHighlights, type ProjectCard, type TeamHome as Home, type TeamHomeLocked, type TeamItem, type TeamMeetingCard,
} from "@/lib/teams";
import { AdminsNote, TeamTile, VisibilityBadge, fmtShortDate } from "./parts";
import { CreateProjectDialog } from "./TeamSpaces";
import { teamsSlot } from "@/lib/teamsStore";
import "./teams.css";

const KIND_ICON: Record<BriefKind, string> = { shipped: "checkCircle", decision: "flag", update: "refresh", blocker: "alert", focus: "zap", note: "message" };
const KIND_LABEL: Record<BriefKind, string> = { shipped: "Shipped", decision: "Decision", update: "Update", blocker: "Blocker", focus: "Focus", note: "Note" };

export function Crumbs({ ws, trail }: { ws: string; trail: { label: string; href?: string }[] }) {
  // The workspace's name from the shared tree cache (the rail loads it for the workspace you're in).
  const wsName = useWorkspaceTree(ws).tree?.workspace.name;
  return (
    <nav className="tz-crumbs" aria-label="Breadcrumb">
      <Link href={`/w/${encodeURIComponent(ws)}/home`}>{wsName || "Company"}</Link>
      {trail.map((t, i) => (
        <span key={i} className="contents">
          <Icon name="chevronRight" />
          {t.href ? <Link href={t.href}>{t.label}</Link> : <span aria-current="page">{t.label}</span>}
        </span>
      ))}
    </nav>
  );
}

export default function TeamHome({ ws, team: teamRef }: { ws: string; team: string }) {
  const [data, setData] = useState<Home | TeamHomeLocked | null>(null);
  const [error, setError] = useState<{ msg: string; status: number } | null>(null);
  const params = useSearchParams();
  const briefId = params.get("brief");
  const load = useCallback(async () => {
    try { setData(await getTeamHome(ws, teamRef)); setError(null); }
    catch (e) { setError({ msg: e instanceof Error ? e.message : "Couldn't load this team.", status: (e as { status?: number }).status ?? 0 }); }
  }, [ws, teamRef]);
  useEffect(() => { void load(); }, [load]);
  const t = data?.team;
  useAssistantHere({ workspace: ws });

  if (error && !data) {
    return (
      <div className="tz-page">
        {error.status === 404
          ? <EmptyState icon="users" title="This team doesn't exist" description="It may have been deleted, or the link is wrong." actions={<Button href={`/w/${encodeURIComponent(ws)}/teams`}>Browse teams</Button>} />
          : <Alert tone="danger">{error.msg}</Alert>}
      </div>
    );
  }
  if (!data || !t) {
    return (
      <div className="tz-page" aria-busy="true">
        <Skeleton variant="text" width={220} height={32} />
        <div className="tz-grid" style={{ marginTop: 24 }}>
          <div className="tz-col"><Skeleton variant="rect" height={220} /><Skeleton variant="rect" height={160} /></div>
          <div className="tz-col"><Skeleton variant="rect" height={180} /></div>
        </div>
      </div>
    );
  }
  const locked = data.can_read === false;
  const home = locked ? null : (data as Home);
  return (
    <div className="tz-page" data-testid="team-home">
      <Crumbs ws={ws} trail={[{ label: "Teams", href: `/w/${encodeURIComponent(ws)}/teams` }, { label: t.name }]} />
      <header className="tz-head">
        <div className="tz-head__main">
          <TeamTile team={t} size={44} />
          <div className="tz-head__titles">
            <h1 className="tz-title" dir="auto">{t.name}</h1>
            {t.description && <p className="tz-sub" dir="auto">{t.description}</p>}
            <div className="tz-meta">
              <VisibilityBadge v={t.visibility} />
              <span>{t.member_count} {t.member_count === 1 ? "member" : "members"}</span>
              {t.my_role === "lead" && <span>You lead this team</span>}
              {t.my_role === "member" && <span>You&apos;re a member</span>}
            </div>
          </div>
        </div>
        <div className="tz-actions">
          {!locked && <Button variant="secondary" iconLeft="sparkle" href={teamAskHref(ws, t)}>Ask {t.name}</Button>}
          {!locked && (t.my_role || t.can_admin) && <Button iconLeft="plus" href={`/pages/new?workspace=${encodeURIComponent(ws)}&team=${encodeURIComponent(t.id)}`}>New page</Button>}
          {!t.my_role && t.visibility === "open" && <JoinButton ws={ws} teamId={t.id} onJoined={load} />}
          {t.can_manage && <IconButton icon="settings" label="Team settings" variant="secondary" href={teamSettingsHref(ws, t)} />}
        </div>
      </header>

      {locked ? (
        <div className="tz-col" style={{ maxWidth: 760 }}>
          <Alert tone="neutral" icon="lock" title="This is a private team">
            Only its members see its pages, meetings and memory. Ask one of its leads to add you. Here&apos;s what it shared this week.
          </Alert>
          <BriefCard ws={ws} teamId={t.id} initial={data.brief} briefId={briefId} />
        </div>
      ) : (
        <div className="tz-grid">
          <div className="tz-col">
            <BriefCard ws={ws} teamId={t.id} initial={home!.brief} briefId={briefId} />
            <RecentCard ws={ws} items={home!.recent} href={teamPagesHref(ws, t)} />
            <MeetingsCard ws={ws} meetings={home!.meetings} href={teamMeetingsHref(ws, t)} />
          </div>
          <div className="tz-col">
            <MemoryCard memory={home!.memory} href={teamMemoryHref(ws, t)} />
            {(home!.projects.length > 0 || t.can_manage) && <ProjectsCard ws={ws} projects={home!.projects} team={home!.team} />}
            {home!.team.jira_projects.length > 0 && <JiraCard ws={ws} keys={home!.team.jira_projects} />}
            <MembersCard home={home!} ws={ws} />
            {t.visibility === "private" && <AdminsNote />}
          </div>
        </div>
      )}
    </div>
  );
}

function JoinButton({ ws, teamId, onJoined }: { ws: string; teamId: string; onJoined: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  return (
    <Button loading={busy} iconLeft="userPlus" onClick={async () => {
      setBusy(true);
      try { await addTeamMembers(ws, teamId, [user.id]); toast.success("You joined the team"); onJoined(); }
      catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't join"); }
      finally { setBusy(false); }
    }}>Join team</Button>
  );
}

/* ── the brief ── */

function BriefCard({ ws, teamId, initial, briefId }: { ws: string; teamId: string; initial: Brief | null; briefId: string | null }) {
  const toast = useToast();
  const [brief, setBrief] = useState<Brief | null>(initial);
  const [history, setHistory] = useState<BriefSummary[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setBrief(initial), [initial]);
  useEffect(() => {
    if (briefId && briefId !== initial?.id) getBrief(ws, teamId, briefId).then(setBrief).catch(() => undefined);
  }, [ws, teamId, briefId, initial?.id]);
  const loadHistory = () => { if (!history) listBriefs(ws, teamId).then((r) => setHistory(r.briefs)).catch(() => setHistory([])); };

  const run = async (fn: () => Promise<Brief>, ok?: string) => {
    setBusy(true);
    try { setBrief(await fn()); if (ok) toast.success(ok); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't save"); }
    finally { setBusy(false); }
  };
  const canEdit = !!brief?.can_edit;
  return (
    <section className="tz-card" aria-labelledby="tz-brief-h" data-testid="team-brief">
      <div className="tz-sec__head">
        <h2 className="tz-h2" id="tz-brief-h"><Icon name="megaphone" size={16} /> Weekly brief{brief?.label ? <span className="tz-muted">· {brief.label}</span> : null}</h2>
        <div className="flex items-center gap-1">
          <Dropdown
            aria-label="Earlier briefs"
            trigger={<Button variant="ghost" size="sm" iconRight="chevronDown" onClick={loadHistory} onFocus={loadHistory}>Earlier</Button>}
            items={history === null ? [{ header: "Loading…" }] : history.length === 0 ? [{ header: "No earlier briefs" }] : history.map((b) => ({ label: `${b.label} · ${b.line_count} lines`, onClick: () => { getBrief(ws, teamId, b.id).then(setBrief).catch(() => toast.error("Couldn't open that brief")); } }))}
          />
          {canEdit && <Button variant="ghost" size="sm" iconLeft="refresh" loading={busy && !editing} onClick={() => run(() => draftBrief(ws, teamId), "Brief re-drafted")}>Re-draft</Button>}
        </div>
      </div>
      {!brief || brief.lines.length === 0 ? (
        <p className="tz-empty">
          {brief ? "Nothing to report this week." : "The first brief arrives on Monday morning, drawn from this team's pages and meetings."}
        </p>
      ) : (
        <ul className="tz-brief__lines">
          {brief.lines.map((l) => (
            <li key={l.id} className="tz-brief__line" data-hidden={l.hidden ? "true" : undefined}>
              <span className="tz-brief__icon" data-kind={l.kind} title={KIND_LABEL[l.kind]}><Icon name={KIND_ICON[l.kind] ?? "message"} /><span className="md-visually-hidden">{KIND_LABEL[l.kind]}:</span></span>
              <div className="min-w-0">
                {editing === l.id ? (
                  <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => editBriefLine(ws, teamId, brief.id, l.id, { text: draft.trim() }), "Line updated").then(() => setEditing(null)); }}>
                    <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={300} rows={2} aria-label="Line text" autoFocus />
                    <div className="flex gap-2"><Button size="sm" type="submit" loading={busy} disabled={!draft.trim()}>Save</Button><Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
                  </form>
                ) : (
                  <>
                    <div className="tz-brief__text" dir="auto">
                      {l.person && <b>{l.person.name}: </b>}{l.text}
                      {l.edited && <span className="tz-muted"> (edited)</span>}
                      {l.hidden && <span className="tz-muted"> (hidden from the team)</span>}
                    </div>
                    {l.sources.length > 0 && <div className="tz-brief__src">{l.sources.map((s, i) => <Link key={i} href={s.href} title={s.title}>{s.title}</Link>)}</div>}
                  </>
                )}
              </div>
              {canEdit && editing !== l.id ? (
                <div className="tz-brief__tools">
                  <IconButton size="sm" icon="edit" label="Edit line" onClick={() => { setEditing(l.id); setDraft(l.text); }} />
                  <IconButton size="sm" icon={l.hidden ? "eye" : "eyeOff"} label={l.hidden ? "Show line" : "Hide line"} disabled={busy}
                    onClick={() => run(() => editBriefLine(ws, teamId, brief.id, l.id, { hidden: !l.hidden }), l.hidden ? "Line shown" : "Line hidden")} />
                </div>
              ) : <span />}
            </li>
          ))}
        </ul>
      )}
      {canEdit && brief && (
        adding ? (
          <form className="mt-2 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => addBriefLine(ws, teamId, brief.id, { text: draft.trim(), kind: "note" }), "Line added").then(() => { setAdding(false); setDraft(""); }); }}>
            <Input className="min-w-0 flex-1" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={300} placeholder="Add a line to this week's brief" aria-label="New line" autoFocus />
            <Button size="sm" type="submit" loading={busy} disabled={!draft.trim()}>Add</Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          </form>
        ) : (
          <Button className="mt-2" variant="ghost" size="sm" iconLeft="plus" onClick={() => { setAdding(true); setDraft(""); setEditing(null); }}>Add a line</Button>
        )
      )}
      {brief && !brief.ai && brief.lines.length > 0 && <p className="tz-muted mt-2">Gathered from this week&apos;s activity.</p>}
    </section>
  );
}

/* ── recent pages, meetings ── */

export function ItemRow({ it }: { it: TeamItem }) {
  const label = it.title?.trim() || it.original_filename || it.slug;
  const icon = it.kind === "markdown"
    ? (it.editor === "blocks" ? (it.icon && !it.icon.startsWith("asset:") ? <span aria-hidden>{it.icon}</span> : <Icon name="doc" size={16} />) : <Icon name="lines" size={16} />)
    : <FileIcon renderer={(it.renderer as FileRenderer | null) ?? null} mime={it.mime ?? ""} name={it.original_filename ?? ""} size={16} />;
  return (
    <li>
      <Link className="tz-row md-focus" href={`/${encodeURIComponent(it.slug)}`}>
        <span className="tz-row__icon">{icon}</span>
        <span className="tz-row__main">
          <span className="tz-row__title" dir="auto">{label}</span>
          {it.owner?.name && <span className="tz-row__sub">{it.owner.name}{it.folder ? ` · ${it.folder.name}` : ""}</span>}
        </span>
        <span className="tz-row__end">{fmtShortDate(it.updated_at)}</span>
      </Link>
    </li>
  );
}

function RecentCard({ ws, items, href }: { ws: string; items: TeamItem[]; href: string }) {
  void ws;
  return (
    <section className="tz-card tz-card--flush" aria-labelledby="tz-recent-h" data-testid="team-recent">
      <div className="tz-sec__head px-2.5 pt-2.5"><h2 className="tz-h2" id="tz-recent-h"><Icon name="doc" size={16} /> Recent pages</h2><Link href={href}>All pages</Link></div>
      {items.length ? <ul className="tz-rows">{items.map((it) => <ItemRow key={it.slug} it={it} />)}</ul> : <p className="tz-empty">No pages in this team yet.</p>}
    </section>
  );
}

export function MeetingRow({ m }: { m: TeamMeetingCard }) {
  const title = m.page_title || m.title || "Meeting";
  return (
    <li>
      <Link className="tz-row md-focus" href={`/${encodeURIComponent(m.slug)}`}>
        <span className="tz-row__icon"><Icon name="mic" size={16} /></span>
        <span className="tz-row__main">
          <span className="tz-row__title" dir="auto">{title}</span>
          <span className="tz-row__sub">{[m.series, m.attendee_count ? `${m.attendee_count} people` : null].filter(Boolean).join(" · ")}</span>
        </span>
        <span className="tz-row__end">{fmtShortDate(m.date)}</span>
      </Link>
    </li>
  );
}

function MeetingsCard({ ws, meetings, href }: { ws: string; meetings: TeamMeetingCard[]; href: string }) {
  void ws;
  return (
    <section className="tz-card tz-card--flush" aria-labelledby="tz-meet-h" data-testid="team-meetings">
      <div className="tz-sec__head px-2.5 pt-2.5"><h2 className="tz-h2" id="tz-meet-h"><Icon name="mic" size={16} /> Meetings</h2><Link href={href}>All meetings</Link></div>
      {meetings.length ? <ul className="tz-rows">{meetings.map((m) => <MeetingRow key={m.id} m={m} />)}</ul> : <p className="tz-empty">No meetings routed here yet. Import one and pick this team.</p>}
    </section>
  );
}

/* ── memory, projects, jira, members ── */

export function MemoryCard({ memory, href }: { memory: MemoryHighlights; href: string }) {
  return (
    <section className="tz-card" aria-labelledby="tz-mem-h" data-testid="team-memory">
      <div className="tz-sec__head"><h2 className="tz-h2" id="tz-mem-h"><Icon name="users" size={16} /> Memory</h2><Link href={href}>Open memory</Link></div>
      {memory.highlights.length === 0 ? <p className="tz-empty">Who&apos;s doing what shows here once the team has meetings and pages.</p> : (
        <ul className="tz-rows">
          {memory.highlights.slice(0, 6).map((h, i) => (
            <li key={i} className="tz-row" style={{ alignItems: "flex-start" }}>
              {h.person ? <Avatar name={h.person.name} src={h.person.picture ?? undefined} size="sm" /> : <span className="tz-row__icon"><Icon name="bulb" size={16} /></span>}
              <span className="tz-row__main">
                <span className="text-body" dir="auto" style={{ overflowWrap: "anywhere" }}>{h.person && <b>{h.person.name}: </b>}{h.text}</span>
                {h.source && <Link className="tz-row__sub" href={h.source.href}>{h.source.title}</Link>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProjectsCard({ ws, projects, team }: { ws: string; projects: ProjectCard[]; team: Home["team"] }) {
  const [creating, setCreating] = useState(false);
  return (
    <section className="tz-card tz-card--flush" aria-labelledby="tz-proj-h">
      <div className="tz-sec__head px-2.5 pt-2.5">
        <h2 className="tz-h2" id="tz-proj-h"><Icon name="layers" size={16} /> Projects</h2>
        {team.can_manage && <Button size="sm" variant="ghost" iconLeft="plus" onClick={() => setCreating(true)} data-testid="new-project">New project</Button>}
      </div>
      {team.can_manage && <CreateProjectDialog ws={ws} open={creating} teams={(teamsSlot(ws) || null)?.teams.filter((x) => x.can_read) ?? [team]} initialTeam={team.id} onClose={() => setCreating(false)} />}
      {projects.length === 0 && <p className="tz-empty">Work with other teams on something? A project is a shared space they all contribute to.</p>}
      <ul className="tz-rows">
        {projects.map((p) => (
          <li key={p.id}>
            <Link className="tz-row md-focus" href={projectHref(ws, p)}>
              <TeamTile team={p} size={20} />
              <span className="tz-row__main"><span className="tz-row__title">{p.name}</span>{p.team_ids.length > 1 && <span className="tz-row__sub">Shared by {p.team_ids.length} teams</span>}</span>
              {p.visibility === "private" && <Icon name="lock" size={12} className="text-text-muted" />}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function JiraCard({ ws, keys }: { ws: string; keys: string[] }) {
  const [data, setData] = useState<JiraTeam | null | false>(null);
  useEffect(() => { jiraTeam(ws).then(setData).catch(() => setData(false)); }, [ws]);
  const rows = useMemo(() => (data && data.team ? data.team.projects.filter((p) => keys.includes(p.key)) : []), [data, keys]);
  const site = data ? data.site?.url : null;
  return (
    <section className="tz-card" aria-labelledby="tz-jira-h" data-testid="team-jira">
      <div className="tz-sec__head"><h2 className="tz-h2" id="tz-jira-h"><Icon name="checkSquare" size={16} /> Jira</h2>{site && <a href={site} target="_blank" rel="noreferrer">Open Jira</a>}</div>
      {data === null ? <Skeleton variant="rect" height={60} /> : rows.length ? (
        <ul className="tz-rows">
          {rows.map((p) => (
            <li key={p.key} className="tz-row">
              <span className="tz-chip"><span>{p.key}</span></span>
              <span className="tz-row__main"><span className="tz-row__title">{p.name}</span><span className="tz-row__sub">{p.open} open · {p.overdue} overdue · {p.done_recent} done this week</span></span>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="flex flex-wrap gap-1.5">{keys.map((k) => <li key={k} className="tz-chip"><span>{k}</span></li>)}</ul>
      )}
    </section>
  );
}

function MembersCard({ home, ws }: { home: Home; ws: string }) {
  const t = home.team;
  const people = home.memory.people;
  const statusOf = new Map(people.map((p) => [p.id, p.status]));
  return (
    <section className="tz-card" aria-labelledby="tz-mem-people-h" data-testid="team-members">
      <div className="tz-sec__head">
        <h2 className="tz-h2" id="tz-mem-people-h"><Icon name="user" size={16} /> Members <span className="tz-muted">{t.members.length}</span></h2>
        {t.can_manage && <Link href={teamSettingsHref(ws, t)}>Manage</Link>}
      </div>
      <ul className="tz-rows">
        {t.members.slice(0, 12).map((m) => {
          const st = statusOf.get(m.id);
          return (
            <li key={m.id} className="tz-row">
              <Avatar name={m.name || m.email} src={m.picture ?? undefined} size="sm" />
              <span className="tz-row__main">
                <span className="tz-row__title">{m.name || m.email}</span>
                {st?.label && <span className="tz-row__sub">{st.emoji ? `${st.emoji} ` : ""}{st.label}</span>}
              </span>
              {m.role === "lead" && <span className="tz-row__end">Lead</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
