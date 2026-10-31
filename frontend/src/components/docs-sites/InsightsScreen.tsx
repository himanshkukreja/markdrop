"use client";

/**
 * /guides/<site>/insights: how readers use the published guide. Four numbers against the period
 * before (readers, page views, Ask AI answers, "found it helpful"), readers per day, the top pages
 * with how helpful each was, what readers couldn't find (searches with no results and questions
 * Ask AI couldn't answer, each a page worth writing), and reader feedback to work through. Below:
 * where readers come from, what they look for, and the Collection card (admins turn collection
 * off or delete what was kept).
 *
 * Before there is anything to show, the tab says why: not published yet (publish), Insights off
 * (what it does; admins turn it on), or collecting with no readers yet (the guide's address to
 * share, and what will show up).
 *
 * Collection is first-party and cookieless (backend services/guide_insights.py; the docs page
 * /guides/insights says what is and isn't kept). Readers' words (pages, queries, questions,
 * comments) are the customer's content: every list of them is `ph-no-capture` for session replay.
 */
import { useId, useState } from "react";
import Link from "next/link";
import {
  Alert, Badge, Button, ConfirmDialog, CopyButton, Icon, SegmentedControl, Skeleton, Switch, Tabs, cx, useToast,
} from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { BarList, ReadersLineChart } from "@/components/analytics/charts";
import { countryName, day } from "@/components/analytics/format";
import { LoadError, PanelSkeleton, Quiet, useLoad, useParams } from "@/components/analytics/parts";
import { docsErrorMessage, primaryAddress, updateSite } from "@/lib/docsSites";
import {
  INSIGHTS_RANGES, clearInsights, getInsights, isInsightsRange, resolveFeedback,
  type FeedbackItem, type Insights, type InsightsRange, type MissingItem,
} from "@/lib/guideInsights";
import { guideEvents } from "@/lib/guidesEvents";
import { num, plural, timeAgo } from "./format";
import { barWidth, change, helpfulTone, missingNote, newPageHref, titleFromQuery, type Tone } from "./insightsModel";
import SiteBar from "./SiteBar";
import { useSite } from "./SiteContext";

type FbTab = "open" | "resolved";

const DEVICE_WORD: Record<string, string> = { desktop: "Computer", mobile: "Phone", tablet: "Tablet" };
const INK: Record<Tone, string> = { success: "text-success", danger: "text-danger", warning: "text-warning", muted: "text-text-muted" };
const DASH = "—";

/* ── Pieces ───────────────────────────────────────────────────────────── */

function Card({ id, title, aside, children, className }: {
  id: string; title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <section aria-labelledby={id} className={cx("flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4 sm:p-5", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id={id} className="m-0 flex-1 text-[16px] font-semibold leading-6 text-text">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Tile({ label, value, delta, note, noteTone = "muted" }: {
  label: string;
  value: string;
  delta?: ReturnType<typeof change>;
  note?: string | null;
  noteTone?: Tone;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-surface p-3 sm:p-4">
      <span className="text-caption text-text-muted">{label}</span>
      <strong className="text-[22px] font-bold leading-7 tracking-[-0.01em] text-text tabular-nums sm:text-[26px] sm:leading-8">{value}</strong>
      {delta && (
        <span className={cx("flex items-start gap-1 text-caption", INK[delta.tone])}>
          <Icon name={delta.dir === "up" ? "arrowUp" : delta.dir === "down" ? "arrowDown" : "minus"} size={12} className="mt-1 shrink-0" />
          <span><span className="md-visually-hidden">{delta.dir === "up" ? "Up " : delta.dir === "down" ? "Down " : ""}</span>{delta.text}</span>
        </span>
      )}
      {note && <span className={cx("text-caption", INK[noteTone])}>{note}</span>}
    </div>
  );
}

function TilesSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4" aria-hidden>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4">
          <Skeleton width="50%" height={12} />
          <Skeleton width="60%" height={28} />
          <Skeleton width="80%" height={12} />
        </div>
      ))}
    </div>
  );
}

function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5" aria-hidden>
      <Skeleton width="40%" height={16} />
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} variant="rect" height={28} />)}
    </div>
  );
}

/** What the tab shows once readers arrive (the empty, not-published and off states). */
const WHAT: { icon: string; title: string; note: string }[] = [
  { icon: "eye", title: "Readers and top pages", note: "Daily readers, page views, and where readers come from." },
  { icon: "search", title: "Searches with no results", note: "The pages your readers expected you to have." },
  { icon: "sparkle", title: "Ask AI questions", note: "The most asked, and the ones it couldn't answer." },
  { icon: "checkCircle", title: "Page feedback", note: "“Did this page help?” votes, and comments to resolve." },
];

function WhatYoullSee({ id }: { id: string }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3.5">
      <h2 id={id} className="m-0 text-[18px] font-semibold leading-7 text-text">What you&rsquo;ll see</h2>
      <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-4">
        {WHAT.map((w) => (
          <li key={w.title} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4">
            <span className="grid size-[34px] place-items-center rounded-[9px] bg-accent-soft text-accent-text"><Icon name={w.icon} size={16} /></span>
            <strong className="text-body-strong text-text">{w.title}</strong>
            <span className="text-[13px] leading-5 text-text-secondary">{w.note}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The dimmed "this is where numbers go" picture beside the empty state's words. */
function PreviewGhost() {
  return (
    <div aria-hidden className="grid min-w-0 flex-[1_1_320px] grid-cols-2 gap-2.5 opacity-55 saturate-[.6]">
      {["Readers", "Found it helpful"].map((l) => (
        <div key={l} className="rounded-xl bg-surface-inset p-3.5">
          <span className="block text-micro text-text-muted">{l}</span>
          <strong className="text-[22px] leading-7 text-text">{DASH}</strong>
        </div>
      ))}
      <div className="col-span-2 flex h-[110px] items-end rounded-xl bg-surface-inset p-3">
        <svg viewBox="0 0 300 70" preserveAspectRatio="none" className="h-[70px] w-full">
          <polyline points="0,60 40,58 80,50 120,52 160,40 200,34 240,26 300,14" fill="none" stroke="var(--border-strong)"
            strokeWidth={2.5} strokeDasharray="5 5" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
    </div>
  );
}

function Hero({ id, badge, title, children, aside }: {
  id: string; badge?: React.ReactNode; title: string; children: React.ReactNode; aside?: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-wrap items-center gap-6 rounded-2xl border border-border bg-surface p-5 sm:gap-9 sm:p-8">
      <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-3">
        {badge && <div>{badge}</div>}
        <h1 id={id} className="m-0 text-[24px] font-bold leading-8 text-text sm:text-[28px] sm:leading-9">{title}</h1>
        {children}
      </div>
      {aside}
    </section>
  );
}

function PrivacyLine({ isAdmin }: { isAdmin: boolean }) {
  return (
    <p className="m-0 text-[13px] leading-5 text-text-muted">
      Private by design: no cookies, no personal data, visitors counted anonymously per day. Raw events are kept 90 days.{" "}
      <ReadMore topic="studioInsights">How Insights works</ReadMore>
      {" · "}
      {isAdmin ? <a href="#ins-collection" className="text-accent-text hover:text-accent-text-hover">Turn it off</a>
        : <ReadMore topic="studioInsightsOff">Turning it off</ReadMore>}
    </p>
  );
}

/* ── The screen ───────────────────────────────────────────────────────── */

export default function InsightsScreen() {
  const { site, setSite, isAdmin, canEdit, base } = useSite();
  const toast = useToast();
  const uid = useId();
  const [params, setParams] = useParams();
  const rawRange = params.get("range");
  const range: InsightsRange = isInsightsRange(rawRange) ? rawRange : "30d";
  const [fbTab, setFbTab] = useState<FbTab>("open");
  const [patched, setPatched] = useState<Record<string, FeedbackItem>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState("");
  const [nonce, setNonce] = useState(0);
  const [sourceTab, setSourceTab] = useState<"sites" | "countries" | "devices">("sites");
  const [lookTab, setLookTab] = useState<"searches" | "ask">("searches");
  const load = useLoad<Insights>(`ins:${site.id}:${range}:${fbTab}:${nonce}`, () => getInsights(site.id, range, fbTab));
  const data = load.data;
  const enabled = site.settings.insights?.enabled !== false;
  const rangeWords = INSIGHTS_RANGES.find((r) => r.value === range)!.label;
  const address = primaryAddress(site);
  const liveUrl = `https://${address}`;
  const aiOn = site.settings.ai?.enabled !== false;

  async function toggle(on: boolean) {
    setSaving(true);
    try {
      setSite(await updateSite(site.id, { settings: { insights: { enabled: on } } }));
      toast.success(on ? "Insights is on. New visits are counted from now." : "Insights is off. Nothing new is collected.");
      setNonce((n) => n + 1);
    } catch (e) {
      toast.error(docsErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function resolve(item: FeedbackItem, resolved: boolean) {
    setBusyId(item.id);
    try {
      const got = await resolveFeedback(site.id, item.id, resolved);
      setPatched((p) => ({ ...p, [item.id]: { ...item, ...got } }));
    } catch (e) {
      toast.error(docsErrorMessage(e));
    } finally {
      setBusyId(null);
    }
  }

  async function clearAll() {
    setClearing(true);
    setClearError("");
    try {
      await clearInsights(site.id);
      setConfirmClear(false);
      setPatched({});
      setNonce((n) => n + 1);
      toast.success("Insights data deleted.");
    } catch (e) {
      setClearError(docsErrorMessage(e));
    } finally {
      setClearing(false);
    }
  }

  const collection = (
    <section id="ins-collection" aria-labelledby={`${uid}-col`} className="flex scroll-mt-32 flex-col gap-3 rounded-xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 id={`${uid}-col`} className="m-0 flex flex-1 items-center gap-2 text-[16px] font-semibold leading-6 text-text">
          <Icon name="shield" size={18} className="text-text-secondary" />Collection
        </h2>
        <Switch label={enabled ? "Collecting" : "Off"} checked={enabled} disabled={!isAdmin || saving} onChange={(e) => void toggle(e.target.checked)} />
      </div>
      <p className="m-0 text-body text-text-secondary">
        No cookies and nothing stored in readers&rsquo; browsers. Kept: the page, the site a reader came from (not the address), the
        country, the kind of device, searches, Ask AI questions and feedback. A visitor is counted with a code that changes every day,
        so nobody can be followed from one day to the next. Raw events are kept 90 days, daily totals and feedback 13 months.
        {data?.since ? ` Collecting since ${day(data.since)}.` : ""}
      </p>
      <div className={cx("flex flex-wrap items-center gap-2", !isAdmin && "text-caption text-text-muted")}>
        {isAdmin ? (
          <>
            <Button size="sm" variant="ghost" iconLeft="trash" onClick={() => setConfirmClear(true)}>Delete collected data</Button>
            <ReadMore topic="studioInsightsOff" className="text-caption">What turning it off does</ReadMore>
          </>
        ) : (
          <span>Only an admin of this guide can turn collection off or delete what was collected.</span>
        )}
      </div>
    </section>
  );

  const header = (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-[1_1_320px]">
        <h1 className="m-0 text-[24px] font-bold leading-8 text-text sm:text-[26px]">Insights</h1>
        <p className="m-0 mt-0.5 text-body text-text-secondary">
          How readers use <span className="ph-sensitive ph-mask">{site.name}</span>. No cookies, no personal data.
        </p>
      </div>
      <SegmentedControl size="sm" aria-label="Date range" value={range} onChange={(r) => { setPatched({}); setParams({ range: r === "30d" ? null : r }); }}
        options={INSIGHTS_RANGES.map((r) => ({ value: r.value, label: r.label }))} />
    </div>
  );

  let body: React.ReactNode;
  if (load.error && !data) {
    body = <>{header}<LoadError error={load.error} retry={load.retry} what="insights" /></>;
  } else if (!data) {
    body = (
      <div className="flex flex-col gap-4 sm:gap-5" aria-busy>
        {header}
        <span className="md-visually-hidden" role="status">Loading insights</span>
        <TilesSkeleton />
        <PanelSkeleton height={200} />
        <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-2"><ListSkeleton /><ListSkeleton /></div>
        <ListSkeleton rows={3} />
      </div>
    );
  } else if (!enabled && !data.since) {
    body = (
      <>
        <Hero id={`${uid}-off`} badge={<Badge>Off</Badge>} title="Insights is off" aside={<PreviewGhost />}>
          <p className="m-0 text-[15px] leading-6 text-text-secondary">
            Nothing is collected from this guide&rsquo;s readers, and the next publish leaves &ldquo;Did this page help?&rdquo; off its pages.
            Turn it on to see who&rsquo;s reading, what they search for, what Ask AI couldn&rsquo;t answer, and which pages helped.
          </p>
          {isAdmin
            ? <div><Button variant="primary" iconLeft="eye" loading={saving} onClick={() => void toggle(true)}>Turn on Insights</Button></div>
            : <p className="m-0 text-[13px] text-text-muted">An admin of this guide can turn it on.</p>}
        </Hero>
        <WhatYoullSee id={`${uid}-what`} />
        <PrivacyLine isAdmin={false} />
      </>
    );
  } else if (!data.live && !data.since) {
    body = (
      <>
        <Hero id={`${uid}-unpub`} badge={<Badge>Not published yet</Badge>} title="Publish your guide to see its readers" aside={<PreviewGhost />}>
          <p className="m-0 text-[15px] leading-6 text-text-secondary">
            Insights counts readers of the published guide. Once it&rsquo;s live, views show up here within a minute, and searches,
            Ask AI questions and feedback follow as readers use them.
          </p>
          {canEdit
            ? <div><Button variant="primary" iconRight="arrowRight" href={`${base}/publish`}>Go to Publish</Button></div>
            : <p className="m-0 text-[13px] text-text-muted">Someone who can publish this guide puts it live.</p>}
        </Hero>
        <WhatYoullSee id={`${uid}-what`} />
        <PrivacyLine isAdmin={isAdmin} />
        {collection}
      </>
    );
  } else if (!data.since) {
    body = (
      <>
        <Hero id={`${uid}-empty`} badge={<Badge tone="success" dot>Collecting</Badge>} title="Your first readers will show up here" aside={<PreviewGhost />}>
          <p className="m-0 text-[15px] leading-6 text-text-secondary">
            Insights is on. As soon as someone opens your guide you&rsquo;ll see who&rsquo;s reading, what they search for, what Ask AI
            couldn&rsquo;t answer, and which pages helped. New views show up within a minute.
          </p>
          <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-inset py-2 pl-3 pr-2">
            <Icon name="globe" size={15} className="shrink-0 text-text-secondary" />
            <span className="ph-sensitive ph-mask min-w-0 flex-1 break-all font-mono font-semibold text-text">{address}</span>
            <span className="flex shrink-0 items-center gap-1">
              <CopyButton text={liveUrl} label="Copy link" size="sm" variant="ghost" />
              <Button size="sm" variant="secondary" iconRight="external" href={liveUrl} target="_blank" rel="noopener noreferrer">
                Open<span className="md-visually-hidden"> (opens in a new tab)</span>
              </Button>
            </span>
          </div>
          <span className="text-[13px] text-text-muted">Share the link with your users, or add it to your app&rsquo;s Help menu.</span>
        </Hero>
        <WhatYoullSee id={`${uid}-what`} />
        <PrivacyLine isAdmin={isAdmin} />
        {collection}
      </>
    );
  } else {
    body = (
      <>
        {header}
        {!enabled && (
          <Alert tone="warning" title="Insights is off"
            actions={isAdmin ? <Button size="sm" variant="secondary" loading={saving} onClick={() => void toggle(true)}>Turn it on</Button> : undefined}>
            Nothing new is collected, and the next publish leaves &ldquo;Did this page help?&rdquo; off the guide. What was collected before stays until it expires.
            {isAdmin ? "" : " An admin of this guide can turn it back on."}
          </Alert>
        )}
        {enabled && !data.live && (
          <Alert tone="info" title="This guide isn't published right now">
            These numbers are from when it was live. New readers are counted once it&rsquo;s published again.
          </Alert>
        )}
        <Dashboard
          data={data} uid={uid} rangeWords={rangeWords} aiOn={aiOn} base={base} liveUrl={data.live ? liveUrl : null} canEdit={canEdit}
          fbTab={fbTab} setFbTab={(t) => { setPatched({}); setFbTab(t); }} patched={patched} busyId={busyId} onResolve={resolve}
          sourceTab={sourceTab} setSourceTab={setSourceTab} lookTab={lookTab} setLookTab={setLookTab}
        />
        {collection}
      </>
    );
  }

  return (
    <>
      <SiteBar section="insights" />
      <main id="main" tabIndex={-1} className="mx-auto flex w-full min-w-0 max-w-[1180px] flex-col gap-4 px-4 pb-16 pt-6 outline-none sm:gap-5 sm:px-6 sm:pt-8">
        {body}
      </main>
      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={() => void clearAll()}
        title="Delete this guide's insights?"
        description="Every page view, search and feedback comment collected so far is deleted, and Ask AI questions leave this tab. Collection carries on unless you turn it off. This can't be undone."
        confirmLabel="Delete data"
        busy={clearing}
        error={clearError || undefined}
      />
    </>
  );
}

/* ── With data ────────────────────────────────────────────────────────── */

function Dashboard({
  data, uid, rangeWords, aiOn, base, liveUrl, canEdit, fbTab, setFbTab, patched, busyId, onResolve,
  sourceTab, setSourceTab, lookTab, setLookTab,
}: {
  data: Insights; uid: string; rangeWords: string; aiOn: boolean; base: string; liveUrl: string | null; canEdit: boolean;
  fbTab: FbTab; setFbTab: (t: FbTab) => void; patched: Record<string, FeedbackItem>; busyId: string | null;
  onResolve: (i: FeedbackItem, resolved: boolean) => void;
  sourceTab: "sites" | "countries" | "devices"; setSourceTab: (t: "sites" | "countries" | "devices") => void;
  lookTab: "searches" | "ask"; setLookTab: (t: "searches" | "ask") => void;
}) {
  const prev = data.previous;
  const votes = data.feedback.yes + data.feedback.no;
  const helpful = data.feedback.helpful_pct;
  const asked = data.ask.answered + data.ask.unanswered;

  // Open / Resolved after what was resolved or reopened here since the last load.
  const moved = data.feedback.items.reduce((n, i) => {
    const now = patched[i.id];
    return !now || now.resolved === i.resolved ? n : n + (now.resolved ? 1 : -1);
  }, 0);
  const openCount = Math.max(0, data.feedback.open - moved);
  const resolvedCount = Math.max(0, data.feedback.resolved + moved);
  const items = data.feedback.items.map((i) => patched[i.id] ?? i).filter((i) => i.resolved === (fbTab === "resolved"));

  const pages = data.pages.slice(0, 8);
  const topViews = pages[0]?.views ?? 0;
  const pageHref = (pageId: string | null | undefined) => (pageId ? `${base}?page=${encodeURIComponent(pageId)}` : null);

  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        <Tile label="Readers" value={num(data.totals.visitors)} delta={change(data.totals.visitors, prev?.visitors, rangeWords)} />
        <Tile label="Page views" value={num(data.totals.views)} delta={change(data.totals.views, prev?.views, rangeWords)} />
        <Tile
          label="Ask AI answers"
          value={asked || aiOn ? num(data.ask.answered) : DASH}
          delta={asked ? change(data.ask.answered, prev?.ask_answered, rangeWords) : null}
          note={!aiOn && !asked ? "Ask AI is off" : data.ask.unanswered ? `${num(data.ask.unanswered)} unanswered` : asked ? "All answered" : "No questions yet"}
          noteTone={data.ask.unanswered ? "warning" : "muted"}
        />
        <Tile
          label="Found it helpful"
          value={helpful == null ? DASH : `${helpful}%`}
          delta={helpful == null ? null : change(helpful, prev?.helpful_pct, rangeWords, true)}
          note={votes ? `from ${plural(votes, "vote")}` : "No votes yet"}
        />
      </section>

      <Card id={`${uid}-trend`} title="Readers per day" aside={<span className="text-caption text-text-muted max-sm:hidden">Hover a day for views and readers</span>}>
        {data.daily.some((d) => d.views > 0)
          ? <ReadersLineChart daily={data.daily.map((d) => ({ date: d.date, readers: d.visitors, views: d.views }))} />
          : <Quiet>No readers in the last {rangeWords}.</Quiet>}
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-2">
        <Card id={`${uid}-top`} title="Top pages"
          aside={pages.length ? <span className="flex gap-3 text-micro text-text-muted" aria-hidden><span>Views</span><span className="w-[52px] text-right">Helpful</span></span> : undefined}>
          {pages.length ? (
            <ol className="ph-no-capture m-0 flex list-none flex-col gap-1 p-0">
              {pages.map((p) => {
                const href = pageHref(p.page_id);
                const label = p.title || p.path;
                return (
                  <li key={p.path} className="relative flex items-center gap-2.5 overflow-hidden rounded-md px-2.5 py-2">
                    <span aria-hidden className="absolute inset-y-0 left-0 bg-accent-soft" style={{ width: barWidth(p.views, topViews) }} />
                    {href ? (
                      <Link href={href} title={p.path} className="md-focus relative min-w-0 flex-1 truncate text-text no-underline hover:underline">{label}</Link>
                    ) : (
                      <span title={p.path} className="relative min-w-0 flex-1 truncate text-text">{label}</span>
                    )}
                    <span className="relative shrink-0 text-[13px] tabular-nums text-text-secondary">
                      {num(p.views)}<span className="md-visually-hidden"> {p.views === 1 ? "view" : "views"}</span>
                    </span>
                    <span className={cx("relative w-[52px] shrink-0 text-right text-caption tabular-nums", INK[helpfulTone(p.helpful_pct)])}
                      title={p.yes + p.no ? `${plural(p.yes, "helpful vote")}, ${plural(p.no, "not helpful vote")}` : "No votes yet"}>
                      {p.helpful_pct == null ? DASH : `${p.helpful_pct}%`}
                      <span className="md-visually-hidden"> found it helpful</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : <Quiet>No page views in the last {rangeWords}.</Quiet>}
        </Card>

        <Card id={`${uid}-miss`} title="What readers couldn't find"
          aside={data.missing.length ? <Badge tone="warning" size="sm">Worth a page</Badge> : undefined}>
          {data.missing.length ? (
            <ul className="ph-no-capture m-0 flex list-none flex-col gap-2 p-0">
              {data.missing.slice(0, 8).map((m) => <MissingRow key={`${m.kind}:${m.q}`} m={m} base={base} canEdit={canEdit} />)}
            </ul>
          ) : (
            <Quiet>
              Nothing in the last {rangeWords}. Searches that find nothing{aiOn ? " and questions Ask AI can't answer" : ""} show here:
              each one is a page worth writing.
            </Quiet>
          )}
        </Card>
      </div>

      <Card
        id={`${uid}-fb`}
        title="Reader feedback"
        aside={
          <>
            {helpful != null && (
              <span className="text-[13px] text-text-secondary"><strong className="text-text">{helpful}%</strong> found pages helpful</span>
            )}
            <Tabs variant="pill" size="sm" aria-label="Feedback to show" idPrefix={`${uid}-fbt`} value={fbTab}
              onChange={(v) => setFbTab(v as FbTab)}
              items={[{ value: "open", label: "Open", count: openCount }, { value: "resolved", label: "Resolved", count: resolvedCount }]} />
          </>
        }
      >
        <div role="tabpanel" id={`${uid}-fbt-panel-${fbTab}`} aria-labelledby={`${uid}-fbt-tab-${fbTab}`}>
          {items.length ? (
            <ul className="ph-no-capture m-0 flex list-none flex-col p-0">
              {items.map((i) => (
                <FeedbackRow key={i.id} item={i} canResolve={data.can_resolve} busy={busyId === i.id}
                  openHref={pageHref(i.page_id) ?? (liveUrl ? `${liveUrl}${i.path === "/" ? "" : i.path}` : null)}
                  external={!i.page_id} onResolve={(r) => onResolve(i, r)} />
              ))}
            </ul>
          ) : (
            <Quiet>
              {fbTab === "resolved" ? `Nothing resolved in the last ${rangeWords}.` :
                votes ? "No open comments. Comments and “not helpful” votes land here to work through." :
                  "Readers answer “Did this page help?” at the end of each page. Their votes and comments show here."}
            </Quiet>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-2">
        <Card id={`${uid}-src`} title="Where readers come from"
          aside={<SegmentedControl size="sm" aria-label="Show" value={sourceTab} onChange={setSourceTab}
            options={[{ value: "sites", label: "Sites" }, { value: "countries", label: "Countries" }, { value: "devices", label: "Devices" }]} />}>
          {sourceTab === "sites" ? (
            data.referrers.length
              ? <BarList className="ph-no-capture" rows={data.referrers.slice(0, 8).map((r) => ({ key: r.host, label: r.host, value: r.views, display: num(r.views) }))} />
              : <Quiet>Sites that link to your guide show here. Visits typed in, bookmarked or from apps that hide where they came from aren&rsquo;t listed.</Quiet>
          ) : sourceTab === "countries" ? (
            data.countries.length
              ? <BarList rows={data.countries.slice(0, 8).map((c) => ({ key: c.country, label: countryName(c.country), value: c.views, display: num(c.views) }))} />
              : <Quiet>Where readers are, by country, shows here.</Quiet>
          ) : (
            data.devices.length
              ? <BarList labelWidth={80} rows={data.devices.map((d) => ({ key: d.device, label: DEVICE_WORD[d.device] ?? d.device, value: d.views, display: num(d.views) }))} />
              : <Quiet>Computer, phone or tablet shows here.</Quiet>
          )}
        </Card>
        <Card id={`${uid}-look`} title="What readers look for"
          aside={<SegmentedControl size="sm" aria-label="Show" value={lookTab} onChange={setLookTab}
            options={[{ value: "searches", label: "Searches" }, { value: "ask", label: "Ask AI" }]} />}>
          {lookTab === "searches" ? (
            data.searches.top.length
              ? <BarList className="ph-no-capture" rows={data.searches.top.slice(0, 8).map((s) => ({ key: s.q, label: <span dir="auto">{s.q}</span>, value: s.n, display: num(s.n) }))} />
              : <Quiet>What readers type in the search box shows here (3 characters or more).</Quiet>
          ) : (
            data.ask.top.length
              ? <BarList className="ph-no-capture" rows={data.ask.top.slice(0, 8).map((q) => ({ key: q.q, label: <span dir="auto">{q.q}</span>, value: q.n, display: num(q.n) }))} />
              : <Quiet>{aiOn ? "The questions readers ask Ask AI most show here." : "Ask AI is off for this guide. Turn it on in Settings to see what readers ask."}</Quiet>
          )}
        </Card>
      </div>
    </>
  );
}

function MissingRow({ m, base, canEdit }: { m: MissingItem; base: string; canEdit: boolean }) {
  const isSearch = m.kind === "search";
  return (
    <li className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-md bg-surface-inset px-2.5 py-2">
      <Icon name={isSearch ? "search" : "sparkle"} size={14} className="shrink-0 text-text-secondary" />
      <span className="flex min-w-0 flex-[1_1_180px] flex-col">
        <span className="break-words text-text" dir="auto">{isSearch ? `“${m.q}”` : m.q}</span>
        <span className="text-caption text-text-muted">{missingNote(m)}</span>
      </span>
      {canEdit && (
        <Button size="sm" variant="ghost" iconLeft="plus" className="max-sm:ml-auto" href={newPageHref(base, titleFromQuery(m.q))}
          onClick={() => guideEvents.insightsWritePage(m.kind)}>
          Write a page
        </Button>
      )}
    </li>
  );
}

function FeedbackRow({ item, canResolve, busy, openHref, external, onResolve }: {
  item: FeedbackItem; canResolve: boolean; busy: boolean; openHref: string | null; external: boolean; onResolve: (resolved: boolean) => void;
}) {
  const mcp = item.source === "mcp";
  const look = mcp
    ? { icon: "sparkle", cls: "bg-accent-soft text-accent-text", word: "Reported by an AI app" }
    : item.helpful
      ? { icon: "check", cls: "bg-success-soft text-success", word: "Helpful" }
      : { icon: "x", cls: "bg-danger-soft text-danger", word: "Not helpful" };
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 border-t border-border py-3 first:border-t-0 first:pt-1">
      <span className={cx("grid size-7 shrink-0 place-items-center rounded-full", look.cls)} title={look.word}>
        <Icon name={look.icon} size={14} /><span className="md-visually-hidden">{look.word}</span>
      </span>
      <span className="flex min-w-0 flex-[1_1_260px] flex-col gap-0.5">
        {item.comment
          ? <span className="whitespace-pre-wrap break-words text-body text-text" dir="auto">{item.comment}</span>
          : <span className="text-body italic text-text-secondary">Marked &ldquo;not helpful&rdquo;, no comment.</span>}
        <span className="text-caption text-text-muted">
          <span title={item.path}>{item.title || item.path}</span>
          {" · "}<time dateTime={item.ts}>{timeAgo(item.ts)}</time>
          {" · "}{mcp ? "via an AI app (MCP)" : "from a reader"}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 max-sm:ml-10">
        {openHref && (
          <Button size="sm" variant="ghost" iconLeft={external ? "external" : "edit"} href={openHref}
            {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
            Open page{external && <span className="md-visually-hidden"> (opens in a new tab)</span>}
          </Button>
        )}
        {canResolve && (
          <Button size="sm" variant="secondary" iconLeft={item.resolved ? "refresh" : "check"} loading={busy} onClick={() => onResolve(!item.resolved)}>
            {item.resolved ? "Reopen" : "Resolve"}
          </Button>
        )}
      </span>
    </li>
  );
}
