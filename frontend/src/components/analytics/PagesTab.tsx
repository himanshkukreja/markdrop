"use client";

/** Pages tab (Pages board, PDFs): reach per page with the biggest drop, time per page with the peak, and every page. */
import { EmptyState } from "@/components/ui";
import { getPages, type AnalyticsRange, type Overview } from "@/lib/analytics";
import { PageBars } from "./charts";
import { RANGE_WORDS, num, pagesLabel, pct, secs } from "./format";
import { TrackingNote } from "./OverviewTab";
import { LoadError, Panel, PanelSkeleton, Quiet, useLoad } from "./parts";

export default function PagesTab({ slug, ov, range, internal }: { slug: string; ov: Overview; range: AnalyticsRange; internal: boolean }) {
  const pages = useLoad(ov.has_engagement ? `pages:${slug}:${range}:${internal}` : null, () => getPages(slug, { range, internal }));

  if (!ov.has_engagement) {
    return (
      <div className="flex flex-col gap-4">
        <TrackingNote since={ov.tracking_since} />
        <EmptyState icon="doc" title="No page data yet" description="Page reach and time per page appear here once people read it." />
      </div>
    );
  }
  if (pages.error) return <LoadError error={pages.error} retry={pages.retry} />;
  const p = pages.data;
  if (!p) return <div className="flex flex-wrap gap-4"><PanelSkeleton className="flex-[1_1_420px]" /><PanelSkeleton className="flex-[1_1_420px]" /></div>;
  if (!p.sessions) return <EmptyState icon="doc" title="Nobody read it in this period" description="Try a longer date range." />;

  const reach = p.reach.map((r) => ({ page: r.page, v: r.pct }));
  const time = p.time.map((r) => ({ page: r.page, v: r.median_s }));
  const back = new Map(p.back.map((b) => [b.page, b.pct]));
  const timeBy = new Map(p.time.map((t) => [t.page, t.median_s]));
  const drop = p.biggest_drop ?? null;
  const dropIdx = drop ? reach.findIndex((r) => r.page === drop.after_page + 1) : -1;
  const peakIdx = time.length ? time.reduce((b, t, i) => (t.v > time[b]!.v ? i : b), 0) : -1;
  const peak = peakIdx >= 0 ? time[peakIdx]! : null;
  const whole = ov.kpis.find((k) => k.key === "read_time");
  const last = reach[reach.length - 1];

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <Quiet>{pagesLabel(p.npages)} · {num(p.sessions)} {p.sessions === 1 ? "reader" : "readers"} · {RANGE_WORDS[range]}</Quiet>
      <div className="flex flex-wrap gap-4">
        <Panel id="pg-reach" title="Viewers who reached each page" className="flex-[1_1_420px]">
          <PageBars
            values={reach} highlight={dropIdx >= 0 ? dropIdx : null} highlightLabel={drop ? `−${Math.round(drop.pct)}%` : undefined}
            format={(v) => `${pct(v)} reached it`} caption="Viewers who reached each page" valueHead="Reached"
            label={`Page reach falls from ${pct(reach[0]?.v ?? 0)} on page 1 to ${pct(last?.v ?? 0)} on page ${last?.page ?? 1}${drop ? `, with the steepest drop after page ${drop.after_page}` : ""}.`}
          />
          {drop
            ? <p className="m-0 text-[13px] text-text-secondary">The biggest drop is after <strong className="text-text">page {drop.after_page}</strong>. {pct(drop.pct)} of the people still reading stop there.</p>
            : <Quiet>No single page loses many readers.</Quiet>}
        </Panel>
        <Panel id="pg-time" title="Time spent on each page" className="flex-[1_1_420px]">
          <PageBars
            values={time} highlight={peakIdx >= 0 ? peakIdx : null} highlightLabel={peak ? secs(peak.v) : undefined}
            format={(v) => `${secs(v)} typical`} caption="Typical time on each page" valueHead="Typical time"
            label={peak ? `Typical time per page; page ${peak.page} holds attention longest at ${secs(peak.v)}.` : "Typical time per page."}
          />
          {peak && (
            <p className="m-0 text-[13px] text-text-secondary">
              <strong className="text-text">Page {peak.page}</strong> holds attention longest.
              {whole && whole.value > 0 ? ` Typical readers spend ${secs(whole.value)} on the whole document.` : ""}
            </p>
          )}
        </Panel>
      </div>

      <Panel id="pg-all" title="Every page">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-[13px]">
            <caption className="md-visually-hidden">Every page: reach, typical time and how often people came back to it</caption>
            <thead>
              <tr className="text-left text-eyebrow tracking-[0.08em] text-text-muted uppercase">
                <th scope="col" className="px-2 py-1.5 font-bold">Page</th>
                <th scope="col" className="px-2 py-1.5 font-bold">Reached</th>
                <th scope="col" className="px-2 py-1.5 font-bold">Typical time</th>
                <th scope="col" className="px-2 py-1.5 font-bold">Came back to it</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {reach.map((r, i) => (
                <tr key={r.page} className="border-t border-border">
                  <th scope="row" className="px-2 py-2 text-left font-normal text-text">
                    {r.page}{i === dropIdx ? <span className="text-text-muted"> · biggest drop</span> : i === peakIdx ? <span className="text-text-muted"> · most time</span> : null}
                  </th>
                  <td className="px-2 py-2 text-text">{pct(r.v)}</td>
                  <td className="px-2 py-2 text-text">{timeBy.has(r.page) ? secs(timeBy.get(r.page)!) : "—"}</td>
                  <td className="px-2 py-2 text-text">{back.has(r.page) ? pct(back.get(r.page)!) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
