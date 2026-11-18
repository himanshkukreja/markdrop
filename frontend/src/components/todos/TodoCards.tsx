"use client";

/**
 * Personal to-do pages as cards (lib/todos.ts): who (or which team), open count, the companies with open items and
 * when each had its last call. Used by You › My to-dos (/todos) and a team's People & memory (TeamTodos below).
 * Each card opens the to-do page (a normal page: tick there, or on the call — both follow).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { Alert, Avatar, Icon, Skeleton } from "@/components/ui";
import { fmtDay } from "@/lib/team";
import { teamTodos, todoSummary, type TeamTodos as TeamTodosT, type TodoCard } from "@/lib/todos";
import "./todos.css";

export function TodoCards({ cards, by }: { cards: TodoCard[]; by: "person" | "team" }) {
  return (
    <ul className="td-cards" data-testid="todo-cards">
      {cards.map((c) => {
        const label = by === "person" ? c.user.name : c.team.name ?? "Team";
        return (
          <li key={`${c.team.id}:${c.user.id}`} className="td-card" data-testid="todo-card">
            {c.href && <Link href={c.href} className="td-card__link" aria-label={`${label}: ${todoSummary(c)}`} />}
            <div className="td-card__top">
              {by === "person" ? <Avatar name={c.user.name} src={c.user.avatar_url ?? undefined} size="md" />
                : <span className="td-card__glyph" aria-hidden><Icon name="checkSquare" /></span>}
              <div className="td-card__who">
                <p className="td-card__name" title={label}>
                  <span className="td-card__nametext">{label}</span>{by === "person" && c.you && <span className="td-you">You</span>}
                </p>
                <p className="td-card__sub">
                  {by === "team" ? `${c.workspace?.name ? `${c.workspace.name} · ` : ""}${c.title ?? "To-dos"}` : c.updated_at ? `Updated ${fmtDay(c.updated_at)}` : "To-do page"}
                </p>
              </div>
              <span className={`td-count${c.open ? "" : " td-count--zero"}`} title={`${c.open} open`}>{c.open}</span>
            </div>
            {c.sections.length > 0 ? (
              <ul className="td-secs" aria-label="By company">
                {c.sections.slice(0, 4).map((s) => (
                  <li key={s.name} className="td-sec">
                    <span className="td-sec__name">{s.name}</span>
                    <span className="td-sec__meta">{s.open} open{s.last_call ? ` · last call ${fmtDay(s.last_call)}` : ""}</span>
                  </li>
                ))}
                {c.sections.length > 4 && <li className="td-sec td-sec--more">+{c.sections.length - 4} more</li>}
              </ul>
            ) : (
              <p className="td-empty-line">No open action items yet — they&apos;ll appear here after the next call.</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A team's to-dos on its People & memory: a lead sees every member's page; anyone else in the team, theirs. */
export function TeamTodos({ ws, team }: { ws: string; team: string }) {
  const [data, setData] = useState<TeamTodosT | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    teamTodos(ws, team).then((d) => { if (live) setData(d); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "Couldn't load the to-dos."); });
    return () => { live = false; };
  }, [ws, team]);
  if (error) return <Alert tone="danger" className="td-alert">{error}</Alert>;
  if (data && (data.general || !data.pages.length)) return null;
  return (
    <section className="td-team" aria-labelledby="td-team-h" data-testid="team-todos">
      <div className="td-team__head">
        <h2 id="td-team-h" className="td-h2"><Icon name="checkSquare" />{data?.lead ? "Everyone's to-dos" : "Your to-dos"}</h2>
        <p className="td-muted">
          {data?.lead
            ? "Each member's action items from the team's calls, by company. As a lead you can read every member's page; only they edit it."
            : "Your action items from the team's calls, by company. Only you and the team's leads see your page."}
        </p>
      </div>
      {!data ? (
        <div className="td-cards">{[0, 1, 2].map((i) => <Skeleton key={i} variant="rect" height={120} />)}</div>
      ) : (
        <TodoCards cards={data.pages} by="person" />
      )}
    </section>
  );
}
