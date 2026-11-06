"use client";

/**
 * /team/<workspace>/projects/<key>: a recurring project — its latest status, who is on it, what's being
 * worked on, decisions, open items and blockers, recent updates; each line with its source. Built from
 * the facts the viewer may see.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Alert, Avatar, Icon, Skeleton } from "@/components/ui";
import { fmtDay, getProject, personHref, teamHref, type Project } from "@/lib/team";
import { LineRow } from "./parts";
import "./team.css";

export default function ProjectView({ workspaceId, projectKey }: { workspaceId: string; projectKey: string }) {
  const [p, setP] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setP(await getProject(workspaceId, projectKey)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't load this project."); }
  }, [workspaceId, projectKey]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <div className="tm-page"><Alert tone="danger">{error}</Alert><p><Link href={teamHref(workspaceId)}>Back to Team</Link></p></div>;
  if (!p) return <div className="tm-page" aria-busy><Skeleton variant="rect" height={320} /></div>;
  const sec = (title: string, lines: Project["updates"], id?: string) => lines.length > 0 && (
    <section className="tm-sec" data-testid={id}>
      <h2 className="tm-h2">{title}</h2>
      <ul className="tm-lines">{lines.map((l) => <LineRow key={l.id} line={l} ws={workspaceId} onChanged={load} showPerson />)}</ul>
    </section>
  );
  return (
    <div className="tm-page" data-testid="team-project">
      <nav className="tm-crumbs" aria-label="Breadcrumb">
        <Link href={teamHref(workspaceId)}>Team</Link><Icon name="chevronRight" /><span>Projects</span>
      </nav>
      <header className="tm-head__row">
        <div className="tm-head__titles">
          <h1 className="tm-title">{p.project.name}</h1>
          <p className="tm-sub">{p.status ? p.status.text : "No status reported yet."}{p.project.updated_at && <> · Updated {fmtDay(p.project.updated_at)}</>}</p>
        </div>
      </header>
      <ul className="tm-people" aria-label="People on it">
        {p.people.map((x) => (
          <li key={x.id}><Link href={personHref(workspaceId, x.id)}><Avatar name={x.name} src={x.avatar_url ?? undefined} size="sm" />{x.name}</Link></li>
        ))}
      </ul>
      <div className="tm-pgrid">
        <div className="tm-pcol">{sec("Being worked on", p.working_on)}{sec("Recent updates", p.updates)}</div>
        <div className="tm-pcol">{sec("Open items and blockers", p.open_items, "team-open")}{sec("Decisions", p.decisions)}</div>
      </div>
    </div>
  );
}
