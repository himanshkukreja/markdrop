"use client";

/**
 * Person cards (AI quality stage 4): one member at a glance — role, teams, what they created, recent meetings, open
 * action items (and how many look done), what Team memory says they are working on. Everything comes decided for
 * the viewer from GET /api/v1/people/{id}/card (lib/people.ts).
 *
 *   <PersonCardView card={…} />            the card itself (Ask answers about a person show it on top)
 *   <PersonHover userId={…}>…</PersonHover>  hover (after a beat) or click / Enter on a name or avatar opens it
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Avatar, Icon, Popover, Skeleton, cx } from "@/components/ui";
import { getPersonCard, type PersonCardData } from "@/lib/people";
import { getToken } from "@/lib/api";
import { fmtShortDate } from "@/components/teams/parts";
import "./people.css";

const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };

/** An absolute Markdrop link as an in-app path (same host or markdrop.in), else as it is. */
export function inApp(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const here = typeof window !== "undefined" ? window.location.host : "";
    if (u.host === here || /(^|\.)markdrop\.in$/.test(u.hostname)) return `${u.pathname}${u.search}${u.hash}`;
    return url;
  } catch {
    return url;
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function PersonCardView({ card, compact, className }: { card: PersonCardData; compact?: boolean; className?: string }) {
  const role = card.title || (card.role ? ROLE[card.role] ?? card.role : null);
  const stats = [
    plural(card.created.total, "doc") + " created",
    `${plural(card.meetings.total, "meeting")} in ${card.meetings.days} days`,
    plural(card.open_items.total, "open item") + (card.open_items.likely_done ? ` (${card.open_items.likely_done} likely done)` : ""),
  ];
  const n = compact ? 2 : 3;
  return (
    <div className={cx("pc", compact && "pc--compact", className)} data-testid="person-card">
      <div className="pc-head">
        <Avatar name={card.name} src={card.avatar_url ?? undefined} size={compact ? "md" : "lg"} />
        <div className="pc-id">
          <div className="pc-name" dir="auto">{card.name}{card.you ? <span className="pc-you">You</span> : null}</div>
          {role ? <div className="pc-role" dir="auto">{role}</div> : null}
        </div>
      </div>
      {card.teams.length > 0 && (
        <div className="pc-teams" aria-label="Teams">
          {card.teams.map((t) => <span key={t.id} className="pc-chip">{t.name}{t.lead ? <em> · lead</em> : null}</span>)}
        </div>
      )}
      <p className="pc-stats">{stats.join(" · ")}</p>
      {card.working_on.length > 0 && (
        <div className="pc-sec">
          <div className="pc-h">Working on</div>
          <ul className="pc-list">{card.working_on.slice(0, n).map((w, i) => <li key={i} dir="auto">{w}</li>)}</ul>
        </div>
      )}
      {card.open_items.items.length > 0 && (
        <div className="pc-sec">
          <div className="pc-h">Open items</div>
          <ul className="pc-list">
            {card.open_items.items.slice(0, n).map((x, i) => (
              <li key={i} dir="auto">
                {x.url ? <a href={inApp(x.url) ?? "#"}>{x.text}</a> : x.text}
                {x.likely_done ? <span className="pc-likely" title={x.likely_done}> · likely done</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(card.created.items.length > 0 || card.meetings.items.length > 0) && (
        <div className="pc-sec pc-recent">
          {card.created.items.slice(0, n).map((d, i) => (
            <a key={`d${i}`} className="pc-row" href={inApp(d.url) ?? "#"}><Icon name="doc" size={13} /><span dir="auto">{d.title}</span>
              {d.updated ? <small>{fmtShortDate(d.updated)}</small> : null}</a>
          ))}
          {card.meetings.items.slice(0, n).map((m, i) => (
            <a key={`m${i}`} className="pc-row" href={inApp(m.url) ?? "#"}><Icon name="mic" size={13} /><span dir="auto">{m.title}</span>
              {m.date ? <small>{fmtShortDate(m.date)}</small> : null}</a>
          ))}
        </div>
      )}
      <Link className="pc-more" href={card.profile_url}>Open profile <Icon name="arrowRight" size={13} /></Link>
    </div>
  );
}

function Loader({ userId, workspace }: { userId: string; workspace?: string | null }) {
  const [state, setState] = useState<PersonCardData | null | false>(null);
  useEffect(() => {
    let on = true;
    getPersonCard(userId, workspace).then((c) => on && setState(c)).catch(() => on && setState(false));
    return () => { on = false; };
  }, [userId, workspace]);
  if (state === null) {
    return (
      <div className="pc" aria-busy>
        <div className="pc-head"><Skeleton variant="circle" width={40} height={40} /><div className="pc-id"><Skeleton width={140} /><Skeleton width={90} height={10} /></div></div>
        <Skeleton width="80%" height={10} />
      </div>
    );
  }
  if (state === false) return <p className="pc-none">No details for this person here.</p>;
  return <PersonCardView card={state} compact />;
}

/** Wraps a name or avatar: its card opens on hover (after a beat), click, or Enter. */
export function PersonHover({ userId, workspace, children, className, label }: {
  userId: string | null | undefined; workspace?: string | null; children: React.ReactNode; className?: string; label?: string;
}) {
  const [open, setOpen] = useState(false);
  // Only signed-in readers get cards (a public page's anonymous readers see the plain name); decided after mount.
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => setSignedIn(!!getToken()), []);
  const timer = useRef<number | undefined>(undefined);
  const later = useCallback((v: boolean, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(v), ms);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!userId || !signedIn) return <>{children}</>;
  return (
    <span className={cx("pc-hover", className)} onMouseEnter={() => later(true, 350)} onMouseLeave={() => later(false, 250)}>
      <Popover open={open} onOpenChange={setOpen} portal width={320} aria-label={label ?? "Person card"} className="pc-wrap" panelClassName="pc-pop"
        trigger={<button type="button" className="pc-trigger" data-testid="person-hover">{children}</button>}>
        <div onMouseEnter={() => window.clearTimeout(timer.current)} onMouseLeave={() => later(false, 250)}>
          <Loader userId={userId} workspace={workspace} />
        </div>
      </Popover>
    </span>
  );
}
