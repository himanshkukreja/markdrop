"use client";

/**
 * /team/<workspace>/people/<user>: one person's page — status (theirs wins), focus note, working on now,
 * targets with due dates, a timeline of updates by day, open action items, decisions, their recent
 * documents and meetings. Each line links to the meeting or page it came from (only ones the viewer can
 * open). On your own page: set your status and focus, hide a line or say it's wrong, undo from "Hidden".
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Alert, Avatar, Button, Icon, Skeleton } from "@/components/ui";
import { fmtDay, getPerson, teamHref, type Person } from "@/lib/team";
import { useAssistantHere } from "@/components/assistant/store";
import { ActivityStrip, FocusDialog, LineRow, StatusChip, StatusDialog } from "./parts";
import { JiraPersonSection, JiraTeamContext } from "@/components/jira/JiraTeam";
import "./team.css";

export default function PersonView({ workspaceId, userId }: { workspaceId: string; userId: string }) {
  const [p, setP] = useState<Person | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<"status" | "focus" | null>(null);
  const [jiraOn, setJiraOn] = useState(false);
  useAssistantHere({ workspace: workspaceId });
  const load = useCallback(async () => {
    try { setP(await getPerson(workspaceId, userId)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't load this person."); }
  }, [workspaceId, userId]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <div className="tm-page"><Alert tone="danger">{error}</Alert><p><Link href={teamHref(workspaceId)}>Back to Team</Link></p></div>;
  if (!p) return <div className="tm-page" aria-busy><Skeleton variant="rect" height={120} /><Skeleton variant="rect" height={320} /></div>;
  const you = p.person.you;
  const today = new Date().toISOString().slice(0, 10);
  const empty = !p.working_on.length && !p.targets.length && !p.updates.length && !p.action_items.length && !p.decisions.length;
  return (
    <div className="tm-page tm-person" data-testid="team-person">
      <nav className="tm-crumbs" aria-label="Breadcrumb">
        <Link href={teamHref(workspaceId)}>Team</Link><Icon name="chevronRight" /><span>{p.person.name}</span>
      </nav>
      <header className="tm-phead">
        <Avatar name={p.person.name} src={p.person.avatar_url ?? undefined} size="xl" />
        <div className="tm-phead__who">
          <h1 className="tm-title">{p.person.name}{you && <span className="tm-you">You</span>}</h1>
          <p className="tm-sub">{[p.person.title, p.person.role && p.person.role[0]!.toUpperCase() + p.person.role.slice(1), p.person.archived && "Former member"].filter(Boolean).join(" · ")}</p>
          <div className="tm-phead__status">
            <StatusChip status={p.status} />
            {p.status.reason && <span className="tm-phead__reason">{p.status.waiting_on ? <>Waiting on <b>{p.status.waiting_on.name}</b>: </> : null}{p.status.reason}</span>}
            {p.status.state === "quiet" && p.quiet_days != null && <span className="tm-muted">No updates from meetings or pages in {p.quiet_days} days</span>}
            {p.own_status?.until && <span className="tm-muted">until {fmtDay(p.own_status.until)}</span>}
          </div>
        </div>
        {you && (
          <div className="tm-phead__actions">
            <Button variant="secondary" iconLeft="message" onClick={() => setEditing("status")} data-testid="team-set-status">{p.own_status ? "Change status" : "Set status"}</Button>
            <Button variant="secondary" iconLeft="edit" onClick={() => setEditing("focus")} data-testid="team-set-focus">{p.focus ? "Edit focus" : "Add focus"}</Button>
          </div>
        )}
      </header>

      {p.focus && (
        <section className="tm-focus" aria-label="In their own words" data-testid="team-focus">
          <span className="tm-card__label">{you ? "What I'm focused on" : "In their own words"}</span>
          <p>{p.focus.text}</p>
          <span className="tm-muted">{fmtDay(p.focus.at)}</span>
        </section>
      )}

      <div className="tm-activity">
        <span className="tm-card__label">Last 30 days</span>
        <ActivityStrip counts={p.activity} today={today} label={`${p.person.name}'s updates`} />
      </div>

      {empty && (
        <div className="tm-empty"><p>Nothing recorded about {you ? "you" : p.person.name.split(" ")[0]} yet in meetings or pages {you ? "" : "you can open"}.</p></div>
      )}

      <JiraTeamContext.Provider value={{ on: jiraOn, ws: workspaceId }}>
      <div className="tm-pgrid">
        <div className="tm-pcol">
          <Section title="Working on now" lines={p.working_on} ws={workspaceId} onChanged={load} testId="team-working" />
          <Section title="Targets" lines={p.targets} ws={workspaceId} onChanged={load} testId="team-targets" />
          {p.timeline.length > 0 && (
            <section className="tm-sec" data-testid="team-timeline">
              <h2 className="tm-h2">Timeline</h2>
              <ol className="tm-timeline">
                {p.timeline.map((d) => (
                  <li key={d.day} className="tm-timeline__day">
                    <h3 className="tm-timeline__date">{fmtDay(d.day)}</h3>
                    <ul className="tm-lines">{d.items.map((l) => <LineRow key={l.id} line={l} ws={workspaceId} onChanged={load} />)}</ul>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
        <div className="tm-pcol">
          <JiraPersonSection ws={workspaceId} userId={userId} onMode={(m) => setJiraOn(m !== "off")} />
          <Section title="Open action items" lines={p.action_items} ws={workspaceId} onChanged={load} testId="team-actions" />
          <Section title="Decisions they own" lines={p.decisions} ws={workspaceId} onChanged={load} />
          {p.meetings.length > 0 && (
            <section className="tm-sec">
              <h2 className="tm-h2">Recent meetings</h2>
              <ul className="tm-links">{p.meetings.map((m) => (
                <li key={m.slug}><Link href={m.href}><Icon name="mic" /><span>{m.series || m.title}</span></Link><span className="tm-muted">{fmtDay(m.date)}</span></li>))}</ul>
            </section>
          )}
          {p.documents.length > 0 && (
            <section className="tm-sec">
              <h2 className="tm-h2">Recent documents</h2>
              <ul className="tm-links">{p.documents.map((d) => (
                <li key={d.slug}><Link href={d.href}><Icon name="doc" /><span>{d.title}</span></Link><span className="tm-muted">{fmtDay(d.updated_at)}</span></li>))}</ul>
            </section>
          )}
          {you && p.hidden.length > 0 && (
            <section className="tm-sec" data-testid="team-hidden">
              <h2 className="tm-h2">Hidden by you</h2>
              <p className="tm-muted">Nobody sees these. Undo to show a line again.</p>
              <ul className="tm-lines">{p.hidden.map((l) => <LineRow key={l.id} line={l} ws={workspaceId} onChanged={load} hiddenList />)}</ul>
            </section>
          )}
        </div>
      </div>
      </JiraTeamContext.Provider>
      {you && (
        <>
          <StatusDialog ws={workspaceId} open={editing === "status"} current={p.own_status} onClose={() => setEditing(null)} onDone={load} />
          <FocusDialog ws={workspaceId} open={editing === "focus"} current={p.focus?.text ?? null} onClose={() => setEditing(null)} onDone={load} />
        </>
      )}
    </div>
  );
}

function Section({ title, lines, ws, onChanged, testId }: { title: string; lines: Person["working_on"]; ws: string; onChanged: () => void; testId?: string }) {
  if (!lines.length) return null;
  return (
    <section className="tm-sec" data-testid={testId}>
      <h2 className="tm-h2">{title}</h2>
      <ul className="tm-lines">{lines.map((l) => <LineRow key={l.id} line={l} ws={ws} onChanged={onChanged} />)}</ul>
    </section>
  );
}
