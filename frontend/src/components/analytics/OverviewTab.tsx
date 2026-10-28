"use client";

/** Overview tab (Main board): KPIs, What stands out, Views per day, Where views come from. */
import { useMemo } from "react";
import { Alert } from "@/components/ui";
import { usePhone } from "@/components/dashboard/hooks";
import { RANGES, getMedia, type AnalyticsRange, type Insight, type Overview } from "@/lib/analytics";
import { BarList, DailyViewsChart, RetentionChart, fillDays } from "./charts";
import { channelLabel, clock, day, num } from "./format";
import { FrameThumb, InsightList, KpiGrid, KpiTile, Panel, Quiet, useLoad } from "./parts";

/** The KPIs that are only views (still true before engagement tracking existed). */
const VIEW_KPIS = new Set(["views", "people"]);

export function TrackingNote({ since }: { since: string | null }) {
  return (
    <Alert tone="info" title={`Watch and reading data starts from ${since ? day(since) : "now"}`}>
      Views are counted as before. How far people read or watch shows up here from then on.
    </Alert>
  );
}

export default function OverviewTab({ slug, ov, range, internal, onInsight, rewrite }: {
  slug: string;
  ov: Overview;
  range: AnalyticsRange;
  internal: boolean;
  onInsight: (i: Insight) => void;
  rewrite: (s: string) => string;
}) {
  const phone = usePhone();
  const kind = ov.doc.kind;
  const isMedia = kind === "video" || kind === "audio";
  const kpis = ov.has_engagement ? ov.kpis : ov.kpis.filter((k) => VIEW_KPIS.has(k.key));
  const daily = useMemo(() => fillDays(ov.daily, range, (date) => ({ date, views: 0, people: 0 })), [ov.daily, range]);
  const rangeLong = RANGES.find((r) => r.value === range)!.long;
  const sources = ov.sources.filter((s) => s.views > 0).slice(0, 8);
  // Phones get the "Still watching" card of the Mobile board.
  const mini = useLoad(phone && isMedia && ov.has_engagement ? `ovm:${slug}:${range}:${internal}` : null, () => getMedia(slug, { range, internal }));
  const drop = mini.data?.moments.find((m) => m.kind === "drop");
  const noun = kind === "audio" ? "listening" : "watching";

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      {!ov.has_engagement && <TrackingNote since={ov.tracking_since} />}

      <KpiGrid>{kpis.map((k) => <KpiTile key={k.key} kpi={k} range={range} big />)}</KpiGrid>

      {phone && mini.data && mini.data.retention.length > 1 && (
        <Panel id="ov-still" title={kind === "audio" ? "Still listening" : "Still watching"}>
          <RetentionChart compact height={120} points={mini.data.retention} dur={mini.data.dur} noun={noun}
            marks={drop ? [{ t: drop.t, label: drop.title }] : []} />
          {drop && <p className="m-0 text-[13px] text-text-secondary">Biggest drop at <strong className="text-text">{clock(drop.t)}</strong>. {drop.body}</p>}
        </Panel>
      )}

      {ov.insights.length > 0 && (
        <Panel id="ov-insights" icon="bulb" title={phone ? "Worth a look" : "What stands out"}>
          <InsightList
            insights={ov.insights.slice(0, 4)}
            onCta={onInsight}
            rewrite={rewrite}
            frameFor={kind === "video" ? (t) => (
              <FrameThumb slug={slug} t={t} width={88} height={50} alt={`Frame at ${clock(t)}`} fallback={clock(t)} />
            ) : undefined}
          />
        </Panel>
      )}

      <div className="flex flex-wrap gap-4">
        <Panel id="ov-views" title="Views per day" aside={`${rangeLong[0]!.toUpperCase()}${rangeLong.slice(1)} · your own views excluded`} className="flex-[999_1_520px]">
          {daily.some((d) => d.views > 0)
            ? <DailyViewsChart daily={daily} marks={ov.versions_marks} />
            : <Quiet>No views in this period.</Quiet>}
        </Panel>
        <Panel id="ov-sources" title="Where views come from" className="flex-[1_1_280px]">
          {sources.length
            ? <BarList rows={sources.map((s) => ({ key: s.channel, label: channelLabel(s.channel), value: s.views, display: num(s.views) }))} />
            : <Quiet>No views in this period.</Quiet>}
        </Panel>
      </div>
    </div>
  );
}
