"use client";

/**
 * The team home's cards (nav redesign 2026-11-10, prototype Option A + B's "What's happening"): the Ask bar,
 * Needs you (your unread inbox), Recently updated (with type thumbnails), Meetings (date tiles), Who's doing what,
 * Across teams and New this month (General), and the activity feed. Every card gets its data already filtered
 * for the viewer (backend routers/teams.team_home).
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Avatar, FileIcon, Icon, Skeleton, cx } from "@/components/ui";
import type { FileRenderer } from "@/components/ui/markdrop";
import { listNotifications, type AppNotification } from "@/lib/notifications";
import { openNotifications } from "@/components/shell/NotificationBell";
import { teamHref, type MemoryHighlights, type Person, type TeamCard, type TeamItem, type TeamMeetingCard } from "@/lib/teams";
import { TeamTile, fmtShortDate } from "./parts";

const enc = encodeURIComponent;

/* ── Ask bar ── */
export function AskBar({ href, name, chips }: { href: string; name: string; chips: string[] }) {
  return (
    <Link href={href} className="th-ask md-focus" data-testid="team-ask-bar">
      <Icon name="sparkle" size={18} className="th-ask__spark" />
      <span className="th-ask__q">Ask {name} anything — answers cite pages, files and meetings</span>
      <span className="th-ask__sug max-lg:hidden">{chips.map((c) => <span key={c} className="th-chip">{c}</span>)}</span>
    </Link>
  );
}

/* ── Needs you: unread inbox items ── */
const NOTE_ICON: Record<string, { icon: string; cls: string }> = {
  signoff_requested: { icon: "checkSquare", cls: "acc" }, mention: { icon: "at", cls: "" }, comment_mention: { icon: "at", cls: "" },
  comment_assigned: { icon: "flag", cls: "warn" }, comment_reply: { icon: "message", cls: "" }, comment_new: { icon: "message", cls: "" },
  comment_resolved: { icon: "checkCircle", cls: "ok" }, shared: { icon: "user", cls: "" },
};
export function NeedsYouCard() {
  const [items, setItems] = useState<AppNotification[] | null>(null);
  useEffect(() => {
    listNotifications({ unreadOnly: true, limit: 5 }).then((r) => setItems(r.items)).catch(() => setItems([]));
  }, []);
  return (
    <section className="th-card" aria-labelledby="th-needs" data-testid="team-needs-you">
      <div className="th-ch">
        <h2 id="th-needs"><Icon name="checkSquare" size={16} /> Needs you</h2>
        {items && items.length > 0 && <span className="th-chip th-chip--acc">{items.length}</span>}
        <button type="button" className="th-lnk" onClick={() => openNotifications()}>Inbox</button>
      </div>
      {items === null ? <Skeleton variant="rect" height={120} /> : items.length === 0 ? (
        <p className="th-empty"><Icon name="check" size={14} /> You&apos;re all caught up.</p>
      ) : (
        <ul className="th-list">
          {items.slice(0, 4).map((n) => {
            const k = NOTE_ICON[n.kind] ?? { icon: "bell", cls: "" };
            const body = (
              <>
                <span className={cx("th-kico", k.cls && `th-kico--${k.cls}`)}><Icon name={k.icon} size={15} /></span>
                <span className="th-tx"><span className="th-t" dir="auto">{n.page?.title || n.text}</span><span className="th-s" dir="auto">{n.excerpt ? `“${n.excerpt}”` : n.text}</span></span>
                <span className="th-end">{fmtShortDate(n.created_at)}</span>
              </>
            );
            return <li key={n.id}>{n.href ? <Link className="th-li md-focus" href={n.href}>{body}</Link> : <div className="th-li">{body}</div>}</li>;
          })}
        </ul>
      )}
    </section>
  );
}

/* ── Recently updated: cards with a thumbnail per type ── */
type Kind = "doc" | "page" | "pdf" | "sheet" | "video" | "html" | "image" | "file";
export function kindOf(it: Pick<TeamItem, "kind" | "editor" | "renderer" | "mime">): Kind {
  if (it.kind !== "artifact") return it.editor === "blocks" ? "page" : "doc";
  const r = it.renderer || "";
  if (r === "pdf") return "pdf";
  if (r === "sheet" || r === "csv" || /spreadsheet|csv|excel/.test(it.mime || "")) return "sheet";
  if (r === "video" || (it.mime || "").startsWith("video/")) return "video";
  if (r === "html") return "html";
  if (r === "image" || (it.mime || "").startsWith("image/")) return "image";
  return "file";
}
const KIND_LABEL: Record<Kind, string> = { doc: "Doc", page: "Page", pdf: "PDF", sheet: "Sheet", video: "Video", html: "HTML", image: "Image", file: "File" };
export function Thumb({ kind }: { kind: Kind }) {
  return (
    <div className={cx("th-thumb", `th-thumb--${kind}`)} aria-hidden>
      {kind === "video" ? <Icon name="play" size={26} /> : kind === "pdf" ? <span className="th-thumb__sheet"><i /><b /><b /><b /><b /></span>
        : kind === "html" ? <span className="th-thumb__win"><i /><span><b /><b /><b /></span></span>
        : kind === "image" ? <Icon name="image" size={26} />
        : kind === "sheet" ? null
        : <span className="th-thumb__doc"><i /><b /><b /><b /><b /></span>}
    </div>
  );
}
export function ItemIcon({ it, size = 15 }: { it: TeamItem; size?: number }) {
  if (it.kind !== "artifact") {
    if (it.editor === "blocks" && it.icon && !it.icon.startsWith("asset:")) return <span aria-hidden>{it.icon}</span>;
    return <Icon name={it.editor === "blocks" ? "doc" : "lines"} size={size} />;
  }
  return <FileIcon renderer={(it.renderer as FileRenderer | null) ?? null} mime={it.mime ?? ""} name={it.original_filename ?? ""} size={size} />;
}
export function RecentCard({ items, href, className, empty }: { items: TeamItem[]; href: string; className?: string; empty: string }) {
  return (
    <section className={cx("th-card", className)} aria-labelledby="th-recent" data-testid="team-recent">
      <div className="th-ch"><h2 id="th-recent"><Icon name="clock" size={16} /> Recently updated</h2><span className="th-chip">Pages &amp; files</span><Link className="th-lnk" href={href}>All</Link></div>
      {items.length === 0 ? <p className="th-empty">{empty}</p> : (
        <ul className="th-fgrid">
          {items.slice(0, 6).map((it) => {
            const k = kindOf(it);
            return (
              <li key={it.slug}>
                <Link className="th-fcard md-focus" href={`/${enc(it.slug)}`}>
                  <Thumb kind={k} />
                  <span className="th-fm">
                    <span className="th-fm__ico"><ItemIcon it={it} /></span>
                    <span className="min-w-0"><span className="th-t" dir="auto">{it.title?.trim() || it.original_filename || it.slug}</span>
                      <span className="th-s">{KIND_LABEL[k]} · {fmtShortDate(it.updated_at)}</span></span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ── Meetings: date tiles ── */
function dateTile(iso: string | null | undefined) {
  if (!iso) return { top: "", day: "•" };
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return { top: "", day: "•" };
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return { top: "Today", day: "•", up: true };
  return { top: d.toLocaleDateString(undefined, { month: "short" }), day: String(d.getDate()), up: d > today };
}
export function MeetingsCard({ meetings, href, importHref, title = "Meetings", teams }: {
  meetings: TeamMeetingCard[]; href: string; importHref: string; title?: string; teams?: boolean;
}) {
  return (
    <section className="th-card" aria-labelledby="th-meet" data-testid="team-meetings">
      <div className="th-ch"><h2 id="th-meet"><Icon name="mic" size={16} /> {title}</h2><Link className="th-lnk" href={importHref}>Import meeting</Link></div>
      {meetings.length === 0 ? <p className="th-empty">No meetings here yet. Import one and pick this team.</p> : (
        <ul className="th-list">
          {meetings.slice(0, 5).map((m) => {
            const t = dateTile(m.date);
            const meta = { decisions_count: Array.isArray(m.decisions) ? m.decisions.length : 0, teams: m.teams };
            return (
              <li key={m.id}>
                <Link className="th-mrow md-focus" href={`/${enc(m.slug)}`}>
                  <span className={cx("th-when", t.up && "th-when--up")}><small>{t.top}</small><b>{t.day}</b></span>
                  <span className="th-tx">
                    <span className="th-t" dir="auto">{m.page_title || m.title || "Meeting"}</span>
                    <span className="th-meta">
                      {m.series && <span>{m.series}</span>}
                      {m.attendee_count ? <span>{m.attendee_count} people</span> : null}
                      {meta.decisions_count ? <span className="th-chip th-chip--ok">{meta.decisions_count} decisions</span> : null}
                      {teams && meta.teams?.length ? <span>{meta.teams.map((x) => x.name).join(", ")}</span> : null}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <Link className="th-foot th-foot--link" href={href}>All meetings <Icon name="arrowRight" size={12} /></Link>
    </section>
  );
}

/* ── Who's doing what ── */
export function WhoCard({ memory, href, className }: { memory: MemoryHighlights & { enabled?: boolean }; href: string; className?: string }) {
  const rows = memory.highlights.filter((h) => h.person).slice(0, 8);
  return (
    <section className={cx("th-card", className)} aria-labelledby="th-who" data-testid="team-memory">
      <div className="th-ch"><h2 id="th-who"><Icon name="users" size={16} /> Who&apos;s doing what</h2><span className="th-chip max-sm:hidden">from pages, meetings &amp; activity</span><Link className="th-lnk" href={href}>People &amp; memory</Link></div>
      {rows.length === 0 ? (
        <p className="th-empty">{memory.enabled === false ? "Turn on Team memory in Workspace settings to see who's doing what." : "Who's doing what shows here once the team has meetings and pages."}</p>
      ) : (
        <ul className="th-pgrid">
          {rows.map((h, i) => (
            <li key={i} className="th-pp">
              <Avatar name={h.person!.name} src={h.person!.picture ?? undefined} size="sm" />
              <span className="min-w-0"><span className="th-t">{h.person!.name}</span><span className="th-s2" dir="auto">{h.text}</span>
                {h.source && <Link className="th-src" href={h.source.href}>{h.source.title}</Link>}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ── General: Across teams, New this month ── */
export function AcrossCard({ ws, across, browse, className }: { ws: string; across: { team: TeamCard; line: string | null }[]; browse: string; className?: string }) {
  return (
    <section className={cx("th-card", className)} aria-labelledby="th-across" data-testid="general-across">
      <div className="th-ch"><h2 id="th-across"><Icon name="grid" size={16} /> Across teams</h2><span className="th-chip max-sm:hidden">one line from each team&apos;s brief</span><Link className="th-lnk" href={browse}>All teams</Link></div>
      {across.length === 0 ? <p className="th-empty">No other teams yet. Teams get their own pages, meetings and memory; their weekly lines show up here.</p> : (
        <ul className="th-list">
          {across.map(({ team: t, line }) => (
            <li key={t.id}>
              <Link className="th-li md-focus" href={teamHref(ws, t)}>
                <TeamTile team={t} size={28} />
                <span className="th-tx">
                  <span className="th-t">{t.name}{!t.my_role && <span className="th-sub"> · not joined</span>}{t.visibility === "private" && <Icon name="lock" size={11} className="ml-1 inline text-text-muted" />}</span>
                  <span className="th-s th-s--wrap" dir="auto">{line ?? (t.can_read ? "No brief yet this week." : "Private team")}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="th-foot"><Icon name="lock" size={12} /> Private teams show only their name here.</p>
    </section>
  );
}
export function NewPeopleCard({ people, total, teams }: { people: (Person & { joined_at: string | null })[]; total: number; teams: number }) {
  return (
    <section className="th-card" aria-labelledby="th-new" data-testid="general-new-people">
      <div className="th-ch"><h2 id="th-new"><Icon name="userPlus" size={16} /> New this month</h2></div>
      {people.length === 0 ? <p className="th-empty">No one new in the last 30 days.</p> : (
        <ul className="th-list">
          {people.slice(0, 4).map((p) => (
            <li key={p.id} className="th-li">
              <Avatar name={p.name || p.email} src={p.picture ?? undefined} size="sm" />
              <span className="th-tx"><span className="th-t">{p.name || p.email}</span><span className="th-s">Joined {fmtShortDate(p.joined_at)}</span></span>
            </li>
          ))}
        </ul>
      )}
      <p className="th-foot"><Icon name="users" size={12} /> {total} {total === 1 ? "person" : "people"} in {teams} {teams === 1 ? "team" : "teams"}</p>
    </section>
  );
}

/* ── What's happening (Option B's feed) ── */
interface FeedEvent { at: string; day: string; who: Person | { name: string; picture?: string | null } | null; verb: string; title: string; sub: string; href: string; icon: React.ReactNode; team?: { id: string; name: string; icon: string | null; color: string } | null }
function dayLabel(d: Date): string {
  const today = new Date();
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}
export function FeedCard({ items, meetings, across, className }: { items: TeamItem[]; meetings: TeamMeetingCard[]; across: boolean; className?: string }) {
  const [limit, setLimit] = useState(8);
  const events = useMemo(() => {
    const out: (FeedEvent & { t: number })[] = [];
    for (const it of items) {
      const at = it.updated_at || it.created_at;
      if (!at) continue;
      const created = !!it.created_at && Math.abs(new Date(it.updated_at || it.created_at).getTime() - new Date(it.created_at).getTime()) < 120_000;
      const k = kindOf(it);
      const team = (it as TeamItem & { teams?: { id: string; name: string; icon: string | null; color: string; kind?: string }[] }).teams?.find((x) => x.kind !== "project") ?? null;
      out.push({ at, t: new Date(at).getTime(), day: "", who: it.owner?.name ? { name: it.owner.name, picture: it.owner.picture } : null,
        verb: created ? (it.kind === "artifact" ? "uploaded" : "created") : "updated", title: it.title?.trim() || it.original_filename || it.slug,
        sub: `${KIND_LABEL[k]}${it.folder ? ` · ${it.folder.name}` : ""}`, href: `/${enc(it.slug)}`, icon: <ItemIcon it={it} />, team });
    }
    for (const m of meetings) {
      const at = m.created_at || m.date;
      if (!at) continue;
      const meta = { decisions_count: Array.isArray(m.decisions) ? m.decisions.length : 0, actions_count: Array.isArray(m.action_items) ? m.action_items.length : 0, teams: m.teams };
      out.push({ at, t: new Date(at).getTime(), day: "", who: null, verb: "meeting summarised", title: m.page_title || m.title || "Meeting",
        sub: [meta.decisions_count ? `${meta.decisions_count} decisions` : null, meta.actions_count ? `${meta.actions_count} actions` : null, m.attendee_count ? `${m.attendee_count} people` : null].filter(Boolean).join(" · ") || "Summary and transcript",
        href: `/${enc(m.slug)}`, icon: <Icon name="mic" size={15} />, team: meta.teams?.[0] ?? null });
    }
    out.sort((a, b) => b.t - a.t);
    for (const e of out) e.day = Number.isNaN(e.t) ? "" : dayLabel(new Date(e.t));
    return out;
  }, [items, meetings]);
  const shown = events.slice(0, limit);
  const days = [...new Set(shown.map((e) => e.day))];
  return (
    <section className={cx("th-card th-feed", className)} aria-labelledby="th-feed" data-testid="team-feed">
      <div className="th-ch"><h2 id="th-feed"><Icon name="wave" size={16} /> What&apos;s happening</h2><span className="th-chip">{across ? "all teams you can see" : "this team"}</span></div>
      {events.length === 0 ? <p className="th-empty">Nothing yet. New pages, uploads and meeting summaries show up here.</p> : days.map((d) => (
        <div key={d}>
          <div className="th-day">{d}</div>
          <ul className="th-list">
            {shown.filter((e) => e.day === d).map((e, i) => (
              <li key={`${e.href}-${i}`} className="th-ev">
                {e.who ? <Avatar name={e.who.name} src={e.who.picture ?? undefined} size="sm" /> : <span className="th-kico th-kico--ok"><Icon name="mic" size={15} /></span>}
                <div className="th-tx">
                  <div className="th-who">{e.who && <b>{e.who.name}</b>} {e.verb}{across && e.team ? <> in <TeamTile team={e.team} size={14} /> {e.team.name}</> : null}</div>
                  <Link className="th-obj md-focus" href={e.href}>
                    <span className="th-kico">{e.icon}</span>
                    <span className="min-w-0 flex-1"><span className="th-t" dir="auto">{e.title}</span><span className="th-s">{e.sub}</span></span>
                  </Link>
                </div>
                <span className="th-ts">{new Date(e.t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {events.length > limit && <button type="button" className="th-more md-focus" onClick={() => setLimit((n) => n + 10)}>Show more</button>}
    </section>
  );
}
