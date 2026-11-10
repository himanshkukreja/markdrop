"use client";

import Link from "next/link";
import { createContext, useCallback, useEffect, useState } from "react";
import { Button, Icon, useToast } from "@/components/ui";
import { connectMyJira, jiraTeam, jiraTeamPerson, type JiraPersonView, type JiraTeam, type JiraTeamCounts } from "@/lib/jira";
import { JiraIssueRow } from "./JiraChip";
import { JiraMark } from "./JiraMark";
import "./jira.css";

/** Whether Team lines (blockers, targets, action items) offer "Create Jira issue": the workspace has a Jira site. */
export const JiraTeamContext = createContext<{ on: boolean; ws: string | null }>({ on: false, ws: null });

/** The Team board's Jira data for this viewer (details when their own Atlassian account is connected, counts otherwise). */
export function useJiraTeam(ws: string): { data: JiraTeam | null; reload: (refresh?: boolean) => void } {
  const [data, setData] = useState<JiraTeam | null>(null);
  const reload = useCallback((refresh = false) => { jiraTeam(ws, refresh).then(setData).catch(() => setData(null)); }, [ws]);
  useEffect(() => { reload(); }, [reload]);
  return { data, reload };
}

export function Counts({ c, compact }: { c: JiraTeamCounts; compact?: boolean }) {
  const parts: Array<[number, string, string?]> = [
    [c.in_progress, "in progress"], [c.todo, "to do"], [c.overdue, "overdue", "jr-late"], [c.blocked, "blocked", "jr-late"],
  ];
  if (!compact) parts.push([c.done_recent, "done lately"]);
  const shown = parts.filter(([n]) => n > 0);
  if (!shown.length) return <span className="jr-counts">No open tickets</span>;
  return (
    <span className="jr-counts">
      {shown.map(([n, label, cls]) => <span key={label} className={cls}><b>{n}</b> {label}</span>)}
    </span>
  );
}

/** A member card's Jira line: counts, and (details mode) their top 3 open issues. */
export function JiraCardLine({ data, userId }: { data: JiraTeam | null; userId: string }) {
  if (!data || (data.mode !== "details" && data.mode !== "counts")) return null;
  const p = data.people[userId];
  if (!p) return null;
  return (
    <div className="jr-card" data-testid="team-card-jira">
      <span className="tm-card__label"><JiraMark size={12} /> Jira</span>
      <Counts c={p.counts} compact />
      {data.mode === "details" && p.top.length > 0 && <ul>{p.top.map((i) => <JiraIssueRow key={i.key} issue={i} dense />)}</ul>}
    </div>
  );
}

/** "Jira" in the team at a glance: issues by status, overdue and blocked ones, per project; a prompt when not connected. */
export function JiraGlance({ data, people, ws, canManage }: { data: JiraTeam | null; people: string[]; ws: string; canManage: boolean }) {
  const toast = useToast();
  if (!data || data.mode === "off") return null;
  if (data.mode === "no_projects") {
    return (
      <figure className="tm-chart tm-chart--wide" data-testid="team-jira">
        <figcaption className="tm-chart__title"><JiraMark size={14} /> Jira</figcaption>
        <p className="tm-muted">
          {canManage ? <>Choose which Jira projects show here: <Link href={`/settings/workspaces/${encodeURIComponent(ws)}/integrations/jira`}>Workspace settings › Integrations › Jira</Link>.</>
            : "A workspace admin chooses which Jira projects show here."}
        </p>
      </figure>
    );
  }
  // The tiles add up the people shown (a group's members when a group is picked).
  const sum: JiraTeamCounts = { todo: 0, in_progress: 0, done_recent: 0, overdue: 0, blocked: 0 };
  for (const id of people) {
    const c = data.people[id]?.counts;
    if (!c) continue;
    (Object.keys(sum) as Array<keyof JiraTeamCounts>).forEach((k) => { sum[k] += c[k]; });
  }
  const shownKeys = new Set(people.flatMap((id) => data.people[id]?.keys ?? []));
  const keep = (key: string) => shownKeys.has(key);
  return (
    <figure className="tm-chart tm-chart--wide" data-testid="team-jira">
      <figcaption className="tm-chart__title"><JiraMark size={14} /> Jira{data.site ? <span className="tm-muted"> · {data.site.projects.join(", ")}</span> : null}</figcaption>
      <div className="jr-team">
        <Counts c={sum} />
        {data.mode === "counts" ? (
          <p className="tm-muted" data-testid="team-jira-connect">
            Counts only: connect your Atlassian account to see the tickets you can open in Jira.{" "}
            <Button size="sm" variant="secondary" iconLeft="link" onClick={() => void connectMyJira().catch((e) => toast.error(e instanceof Error ? e.message : "That didn't work."))}>Connect</Button>
          </p>
        ) : (
          <>
            {!!data.team?.overdue_issues?.length && (
              <div><p className="tm-card__label"><Icon name="alert" /> Overdue</p>
                <ul className="list-none p-0">{data.team.overdue_issues.filter((i) => keep(i.key)).map((i) => <JiraIssueRow key={i.key} issue={i} />)}</ul></div>
            )}
            {!!data.team?.blocked_issues?.length && (
              <div><p className="tm-card__label"><Icon name="alertCircle" /> Blocked</p>
                <ul className="list-none p-0">{data.team.blocked_issues.filter((i) => keep(i.key)).map((i) => <JiraIssueRow key={i.key} issue={i} />)}</ul></div>
            )}
          </>
        )}
        {!!data.team?.projects.length && (
          <table className="jr-table" data-testid="team-jira-projects">
            <caption className="tm-sr">Open Jira issues per project</caption>
            <thead><tr><th scope="col">Project</th><th scope="col">Open</th><th scope="col">Overdue</th><th scope="col">Done lately</th></tr></thead>
            <tbody>
              {data.team.projects.map((p) => (
                <tr key={p.key}><th scope="row">{p.name}</th><td>{p.open}</td><td>{p.overdue}</td><td>{p.done_recent}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        {data.error && <p className="tm-muted">Jira didn&apos;t answer just now; these may be a few minutes old.</p>}
      </div>
    </figure>
  );
}

/** A person's page: their Jira issues, grouped (details mode), else their counts. */
export function JiraPersonSection({ ws, userId, onMode }: { ws: string; userId: string; onMode?: (mode: JiraPersonView["mode"]) => void }) {
  const [v, setV] = useState<JiraPersonView | null>(null);
  useEffect(() => {
    jiraTeamPerson(ws, userId).then((x) => { setV(x); onMode?.(x.mode); }).catch(() => setV(null));
  }, [ws, userId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v || !v.matched || (v.mode !== "details" && v.mode !== "counts")) return null;
  return (
    <section className="tm-sec" data-testid="person-jira" aria-labelledby="pj-h">
      <h2 id="pj-h" className="tm-h2"><JiraMark size={16} /> Jira</h2>
      {v.counts && <Counts c={v.counts} />}
      {v.mode === "counts" ? (
        <p className="tm-muted">Connect your Atlassian account to see these tickets (only the ones you can open in Jira).{" "}
          <Button size="sm" variant="secondary" iconLeft="link" onClick={() => void connectMyJira()}>Connect</Button></p>
      ) : v.groups.map((g) => (
        <div key={g.key}>
          <p className="tm-card__label">{g.label} · {g.issues.length}</p>
          <ul className="list-none p-0">{g.issues.map((i) => <JiraIssueRow key={i.key} issue={i} />)}</ul>
        </div>
      ))}
    </section>
  );
}
