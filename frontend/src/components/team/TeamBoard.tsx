"use client";

/**
 * /team/<workspace>: the Team board — who is doing what, from the workspace's meetings and pages (Team
 * memory, services/workspace_memory.py). A card per member (status, now, targets, open items, the last
 * two weeks' activity), the team at a glance (open items per person split by due state, an activity
 * heatmap, blockers), and projects × people. Filters: person, status, project, this week / two weeks.
 * Everything was filtered for the viewer by the server: a line shows only while its meeting or page is
 * readable by them. Phones: one column, the charts compact, the filters wrap; tablets get two columns.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Alert, Avatar, Button, Icon, Input, SegmentedControl, Select, Skeleton, Tabs, useToast } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { getWorkspace, updateWorkspace, workspacesChanged } from "@/lib/workspaces";
import {
  fmtDay, getBoard, personHref, projectHref, STATUS_LABEL, STATUS_ORDER,
  type Board, type BoardOff, type Card, type StatusState,
} from "@/lib/team";
import { useAssistantHere } from "@/components/assistant/store";
import { ActivityStrip, FocusDialog, HeatLegend, StatusChip, StatusDialog, TargetChip } from "./parts";
import { GroupsDialog, ThisWeekCard } from "./extras";
import "./team.css";

type Range = "7" | "14";

export default function TeamBoard({ workspaceId }: { workspaceId: string }) {
  const [board, setBoard] = useState<Board | BoardOff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"people" | "projects">("people");
  const [q, setQ] = useState("");
  const [status, setStatusF] = useState<"" | StatusState>("");
  const [project, setProject] = useState("");
  const [group, setGroup] = useState("");
  const [range, setRange] = useState<Range>("14");
  const [editing, setEditing] = useState<"status" | "focus" | "groups" | null>(null);
  useAssistantHere({ workspace: workspaceId });

  const load = useCallback(async () => {
    try { setBoard(await getBoard(workspaceId)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't load Team."); }
  }, [workspaceId]);
  useEffect(() => { void load(); }, [load]);

  if (error && !board) return <div className="tm-page"><Alert tone="danger">{error}</Alert></div>;
  if (!board) {
    return (
      <div className="tm-page" aria-busy>
        <Skeleton variant="text" width={180} height={32} />
        <div className="tm-cards" style={{ marginTop: 24 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="rect" height={210} />)}</div>
      </div>
    );
  }
  if (!board.enabled) return <TeamOff board={board} onOn={load} />;
  return <TeamOn board={board} workspaceId={workspaceId} reload={load} tab={tab} setTab={setTab}
    q={q} setQ={setQ} status={status} setStatusF={setStatusF} project={project} setProject={setProject} group={group} setGroup={setGroup}
    range={range} setRange={setRange} editing={editing} setEditing={setEditing} />;
}

function Head({ name, wsId, children }: { name: string; wsId: string; children?: React.ReactNode }) {
  return (
    <header className="tm-head">
      <nav className="tm-crumbs" aria-label="Breadcrumb">
        <Link href={`/w/${encodeURIComponent(wsId)}`}>{name}</Link><Icon name="chevronRight" /><span>Team</span>
      </nav>
      <div className="tm-head__row">
        <div className="tm-head__titles">
          <h1 className="tm-title">Team</h1>
          <p className="tm-sub">Who&apos;s doing what, from your meetings and pages. You only see what came from things you can open.</p>
        </div>
        {children && <div className="tm-head__actions">{children}</div>}
      </div>
    </header>
  );
}

function TeamOff({ board, onOn }: { board: BoardOff; onOn: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const turnOn = async () => {
    setBusy(true);
    try {
      const ws = await getWorkspace(board.workspace.id);
      let timezone = ws.settings.timezone ?? null;
      try { timezone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { /* no Intl */ }
      await updateWorkspace(board.workspace.id, { settings: { ...ws.settings, team_memory: true, timezone } });
      workspacesChanged();
      toast.success("Team memory is on. It reads the last 30 days first; cards fill in over the next minutes.");
      onOn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't save. Try again.");
    } finally { setBusy(false); }
  };
  return (
    <div className="tm-page">
      <Head name={board.workspace.name} wsId={board.workspace.id} />
      <section className="tm-off" data-testid="team-off">
        <span className="tm-off__glyph" aria-hidden><Icon name="users" /></span>
        <h2>See where everyone is, without asking</h2>
        <p>Team memory reads this workspace&apos;s meetings and pages in the background and keeps a short, linked record of what each person is working on, what they committed to and by when, and what&apos;s blocking them. Everyone sees only lines from meetings and pages they can open, and anyone can hide or correct what it says about them.</p>
        <ul className="tm-off__points">
          <li><Icon name="lock" />Restricted meetings and private pages never show to anyone else. Encrypted and password-protected pages are never read.</li>
          <li><Icon name="edit" />People set their own status and focus, and fix or hide any line about them.</li>
          <li><Icon name="zap" />Uses Claude Haiku within Markdrop&apos;s AI budget. Turning it off deletes what it gathered.</li>
        </ul>
        {board.can_enable ? (
          <Button iconLeft="sparkle" loading={busy} onClick={turnOn} data-testid="team-enable">Turn on Team memory</Button>
        ) : (
          <p className="tm-muted">A workspace admin can turn it on.</p>
        )}
        <p className="tm-muted"><ReadMore topic="teamMemory" /></p>
      </section>
    </div>
  );
}

function within(card: Card, days: number): number {
  return card.activity.slice(-days).reduce((a, b) => a + b, 0);
}

function TeamOn(p: {
  board: Board; workspaceId: string; reload: () => void; tab: "people" | "projects"; setTab: (t: "people" | "projects") => void;
  q: string; setQ: (v: string) => void; status: "" | StatusState; setStatusF: (v: "" | StatusState) => void;
  project: string; setProject: (v: string) => void; range: Range; setRange: (r: Range) => void;
  group: string; setGroup: (v: string) => void;
  editing: "status" | "focus" | "groups" | null; setEditing: (v: "status" | "focus" | "groups" | null) => void;
}) {
  const { board, workspaceId } = p;
  const days = Number(p.range);
  const me = board.people.find((c) => c.you) ?? null;
  const people = useMemo(() => {
    const needle = p.q.trim().toLowerCase();
    return board.people.filter((c) => (!needle || c.name.toLowerCase().includes(needle))
      && (!p.status || c.status.state === p.status || (p.status === "blocked" && c.status.state === "waiting"))
      && (!p.project || c.projects.some((x) => x.key === p.project))
      && (!p.group || c.groups.includes(p.group)));
  }, [board.people, p.q, p.status, p.project, p.group]);
  const filtered = !!(p.q || p.status || p.project || p.group);
  // The tiles sum up who is shown (a group's own summary when a group is picked).
  const totals = useMemo(() => ({
    on_track: people.filter((c) => c.status.state === "on_track").length,
    blocked: people.filter((c) => c.status.state === "blocked" || c.status.state === "waiting").length,
    due_week: people.reduce((a, c) => a + c.due_week, 0),
    overdue: people.reduce((a, c) => a + c.overdue, 0),
    open_items: people.reduce((a, c) => a + c.open_items, 0),
  }), [people]);
  const lanes = board.lanes.filter((l) => !p.project || l.key === p.project);
  return (
    <div className="tm-page" data-testid="team-board">
      <Head name={board.workspace.name} wsId={workspaceId}>
        {me && (
          <>
            <Button variant="secondary" iconLeft="message" onClick={() => p.setEditing("status")} data-testid="team-set-status">
              {me.own_status ? "Change my status" : "Set my status"}
            </Button>
            <Button variant="secondary" iconLeft="edit" onClick={() => p.setEditing("focus")} data-testid="team-set-focus">My focus</Button>
          </>
        )}
        {board.can_manage && <Button variant="secondary" iconLeft="users" onClick={() => p.setEditing("groups")} data-testid="team-groups">Groups</Button>}
      </Head>
      {board.paused && (
        <Alert tone="warning" className="tm-alert">
          {board.paused.reason === "daily" || board.paused.reason === "monthly"
            ? `Updates are paused: Team memory's AI budget for the ${board.paused.reason === "daily" ? "day" : "month"} is spent. It picks up again ${board.paused.until ? fmtDay(board.paused.until) : "soon"}.`
            : "Updates are paused for now. What's here stays."}
        </Alert>
      )}
      {!board.ai_on && <Alert tone="info" className="tm-alert">AI features are off for this workspace, so Team isn&apos;t updating.</Alert>}
      {board.gathering && (
        <Alert tone="info" className="tm-alert" title="Reading your meetings and pages…">
          Team memory is going through the last 30 days. Cards fill in as it goes; you can leave this page.
        </Alert>
      )}

      <section className="tm-tiles" aria-label={p.group ? `${board.groups.find((g) => g.id === p.group)?.name ?? "Group"} at a glance` : "The team at a glance"} data-testid="team-tiles">
        <Tile n={totals.on_track} label="On track" icon="checkCircle" tone="good" />
        <Tile n={totals.blocked} label="Blocked or waiting" icon="alertCircle" tone="bad" />
        <Tile n={totals.due_week} label="Due this week" icon="calendar" />
        <Tile n={totals.overdue} label="Overdue" icon="alert" tone={totals.overdue ? "bad" : undefined} />
        <Tile n={totals.open_items} label="Open items" icon="checkSquare" />
      </section>
      <ThisWeekCard week={board.this_week} ws={workspaceId} canSend={board.can_manage} onSent={p.reload} />

      <div className="tm-filters" role="search">
        <div className="tm-search">
          <Icon name="search" className="tm-search__icon" />
          <Input type="search" value={p.q} onChange={(e) => p.setQ(e.target.value)} placeholder="Find a person" aria-label="Find a person" data-testid="team-search" />
        </div>
        <Select aria-label="Status" value={p.status} onChange={(e) => p.setStatusF(e.target.value as "" | StatusState)} data-testid="team-filter-status"
          options={[{ value: "", label: "Any status" }, ...STATUS_ORDER.filter((s) => s !== "waiting" && s !== "self").map((s) => ({ value: s, label: s === "blocked" ? "Blocked or waiting" : STATUS_LABEL[s] }))]} />
        {board.groups.length > 0 && (
          <Select aria-label="Group" value={p.group} onChange={(e) => p.setGroup(e.target.value)} data-testid="team-filter-group"
            options={[{ value: "", label: "Everyone" }, ...board.groups.map((g) => ({ value: g.id, label: g.name }))]} />
        )}
        {board.projects.length > 0 && (
          <Select aria-label="Project" value={p.project} onChange={(e) => p.setProject(e.target.value)} data-testid="team-filter-project"
            options={[{ value: "", label: "All projects" }, ...board.projects.map((x) => ({ value: x.key, label: x.name }))]} />
        )}
        <SegmentedControl<Range> aria-label="Period" size="sm" value={p.range} onChange={p.setRange}
          options={[{ value: "7", label: "This week" }, { value: "14", label: "2 weeks" }]} />
      </div>

      <Tabs items={[{ value: "people", label: "People", count: board.people.length }, { value: "projects", label: "Projects", count: board.projects.length }]}
        value={p.tab} onChange={(v) => p.setTab(v as "people" | "projects")} idPrefix="tm" aria-label="Team views" className="tm-tabs" />

      {p.tab === "people" ? (
        <div role="tabpanel" id="tm-panel-people" aria-labelledby="tm-tab-people">
          {people.length === 0 ? (
            <div className="tm-empty"><p>{filtered ? "Nobody matches these filters." : "No members yet."}</p>
              {filtered && <Button size="sm" variant="secondary" onClick={() => { p.setQ(""); p.setStatusF(""); p.setProject(""); p.setGroup(""); }}>Clear the filters</Button>}</div>
          ) : (
            <ul className="tm-cards" data-testid="team-cards">
              {people.map((c) => <MemberCard key={c.id} c={c} ws={workspaceId} days={days} today={board.today} />)}
            </ul>
          )}
          <Glance board={board} people={people} days={days} ws={workspaceId} />
          {board.former.length > 0 && (
            <p className="tm-muted tm-former">Former members: {board.former.map((f, i) => (
              <span key={f.id}>{i > 0 && ", "}<Link href={personHref(workspaceId, f.id)}>{f.name}</Link></span>))}</p>
          )}
        </div>
      ) : (
        <div role="tabpanel" id="tm-panel-projects" aria-labelledby="tm-tab-projects">
          <Lanes lanes={lanes} ws={workspaceId} />
        </div>
      )}

      {board.can_manage && <GroupsDialog ws={workspaceId} open={p.editing === "groups"} people={board.people}
        onClose={() => p.setEditing(null)} onChanged={p.reload} />}
      {me && (
        <>
          <StatusDialog ws={workspaceId} open={p.editing === "status"} current={me.own_status} onClose={() => p.setEditing(null)} onDone={p.reload} />
          <FocusDialog ws={workspaceId} open={p.editing === "focus"} current={me.now?.focus ? me.now.text : null}
            onClose={() => p.setEditing(null)} onDone={p.reload} />
        </>
      )}
    </div>
  );
}

function Tile({ n, label, icon, tone }: { n: number; label: string; icon: string; tone?: "good" | "bad" }) {
  return (
    <div className={`tm-tile${tone ? ` tm-tile--${tone}` : ""}`}>
      <span className="tm-tile__n">{n}</span>
      <span className="tm-tile__label"><Icon name={icon} />{label}</span>
    </div>
  );
}

function MemberCard({ c, ws, days, today }: { c: Card; ws: string; days: number; today: string }) {
  const n = within(c, days);
  return (
    <li className={`tm-card tm-card--${c.status.state}`} data-testid="team-card" data-person={c.name}>
      <Link href={personHref(ws, c.id)} className="tm-card__link" aria-label={`${c.name}: ${c.status.label}`} />
      <div className="tm-card__top">
        <Avatar name={c.name} src={c.avatar_url ?? undefined} size="lg" />
        <div className="tm-card__who">
          <p className="tm-card__name">{c.name}{c.you && <span className="tm-you">You</span>}</p>
          <p className="tm-card__role">{c.title || (c.role ? c.role[0]!.toUpperCase() + c.role.slice(1) : "")}</p>
        </div>
        <StatusChip status={c.status} size="sm" />
      </div>
      {c.status.reason && c.status.state !== "on_track" && (
        <p className="tm-card__reason">{c.status.state === "waiting" && c.status.waiting_on ? <>Waiting on <b>{c.status.waiting_on.name}</b>: </> : null}{c.status.reason}</p>
      )}
      <div className="tm-card__now">
        <span className="tm-card__label">{c.now?.focus ? "Focus" : "Now"}</span>
        <p>{c.now ? c.now.text : <span className="tm-muted">Nothing recent</span>}</p>
      </div>
      {c.targets.length > 0 && (
        <ul className="tm-card__targets" aria-label="Targets">
          {c.targets.slice(0, 3).map((t) => <li key={t.id}><TargetChip text={t.text} due={t.due} state={t.state} /></li>)}
          {c.targets.length > 3 && <li className="tm-muted">+{c.targets.length - 3} more</li>}
        </ul>
      )}
      <div className="tm-card__foot">
        <span className="tm-card__count" title="Open action items and targets"><Icon name="checkSquare" />{c.open_items} open</span>
        <ActivityStrip counts={c.activity.slice(-days)} today={today} label={`${c.name}'s updates`} />
        <span className="tm-card__when">{n ? `${n} update${n === 1 ? "" : "s"}` : ""}{c.updated_at ? ` · ${fmtDay(c.updated_at)}` : ""}</span>
      </div>
    </li>
  );
}

/** The team at a glance: open items per person (overdue / due this week / later), the activity heatmap,
 *  blockers. One hue per job; every bar segment is labelled with its count; the legend names the parts. */
function Glance({ board, people, days, ws }: { board: Board; people: Card[]; days: number; ws: string }) {
  const rows = people.filter((c) => c.open_items > 0).sort((a, b) => b.open_items - a.open_items);
  const max = Math.max(1, ...rows.map((c) => c.open_items));
  return (
    <section className="tm-glance" aria-labelledby="tm-glance-h">
      <h2 id="tm-glance-h" className="tm-h2">Team at a glance</h2>
      <div className="tm-glance__grid">
        <figure className="tm-chart" data-testid="team-chart-open">
          <figcaption className="tm-chart__title">Open items per person</figcaption>
          <div className="tm-legend" aria-hidden>
            <span><i className="tm-key tm-key--overdue" />Overdue</span>
            <span><i className="tm-key tm-key--week" />Due this week</span>
            <span><i className="tm-key tm-key--later" />Later or no date</span>
          </div>
          {rows.length === 0 ? <p className="tm-muted">No open items.</p> : (
            <table className="tm-bars">
              <caption className="tm-sr">Open items per person: overdue, due this week, later</caption>
              <thead className="tm-sr"><tr><th>Person</th><th>Overdue</th><th>Due this week</th><th>Later</th><th>Total</th></tr></thead>
              <tbody>
                {rows.map((c) => {
                  const later = Math.max(0, c.open_items - c.overdue - c.due_week);
                  const seg = (n: number, cls: string, what: string) => n > 0 && (
                    <span className={`tm-bar__seg tm-bar__seg--${cls}`} style={{ width: `${(n / max) * 100}%` }} title={`${c.name}: ${n} ${what}`}>
                      <span className="tm-bar__n">{n}</span>
                    </span>);
                  return (
                    <tr key={c.id}>
                      <th scope="row"><Link href={personHref(ws, c.id)}>{c.name}</Link></th>
                      <td className="tm-sr">{c.overdue}</td><td className="tm-sr">{c.due_week}</td><td className="tm-sr">{later}</td>
                      <td className="tm-bar">
                        <span className="tm-bar__track">{seg(c.overdue, "overdue", "overdue")}{seg(c.due_week, "week", "due this week")}{seg(later, "later", "later or no date")}</span>
                        <span className="tm-bar__total">{c.open_items}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </figure>

        <figure className="tm-chart" data-testid="team-chart-activity">
          <figcaption className="tm-chart__title">Updates per day, last {days === 7 ? "week" : "2 weeks"}</figcaption>
          <HeatLegend />
          <ul className="tm-heat">
            {people.map((c) => (
              <li key={c.id}>
                <Link href={personHref(ws, c.id)} className="tm-heat__name">{c.name}</Link>
                <ActivityStrip counts={c.activity.slice(-days)} today={board.today} label={`${c.name}'s updates`} />
              </li>
            ))}
          </ul>
        </figure>

        <figure className="tm-chart tm-chart--wide" data-testid="team-blockers">
          <figcaption className="tm-chart__title">Blockers</figcaption>
          {board.blockers.length === 0 ? <p className="tm-muted">Nobody is blocked right now.</p> : (
            <ul className="tm-blockers">
              {board.blockers.filter((b) => people.some((c) => c.id === b.person.id)).map((b) => (
                <li key={b.person.id + b.text} className="tm-blocker">
                  <Avatar name={b.person.name} src={b.person.avatar_url ?? undefined} size="sm" />
                  <div>
                    <p><Link href={personHref(ws, b.person.id)}><b>{b.person.name}</b></Link>{" "}
                      {b.waiting_on ? <>is waiting on <b>{b.waiting_on.name}</b>: </> : "is blocked: "}{b.text}</p>
                    <p className="tm-muted">since {fmtDay(b.since)}{b.source && <> · <Link href={b.source.href}>{b.source.title}</Link></>}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </figure>
      </div>
    </section>
  );
}

function Lanes({ lanes, ws }: { lanes: Board["lanes"]; ws: string }) {
  if (!lanes.length) {
    return <div className="tm-empty"><p>No recurring projects yet. A project shows here once it comes up in two or more meetings or pages.</p></div>;
  }
  return (
    <ul className="tm-lanes" data-testid="team-lanes">
      {lanes.map((l) => (
        <li key={l.key} className="tm-lane">
          <div className="tm-lane__head">
            <Link href={projectHref(ws, l.key)} className="tm-lane__name">{l.name}</Link>
            {l.status && <p className="tm-lane__status">{l.status}</p>}
            <span className="tm-muted">{l.updated_at ? `Updated ${fmtDay(l.updated_at)}` : ""}</span>
          </div>
          <ul className="tm-lane__people">
            {l.people.map((x) => (
              <li key={x.id} className="tm-lane__person">
                <Link href={personHref(ws, x.id)} className="tm-lane__who"><Avatar name={x.name} src={x.avatar_url ?? undefined} size="sm" />{x.name}</Link>
                {x.latest && <p className="tm-lane__latest">{x.latest}</p>}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
