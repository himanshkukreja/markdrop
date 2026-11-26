"use client";

/**
 * The Home's widgets that load their own data (components/home/Dashboard.tsx renders them; the ones built
 * on GET /home — Needs you, My to-dos, Recent, Meetings, Workspaces — are Home.tsx's own sections). Loaded
 * on demand (next/dynamic), each with its own request and skeleton, so a slow card never holds up the rest.
 * Team cards reuse the team Overview's (components/teams/HomeCards, BriefCard) and share one team-home
 * request per team (lib/dashboard teamHomeOnce).
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Icon, Skeleton, cx } from "@/components/ui";
import { useRouter } from "next/navigation";
import { backlogItems, teamHomeOnce, type BacklogItemRow, type Widget } from "@/lib/dashboard";
import { favoritesSlot, useFavorites, type Favorite } from "@/lib/favorites";
import { itemsKey, useFolderItems } from "@/lib/navStore";
import { useWorkspaceTree } from "@/lib/workspaceStore";
import { teamsSlot, useTeamsSidebar } from "@/lib/teamsStore";
import { teamMeetingsHref, teamMemoryHref, type TeamHome, type TeamHomeLocked } from "@/lib/teams";
import { meetingsHref } from "@/lib/meetings";
import { dealsBoard, fmtAmount, type DealBoard } from "@/lib/hubspot";
import { getHome as getAnalytics, type HomeAnalytics } from "@/lib/analytics";
import { kpiValue } from "@/components/analytics/format";
import { getAskSuggestions, type AskSuggestions } from "@/lib/ask";
import { askHref, homeChips } from "@/lib/askCore.mjs";
import { getPage } from "@/lib/pages";
import { FeedCard, ItemIcon, MeetingsCard, WhoCard } from "@/components/teams/HomeCards";
import { BriefCard } from "@/components/teams/TeamHome";
import { fmtShortDate } from "@/components/teams/parts";
import { track } from "@/lib/track";
import { getChanges, markVisit, type Changes } from "@/lib/people";
import { inApp } from "@/components/people/PersonCard";
import "@/components/teams/teams.css";
import "@/components/people/people.css";

const PageRenderer = dynamic(() => import("@/components/pages/PageRenderer").then((m) => m.PageRenderer), {
  ssr: false, loading: () => <Skeleton variant="rect" height={160} />,
});

const enc = encodeURIComponent;
export interface WidgetProps { ws: string | null; w: Widget; wide: boolean }
const n = (w: Widget, fallback: number) => (typeof w.settings.count === "number" ? w.settings.count : fallback);

/** The frame every widget here shares: the team Overview's card (teams.css .th-card). */
export function Card({ w, icon, title, chip, action, children, className }: {
  w: Widget; icon: string; title: React.ReactNode; chip?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  const hid = `db-h-${w.id}`;
  return (
    <section className={cx("th-card db-card", className)} aria-labelledby={hid} data-testid={`home-w-${w.type}`}>
      <div className="th-ch">
        <h2 id={hid}><Icon name={icon} size={16} /> <span className="truncate">{title}</span></h2>
        {chip ? <span className="th-chip">{chip}</span> : null}
        {action}
      </div>
      {children}
    </section>
  );
}

function Rows({ n: count = 3 }: { n?: number }) {
  return (
    <ul className="th-list" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="th-li"><Skeleton width={28} height={28} variant="rect" /><span className="th-tx"><Skeleton width="70%" /><Skeleton width="40%" height={10} /></span></li>
      ))}
    </ul>
  );
}

function Failed({ text = "Couldn't load this. It'll try again when you come back." }: { text?: string }) {
  return <p className="th-empty"><Icon name="alert" size={14} /> {text}</p>;
}

/** A promise's value, null while loading, false when it failed. Reruns when `key` changes. */
function useLoad<T>(key: string | null, load: () => Promise<T>): T | null | false {
  const [v, setV] = useState<{ key: string | null; v: T | null | false }>({ key: null, v: null });
  useEffect(() => {
    if (!key) return;
    let on = true;
    load().then((x) => { if (on) setV({ key, v: x }); }).catch(() => { if (on) setV({ key, v: false }); });
    return () => { on = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return v.key === key ? v.v : null;
}

function teamName(ws: string | null, team: unknown): string | null {
  if (!ws || typeof team !== "string") return null;
  const s = teamsSlot(ws);
  return (s && s.teams.find((t) => t.id === team)?.name) || null;
}

/* ── Favorites ── */

const FAV_ICON: Record<string, string> = { team: "users", project: "layers", doc: "doc" };
export function FavoritesWidget({ ws, w }: WidgetProps) {
  useFavorites(ws);
  const slot = ws ? favoritesSlot(ws) : undefined;
  const items = (slot || []) as Favorite[];
  return (
    <Card w={w} icon="star" title="Favorites">
      {slot === undefined || slot === null ? <Rows /> : slot === false ? <Failed /> : items.length === 0 ? (
        <p className="th-empty">Star a page, file, team or project (☆ in its menu) to keep it here.</p>
      ) : (
        <ul className="th-list">
          {items.slice(0, n(w, 6)).map((f) => (
            <li key={`${f.kind}:${f.ref}`}>
              <Link className="th-li md-focus" href={f.href} data-testid="home-favorite">
                <span className="th-kico"><Icon name={f.kind === "doc" ? (f.editor === "blocks" ? "doc" : f.doc_kind === "artifact" ? "layers" : "lines") : FAV_ICON[f.kind] ?? "star"} size={15} /></span>
                <span className="th-tx"><span className="th-t" dir="auto">{f.title || f.ref}</span>
                  <span className="th-s">{f.kind === "doc" ? (f.doc_kind === "artifact" ? "File" : "Page") : f.kind === "team" ? "Team" : "Project"}</span></span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ── A folder ── */

export function FolderWidget({ ws, w }: WidgetProps) {
  const fid = typeof w.settings.folder === "string" ? w.settings.folder : null;
  const tree = useWorkspaceTree(ws).tree;
  const folder = tree?.folders.find((f) => f.id === fid) ?? null;
  const { data, error } = useFolderItems(ws && fid ? itemsKey(ws, fid) : null, 30_000);
  const href = ws && fid ? `/w/${enc(ws)}/f/${enc(fid)}` : "#";
  const items = data?.items ?? [];
  return (
    <Card w={w} icon="folder" title={folder?.name ?? "Folder"} chip={folder ? `${folder.total_count} items` : undefined}
      action={<Link className="th-lnk" href={href}>Open</Link>}>
      {!data && !error ? <Rows /> : !data ? <Failed text="You can't open this folder, or it was deleted." /> : items.length === 0 ? (
        <p className="th-empty">Nothing in this folder yet.</p>
      ) : (
        <ul className="th-list">
          {items.slice(0, n(w, 6)).map((it) => (
            <li key={it.slug}>
              <Link className="th-li md-focus" href={`/${enc(it.slug)}`}>
                <span className="th-kico"><ItemIcon it={it} /></span>
                <span className="th-tx"><span className="th-t" dir="auto">{it.title?.trim() || it.original_filename || it.slug}</span>
                  <span className="th-s">{it.owner?.name ? `${it.owner.name} · ` : ""}{fmtShortDate(it.updated_at)}</span></span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ── Team backlog ── */

const STATUS_ICON: Record<string, string> = { open: "square", in_progress: "clock", done: "checkSquare", wont_do: "x" };
const PRIORITY_LABEL: Record<string, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };
const SINCE_LABEL: Record<string, string> = { "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days", month: "This month" };
export function BacklogWidget({ ws, w }: WidgetProps) {
  useTeamsSidebar(ws ? [ws] : []);
  const team = typeof w.settings.team === "string" ? w.settings.team : null;
  const cat = (w.settings.category as string | null) ?? null;
  const st = (w.settings.status as string | null) ?? null;
  const pr = (w.settings.priority as string | null) ?? null;
  const since = (w.settings.since as string | null) ?? null;
  const got = useLoad(ws && team ? `${ws}:${team}:${cat}:${st}:${pr}:${since}` : null,
    () => backlogItems(ws!, team!, { category: cat, status: st, priority: pr, since, sort: "priority" }));
  const items: BacklogItemRow[] = got ? got.items : [];
  const name = teamName(ws, team);
  const slot = ws ? teamsSlot(ws) : null;
  const page = slot ? slot.teams.find((t) => t.id === team)?.backlog?.slug : null;
  const filter = [items[0] && cat ? items[0].category_label : null, st ? items.find((i) => i.status === st)?.status_label ?? null : null,
    pr ? PRIORITY_LABEL[pr] ?? null : null, since ? SINCE_LABEL[since] ?? null : null].filter(Boolean).join(" · ");
  return (
    <Card w={w} icon="list" title={name ? `${name} backlog` : "Team backlog"} chip={filter || (got ? `${items.length} open` : undefined)}
      action={page ? <Link className="th-lnk" href={`/${enc(page)}?space=${enc(`team:${team}`)}&ws=${enc(ws!)}`}>Open</Link> : null}>
      {got === null ? <Rows /> : got === false ? <Failed /> : items.length === 0 ? (
        <p className="th-empty"><Icon name="check" size={14} /> Nothing here{cat || st || pr || since ? " for this filter" : ""}. Items from the team&apos;s calls show up after each one.</p>
      ) : (
        <ul className="th-list">
          {items.slice(0, n(w, 6)).map((it) => (
            <li key={it.id}>
              <Link className="th-li md-focus" href={it.href ?? "#"} data-testid="home-backlog-item">
                <span className={cx("th-kico", it.status === "done" && "th-kico--ok")}><Icon name={STATUS_ICON[it.status] ?? "square"} size={15} /></span>
                <span className="th-tx"><span className="th-t" dir="auto">{it.text}</span>
                  <span className="th-s">{[it.priority && it.priority !== "medium" ? it.priority_label : null, it.category_label, it.company, it.owner?.name ? `@${it.owner.name}` : null, it.mentions > 1 ? `${it.mentions} calls` : null].filter(Boolean).join(" · ")}</span></span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ── Team cards: brief, who's doing what, meetings, activity ── */

function useTeamHome(ws: string | null, team: string | null) {
  return useLoad<TeamHome | TeamHomeLocked>(ws && team ? `${ws}:${team}` : null, () => teamHomeOnce(ws!, team!));
}
const isOpen = (h: TeamHome | TeamHomeLocked): h is TeamHome => h.can_read !== false;

export function BriefWidget({ ws, w }: WidgetProps) {
  const team = typeof w.settings.team === "string" ? w.settings.team : null;
  const h = useTeamHome(ws, team);
  if (h === null) return <Card w={w} icon="megaphone" title="Team brief"><Rows n={4} /></Card>;
  if (h === false) return <Card w={w} icon="megaphone" title="Team brief"><Failed /></Card>;
  return <div data-testid="home-w-brief"><BriefCard ws={ws!} teamId={h.team.id} teamName={h.team.name} initial={h.brief} briefId={null} /></div>;
}

export function MemoryWidget({ ws, w }: WidgetProps) {
  const team = typeof w.settings.team === "string" ? w.settings.team : null;
  const h = useTeamHome(ws, team);
  if (h === null || h === false || !isOpen(h)) {
    return <Card w={w} icon="users" title="Who's doing what">{h === null ? <Rows n={4} /> : <Failed />}</Card>;
  }
  const href = h.team.general ? `/team/${enc(ws!)}` : teamMemoryHref(ws!, h.team);
  return <div data-testid="home-w-memory"><WhoCard memory={h.memory as TeamHome["memory"] & { enabled?: boolean }} href={href} chip={h.team.name} /></div>;
}

export function TeamMeetingsWidget({ ws, w }: WidgetProps) {
  const team = typeof w.settings.team === "string" ? w.settings.team : null;
  const h = useTeamHome(ws, team);
  if (h === null || h === false || !isOpen(h)) {
    return <Card w={w} icon="mic" title="Meetings">{h === null ? <Rows n={4} /> : <Failed />}</Card>;
  }
  const count = n(w, 6);
  return (
    <div data-testid="home-w-meetings">
      <MeetingsCard meetings={h.meetings.slice(0, count)} title={`${h.team.name} meetings`}
        href={teamMeetingsHref(ws!, h.team)} importHref={`${meetingsHref(ws!)}?import=1`} />
    </div>
  );
}

export function ActivityWidget({ ws, w }: WidgetProps) {
  const h = useTeamHome(ws, "general");
  if (h === null || h === false || !isOpen(h)) {
    return <Card w={w} icon="wave" title="What's happening">{h === null ? <Rows n={4} /> : <Failed />}</Card>;
  }
  // "How many" is the whole feed: about a third meetings, the rest pages and files.
  const count = n(w, 5);
  const meets = (h.activity?.meetings ?? h.meetings).slice(0, Math.max(1, Math.floor(count / 3)));
  return (
    <div data-testid="home-w-activity">
      <FeedCard items={(h.activity?.items ?? h.recent).slice(0, count - meets.length)} meetings={meets} across />
    </div>
  );
}

/* ── What changed since I last looked ── */

function sinceText(c: Changes): string {
  const d = new Date(c.since);
  const when = Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return c.basis === "visit" ? `Since you last looked · ${when}` : c.basis === "default" ? "The last 7 days (no earlier visit)" : `Since ${when}`;
}

export function ChangesWidget({ ws, w }: WidgetProps) {
  const team = typeof w.settings.team === "string" ? w.settings.team : null;
  const count = n(w, 6);
  const got = useLoad<Changes>(ws ? `changes:${ws}:${team ?? ""}:${count}` : null, () => getChanges(ws!, { team, limit: count }));
  useEffect(() => { if (ws && got) markVisit(ws, team ? { team } : undefined); }, [ws, team, got]);
  const title = team ? `What changed in ${teamName(ws, team) ?? "the team"}` : "What changed";
  const total = got ? Object.values(got.totals).reduce((a, b) => a + b, 0) : 0;
  const groups = got ? ([
    ["mic", "Meetings", got.totals.meetings, got.meetings.slice(0, count).map((m, i) => (
      <a key={i} className="wc-li md-focus" href={inApp(m.url) ?? "#"} data-testid="home-change">
        <span className="wc-t" dir="auto">{m.title}{m.summary ? <span className="wc-sum">{m.summary}</span> : null}</span>
        <small>{fmtShortDate(m.date)}</small></a>))],
    ["check", "Decisions", got.totals.decisions, got.decisions.slice(0, Math.min(3, count)).map((d, i) => (
      <a key={i} className="wc-li md-focus" href={inApp(d.url) ?? "#"}><span className="wc-t" dir="auto">{d.text}</span><small>{d.meeting}</small></a>))],
    ["plus", "New pages & files", got.totals.documents_new, got.documents_new.slice(0, count).map((d, i) => (
      <a key={i} className="wc-li md-focus" href={inApp(d.url) ?? "#"} data-testid="home-change">
        <span className="wc-t" dir="auto">{d.title}</span><small>{[d.by, fmtShortDate(d.at)].filter(Boolean).join(" · ")}</small></a>))],
    ["edit", "Updated", got.totals.documents_updated, got.documents_updated.slice(0, count).map((d, i) => (
      <a key={i} className="wc-li md-focus" href={inApp(d.url) ?? "#"} data-testid="home-change">
        <span className="wc-t" dir="auto">{d.title}</span><small>{[d.by, fmtShortDate(d.at)].filter(Boolean).join(" · ")}</small></a>))],
    ["checkSquare", "Action items", got.totals.action_items, got.action_items.slice(0, Math.min(4, count)).map((a, i) => (
      <a key={i} className="wc-li md-focus" href={inApp(a.url) ?? "#"}>
        <span className="wc-t" dir="auto">{a.done ? <s>{a.text}</s> : a.text}</span><small>{a.owner ?? ""}</small></a>))],
    ["message", "Comments", got.totals.comments, got.comments.slice(0, Math.min(4, count)).map((c, i) => (
      <a key={i} className="wc-li md-focus" href={inApp(c.url) ?? "#"}>
        <span className="wc-t" dir="auto">{c.by ? `${c.by}: ` : ""}{c.text || "a comment"}<span className="wc-sum">on {c.on}</span></span>
        <small>{fmtShortDate(c.at)}</small></a>))],
  ] as const).filter(([, , t]) => t > 0) : [];
  return (
    <Card w={w} icon="history" title={title} chip={got ? `${total} new` : undefined}>
      {got === null ? <Rows n={4} /> : got === false ? <Failed /> : (
        <>
          <p className="wc-since" data-testid="home-changes-since">{sinceText(got)}</p>
          {groups.length === 0 ? <p className="th-empty">Nothing new since then.</p> : groups.map(([icon, label, t, rows]) => (
            <div key={label} className="wc-group">
              <h3 className="wc-h"><Icon name={icon} size={13} /> {label} <b>{t}</b></h3>
              {rows}
            </div>
          ))}
        </>
      )}
    </Card>
  );
}

/* ── Deals ── */

export function DealsWidget({ ws, w }: WidgetProps) {
  const got = useLoad<DealBoard>(ws ? `deals:${ws}` : null, () => dealsBoard(ws!));
  const deals = got ? got.deals.filter((d) => !d.closed) : [];
  return (
    <Card w={w} icon="briefcase" title="Deals" chip={got ? `${deals.length} open` : undefined}
      action={ws ? <Link className="th-lnk" href={`/deals/${enc(ws)}`}>All deals</Link> : null}>
      {got === null ? <Rows /> : got === false ? <Failed /> : deals.length === 0 ? (
        <p className="th-empty">No open deals. They come from HubSpot; Sync now on the Deals page brings new ones in.</p>
      ) : (
        <ul className="th-list">
          {deals.slice(0, n(w, 6)).map((d) => (
            <li key={d.id}>
              <Link className="th-li md-focus" href={`/deals/${enc(ws!)}/${enc(d.id)}`}>
                <span className="th-kico"><Icon name="briefcase" size={15} /></span>
                <span className="th-tx"><span className="th-t" dir="auto">{d.name}</span>
                  <span className="th-s">{[d.company?.name, d.stage, d.calls ? `${d.calls} ${d.calls === 1 ? "call" : "calls"}` : null].filter(Boolean).join(" · ")}</span></span>
                {d.amount != null && <span className="th-end">{fmtAmount(d.amount, d.currency)}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ── My documents' views ── */

export function ViewsWidget({ w, wide }: WidgetProps) {
  const range = w.settings.range === "30d" ? "30d" : "7d";
  const got = useLoad<HomeAnalytics>(`views:${range}`, () => getAnalytics({ range, internal: false }));
  const kpis = got ? got.kpis.slice(0, 3) : [];
  const links = got ? got.links.filter((l) => l.views > 0).slice(0, wide ? 5 : 4) : [];
  return (
    <Card w={w} icon="chart" title="Views of your documents" chip={range === "30d" ? "30 days" : "7 days"}
      action={<Link className="th-lnk" href="/dashboard/analytics">Analytics</Link>}>
      {got === null ? <Skeleton variant="rect" height={96} /> : got === false ? <Failed /> : (
        <>
          <dl className="db-kpis">
            {kpis.map((k) => (
              <div key={k.key} className="db-kpi"><dt>{k.label}</dt><dd>{kpiValue(k)}</dd></div>
            ))}
          </dl>
          {links.length === 0 ? <p className="th-empty">No views in this period yet. Share a link and it shows here.</p> : (
            <ul className="th-list">
              {links.map((l) => (
                <li key={l.slug}>
                  <Link className="th-li md-focus" href={`/dashboard/analytics/${enc(l.slug)}`}>
                    <span className="th-tx"><span className="th-t" dir="auto">{l.title || l.slug}</span>
                      <span className="th-s">{l.engage_label ?? (l.last_view ? `Last view ${fmtShortDate(l.last_view)}` : "")}</span></span>
                    <span className="th-end db-views">{l.views.toLocaleString()} {l.views === 1 ? "view" : "views"}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

/* ── Pinned page ── */

export function PinnedWidget({ w }: WidgetProps) {
  const slug = typeof w.settings.page === "string" ? w.settings.page : null;
  const got = useLoad(slug ? `page:${slug}` : null, () => getPage(slug!));
  const page = got || null;
  return (
    <Card w={w} icon="doc" title={w.title || page?.title || "Pinned page"} className="db-pinned"
      action={slug ? <Link className="th-lnk" href={`/${enc(slug)}`}>Open</Link> : null}>
      {got === null ? <Skeleton variant="rect" height={160} /> : got === false || !page ? <Failed text="You can't open this page any more." /> : (
        <div className="db-pinned__body">
          <PageRenderer slug={slug!} content={page.content ?? ""} assets={page.assets ?? null} title={page.title ?? null} />
        </div>
      )}
    </Card>
  );
}

/* ── Quick actions ── */

export function QuickWidget({ ws, w, wide }: WidgetProps) {
  const q = ws ? `?workspace=${enc(ws)}` : "";
  const acts = [
    { id: "page", icon: "doc", label: "New page", href: `/pages/new${q}` },
    { id: "upload", icon: "upload", label: "Upload a file", href: "/upload" },
    ...(ws ? [{ id: "meeting", icon: "mic", label: "Import meeting", href: `${meetingsHref(ws)}?import=1` }] : []),
    { id: "search", icon: "search", label: "Find anything", href: "/search" },
  ];
  return (
    <Card w={w} icon="zap" title="Quick actions">
      <ul className={cx("db-quick", wide && "db-quick--wide")}>
        {acts.map((a) => (
          <li key={a.id}>
            <Link className="db-quick__btn md-focus" href={a.href} onClick={() => track("home_action", { what: `quick_${a.id}` })} data-testid={`home-quick-${a.id}`}>
              <Icon name={a.icon} size={16} /> <span>{a.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ── Ask suggestions ── */

export function AskWidget({ ws, w }: WidgetProps) {
  const router = useRouter();
  const got = useLoad<AskSuggestions>(ws ? `ask:${ws}` : null, () => getAskSuggestions(ws));
  const chips = useMemo(() => (got ? homeChips(got, 4) : []), [got]);
  const fallback = ["What did we decide this week?", "What's blocked right now?", "Summarize my last meeting"];
  const list = chips.length ? chips.map((c) => ({ label: c.label, q: c.question })) : fallback.map((x) => ({ label: x, q: x }));
  return (
    <Card w={w} icon="sparkle" title="Ask" chip={got && got.workspace ? got.workspace.name : undefined}>
      {got === null ? <Rows n={3} /> : (
        <ul className="db-asks">
          {list.map((c) => (
            <li key={c.label}>
              <button type="button" className="db-ask md-focus" data-testid="home-ask-suggestion"
                onClick={() => { track("home_action", { what: "ask_widget" }); router.push(askHref({ workspace: ws, q: c.q })); }}>
                <Icon name="sparkle" size={14} /> <span dir="auto">{c.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Empty state shared by widgets the person still has to set up (Dashboard renders it with a Settings button). */
export function SetupNote({ text, action }: { text: string; action?: React.ReactNode }) {
  return <div className="db-setup"><p className="th-empty">{text}</p>{action}</div>;
}
