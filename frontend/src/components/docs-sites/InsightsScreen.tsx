"use client";

/**
 * /guides/<site>/insights: how readers use the published guide. Views and visitors per day, the
 * pages they read and where they came from, what they searched for (and found nothing for), what
 * they asked Ask AI (and what it couldn't answer), and "Did this page help?" feedback to work
 * through. Anyone with a role on the guide can look; editors resolve feedback; admins turn
 * collection off or clear what was kept.
 *
 * Collection is first-party and cookieless (backend services/guide_insights.py; the docs page
 * /guides/insights says what is and isn't kept). Readers' words (pages, queries, questions,
 * comments) are the customer's content: every list of them is `ph-no-capture` for session replay.
 */
import { useMemo, useState } from "react";
import { Alert, Badge, Button, ConfirmDialog, Icon, SegmentedControl, Switch, cx, useToast } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { BarList, DailyViewsChart } from "@/components/analytics/charts";
import { countryName, day } from "@/components/analytics/format";
import { KpiGrid, KpiTile, LoadError, Panel, PanelSkeleton, Quiet, useLoad, useParams } from "@/components/analytics/parts";
import type { Kpi } from "@/lib/analytics";
import { docsErrorMessage, siteHost, updateSite } from "@/lib/docsSites";
import {
  INSIGHTS_RANGES, clearInsights, getInsights, isInsightsRange, resolveFeedback,
  type FeedbackFilter, type FeedbackItem, type Insights, type InsightsRange,
} from "@/lib/guideInsights";
import { num, timeAgo } from "./format";
import SiteBar from "./SiteBar";
import { useSite } from "./SiteContext";

const DEVICE_WORD: Record<string, string> = { desktop: "Computer", mobile: "Phone", tablet: "Tablet" };

function pageLabel(path: string, title?: string | null) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-text">{title || path}</span>
      {title && <span className="truncate font-mono text-micro text-text-muted">{path}</span>}
    </span>
  );
}

function QueryList({ rows, empty, valueWord }: { rows: { key: string; label: string; value: number; extra?: React.ReactNode }[]; empty: React.ReactNode; valueWord: string }) {
  if (!rows.length) return <Quiet>{empty}</Quiet>;
  return (
    <ol className="ph-no-capture m-0 flex list-none flex-col divide-y divide-border p-0">
      {rows.map((r) => (
        <li key={r.key} className="flex items-baseline gap-3 py-2 text-[13px]">
          <span className="min-w-0 flex-1 break-words text-text" dir="auto">{r.label}</span>
          {r.extra}
          <span className="shrink-0 tabular-nums text-text-secondary" title={`${num(r.value)} ${valueWord}`}>{num(r.value)}</span>
        </li>
      ))}
    </ol>
  );
}

function FeedbackRow({ item, canResolve, busy, onResolve, title }: {
  item: FeedbackItem; canResolve: boolean; busy: boolean; onResolve: (resolved: boolean) => void; title?: string | null;
}) {
  return (
    <li className="flex flex-col gap-1.5 py-3">
      <div className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
        <Badge size="sm" tone={item.helpful ? "success" : "warning"} icon={item.helpful ? "check" : "x"}>{item.helpful ? "Helpful" : "Not helpful"}</Badge>
        {item.source === "mcp" && <Badge size="sm" icon="sparkle">From an AI app</Badge>}
        <span className="min-w-0 truncate font-mono" title={title || undefined}>{item.path}</span>
        <span aria-hidden>·</span>
        <time dateTime={item.ts}>{timeAgo(item.ts)}</time>
        {item.resolved && <Badge size="sm" tone="neutral">Resolved</Badge>}
      </div>
      {item.comment ? <p className="m-0 whitespace-pre-wrap break-words text-body text-text" dir="auto">{item.comment}</p> : <Quiet>No comment.</Quiet>}
      {canResolve && (
        <div>
          <Button size="sm" variant="ghost" iconLeft={item.resolved ? "refresh" : "check"} loading={busy} onClick={() => onResolve(!item.resolved)}>
            {item.resolved ? "Reopen" : "Mark as resolved"}
          </Button>
        </div>
      )}
    </li>
  );
}

export default function InsightsScreen() {
  const { site, setSite, isAdmin } = useSite();
  const toast = useToast();
  const [params, setParams] = useParams();
  const rawRange = params.get("range");
  const range: InsightsRange = isInsightsRange(rawRange) ? rawRange : "30d";
  const [fbFilter, setFbFilter] = useState<FeedbackFilter>("open");
  const [patched, setPatched] = useState<Record<string, FeedbackItem>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState("");
  const [nonce, setNonce] = useState(0);
  const load = useLoad<Insights>(`ins:${site.id}:${range}:${fbFilter}:${nonce}`, () => getInsights(site.id, range, fbFilter));
  const data = load.data;
  const enabled = site.settings.insights?.enabled !== false;
  const rangeLong = INSIGHTS_RANGES.find((r) => r.value === range)!.long;

  const titles = useMemo(() => new Map((data?.pages ?? []).map((p) => [p.path, p.title])), [data]);
  const items = (data?.feedback.items ?? []).map((i) => patched[i.id] ?? i).filter((i) => fbFilter === "all" || i.resolved === (fbFilter === "resolved"));
  // The open count, after what was resolved or reopened here since the last load.
  const openCount = (data?.feedback.open ?? 0) + (data?.feedback.items ?? []).reduce((n, i) => {
    const now = patched[i.id];
    return !now || now.resolved === i.resolved ? n : n + (now.resolved ? -1 : 1);
  }, 0);

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
      setPatched((p) => ({ ...p, [item.id]: got }));
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

  const kpis: Kpi[] = data ? [
    { key: "views", label: "Page views", value: data.totals.views, unit: "count", prev: data.previous?.views ?? null },
    { key: "people", label: "Visitors", value: data.totals.visitors, unit: "count", prev: data.previous?.visitors ?? null, note: "Counted once a day" },
    { key: "searches", label: "Searches", value: data.totals.searches, unit: "count", prev: data.previous?.searches ?? null,
      note: data.totals.searches ? `${num(data.totals.empty_searches)} found nothing` : null },
    { key: "helpful", label: "Found it helpful", value: data.feedback.helpful_pct ?? Number.NaN, unit: "percent",
      note: data.feedback.yes + data.feedback.no ? `${num(data.feedback.yes + data.feedback.no)} votes` : "No votes yet" },
  ] : [];

  const nothingYet = data && !data.since;
  const host = siteHost(site);

  return (
    <>
      <SiteBar
        section="insights"
        actions={
          <SegmentedControl size="sm" aria-label="Date range" value={range} onChange={(r) => setParams({ range: r === "30d" ? null : r })}
            options={INSIGHTS_RANGES.map((r) => ({ value: r.value, label: r.label }))} />
        }
      />
      <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 px-4 pb-16 pt-6 outline-none sm:gap-5 sm:px-6 sm:pt-8">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="m-0 text-h3 text-text">Insights</h1>
          <span className="text-caption text-text-muted">How readers use your guide, {rangeLong}. No cookies, no personal data.</span>
          <ReadMore topic="studioInsights" className="text-caption">How it works</ReadMore>
        </div>

        {!enabled && (
          <Alert tone="warning" title="Insights is off"
            actions={isAdmin ? <Button size="sm" variant="secondary" loading={saving} onClick={() => void toggle(true)}>Turn it on</Button> : undefined}>
            Nothing new is collected, and the next publish leaves &ldquo;Did this page help?&rdquo; out of the guide.
            {isAdmin ? "" : " An admin of this guide can turn it back on."}
          </Alert>
        )}
        {enabled && data && !data.live && (
          <Alert tone="info" title="Publish your guide to start">
            Insights counts readers of the published guide. Once it&rsquo;s live, views show up here within a minute.
          </Alert>
        )}
        {enabled && data?.live && nothingYet && (
          <Alert tone="info" title="No readers yet">
            Share {host ? <span className="ph-sensitive ph-mask font-mono">{host}</span> : "your guide"} and views show up here within a minute.
            Searches, Ask AI questions and feedback follow as readers use them.
          </Alert>
        )}

        {load.error && !data ? <LoadError error={load.error} retry={load.retry} what="insights" /> : null}

        <KpiGrid loading={!data && !load.error}>{kpis.map((k) => <KpiTile key={k.key} kpi={k} range={range} big />)}</KpiGrid>

        {!data && !load.error && <PanelSkeleton height={200} />}

        {data && (
          <>
            <Panel id="ins-views" title="Views per day" aside="Bars are page views; hover a day for its visitors">
              {data.daily.some((d) => d.views > 0)
                ? <DailyViewsChart daily={data.daily.map((d) => ({ date: d.date, views: d.views, people: d.visitors }))} marks={[]} />
                : <Quiet>No page views in this period.</Quiet>}
            </Panel>

            <div className="flex flex-wrap gap-4">
              <Panel id="ins-pages" title="Top pages" className="flex-[999_1_480px]">
                {data.pages.length
                  ? <BarList className="ph-no-capture" rows={data.pages.slice(0, 12).map((p) => ({ key: p.path, label: pageLabel(p.path, p.title), value: p.views, display: num(p.views) }))} />
                  : <Quiet>The pages readers open most show here.</Quiet>}
              </Panel>
              <Panel id="ins-refs" title="Where readers come from" className="flex-[1_1_300px]">
                {data.referrers.length
                  ? <BarList className="ph-no-capture" rows={data.referrers.slice(0, 10).map((r) => ({ key: r.host, label: r.host, value: r.views, display: num(r.views) }))} />
                  : <Quiet>Sites that link to your guide show here. Visits typed in, bookmarked or from apps that hide where they came from aren&rsquo;t listed.</Quiet>}
              </Panel>
            </div>

            <div className="flex flex-wrap gap-4">
              <Panel id="ins-search" icon="search" title="Searches" aside={data.totals.searches ? `${num(data.totals.searches)} in all` : undefined} className="flex-[1_1_340px]">
                <QueryList valueWord="searches" empty="What readers type in the search box shows here (3 characters or more)."
                  rows={data.searches.top.slice(0, 10).map((r) => ({ key: r.q, label: r.q, value: r.n }))} />
              </Panel>
              <Panel id="ins-empty" icon="alert" title="Searches with no results" className="flex-[1_1_340px]">
                <QueryList valueWord="searches with no results" empty="None in this period. When a search finds nothing, it shows here: a page or a keyword worth adding."
                  rows={data.searches.empty.slice(0, 10).map((r) => ({ key: r.q, label: r.q, value: r.n }))} />
              </Panel>
            </div>

            <Panel id="ins-ask" icon="sparkle" title="Ask AI questions"
              aside={data.ask.asked ? `${num(data.ask.asked)} asked · ${num(data.ask.unanswered)} unanswered` : undefined}>
              {data.ask.asked === 0 ? (
                <Quiet>{site.settings.ai.enabled ? "Questions readers ask Ask AI show here." : "Ask AI is off for this guide. Turn it on in Settings to see what readers ask."}</Quiet>
              ) : (
                <div className="flex flex-wrap gap-6">
                  <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-2">
                    <h3 className="m-0 text-caption font-semibold text-text-secondary">Most asked</h3>
                    <QueryList valueWord="times asked" empty="Nothing yet." rows={data.ask.top.slice(0, 10).map((q) => ({ key: q.q, label: q.q, value: q.n }))} />
                  </div>
                  <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-2">
                    <h3 className="m-0 text-caption font-semibold text-text-secondary">Couldn&rsquo;t answer from your docs</h3>
                    <QueryList valueWord="times unanswered" empty="Ask AI answered everything it was asked."
                      rows={data.ask.unanswered_top.slice(0, 10).map((q) => ({ key: q.q, label: q.q, value: q.unanswered }))} />
                  </div>
                </div>
              )}
            </Panel>

            <Panel id="ins-feedback" icon="message" title="Feedback"
              aside={data.feedback.yes + data.feedback.no ? `${data.feedback.helpful_pct}% helpful · ${num(data.feedback.yes + data.feedback.no)} votes` : undefined}
              headerExtra={
                <SegmentedControl size="sm" aria-label="Show feedback" value={fbFilter} onChange={(v) => { setPatched({}); setFbFilter(v); }}
                  options={[{ value: "open", label: `Open${openCount ? ` (${num(openCount)})` : ""}` }, { value: "resolved", label: "Resolved" }, { value: "all", label: "All" }]} />
              }>
              {data.feedback.pages.some((p) => p.no > 0) && (
                <div className="flex flex-col gap-1.5">
                  <h3 className="m-0 text-caption font-semibold text-text-secondary">Pages readers found least helpful</h3>
                  <ul className="ph-no-capture m-0 flex list-none flex-wrap gap-2 p-0">
                    {data.feedback.pages.filter((p) => p.no > 0).slice(0, 6).map((p) => (
                      <li key={p.path} className="rounded-md border border-border px-2 py-1 text-caption text-text-secondary">
                        <span className="text-text">{titles.get(p.path) || p.path}</span> · {num(p.no)} not helpful, {num(p.yes)} helpful
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {items.length ? (
                <ul className="ph-no-capture m-0 flex list-none flex-col divide-y divide-border p-0">
                  {items.map((i) => (
                    <FeedbackRow key={i.id} item={i} title={titles.get(i.path)} canResolve={data.can_resolve} busy={busyId === i.id} onResolve={(r) => void resolve(i, r)} />
                  ))}
                </ul>
              ) : (
                <Quiet>
                  {fbFilter === "resolved" ? "Nothing resolved in this period." :
                    data.feedback.yes + data.feedback.no ? "No open comments. Comments and “not helpful” votes land here to work through." :
                      "Readers answer “Did this page help?” at the end of each page. Their votes and comments show here."}
                </Quiet>
              )}
            </Panel>

            <div className="flex flex-wrap gap-4">
              <Panel id="ins-countries" title="Countries" className="flex-[1_1_300px]">
                {data.countries.length
                  ? <BarList rows={data.countries.slice(0, 8).map((c) => ({ key: c.country, label: countryName(c.country), value: c.views, display: num(c.views) }))} />
                  : <Quiet>Where readers are, by country, shows here.</Quiet>}
              </Panel>
              <Panel id="ins-devices" title="Devices" className="flex-[1_1_300px]">
                {data.devices.length
                  ? <BarList labelWidth={80} rows={data.devices.map((d) => ({ key: d.device, label: DEVICE_WORD[d.device] ?? d.device, value: d.views, display: num(d.views) }))} />
                  : <Quiet>Computer, phone or tablet shows here.</Quiet>}
              </Panel>
            </div>
          </>
        )}

        <section aria-labelledby="ins-privacy" className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 id="ins-privacy" className="m-0 flex flex-1 items-center gap-2 text-[16px] font-semibold text-text">
              <Icon name="shield" size={18} className="text-text-secondary" />Collection
            </h2>
            <Switch label={enabled ? "On" : "Off"} checked={enabled} disabled={!isAdmin || saving} onChange={(e) => void toggle(e.target.checked)} />
          </div>
          <p className="m-0 text-body text-text-secondary">
            No cookies and nothing stored in readers&rsquo; browsers. Kept: the page, the site a reader came from (not the address), the
            country, the kind of device, searches, Ask AI questions and feedback. A visitor is counted with a code that changes every day,
            so nobody can be followed from one day to the next. Readers with Do Not Track or Global Privacy Control on are counted, never
            identified. Raw events are kept 90 days, daily totals and feedback 13 months.
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
