"use client";

/**
 * /dashboard/analytics (Home board): everything you've published — KPIs, Your links (views,
 * sparkline, engagement, last view, live dot), Worth a look (top insights across documents) and
 * the "Ask your AI assistant" MCP callout.
 */
import { useEffect, useState } from "react";
import { Anchor, Badge, Button, EmptyState, FileIcon, Icon, useToast } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { relativeTime } from "@/components/dashboard/format";
import { RANGES, downloadHomeCsv, getHome, isRange, type AnalyticsRange, type HomeLink, type Insight } from "@/lib/analytics";
import { Sparkline, trendWords } from "./charts";
import { docHref, num, prettyHeadingId } from "./format";
import { KpiGrid, KpiTile, LoadError, Panel, PanelSkeleton, Quiet, RangePicker, useAnalyticsGate, useLoad, useParams } from "./parts";


function LinkIcon({ l }: { l: HomeLink }) {
  if (l.kind === "doc") return <Icon name="lines" size={18} className="shrink-0 text-cat-document" />;
  return <FileIcon name={l.title || l.slug} renderer={(l.renderer as never) || null} mime={l.kind === "pdf" ? "application/pdf" : l.kind === "video" ? "video/mp4" : l.kind === "audio" ? "audio/mpeg" : ""} size={18} className="shrink-0" />;
}

/** Insight text may name a section by its heading id; show words instead. */
const words = (s: string) => s.replace(/#?user-content-[^\s,;:!?"')]+/g, (id) => prettyHeadingId(id.replace(/^#/, "").replace(/[.]+$/, "")));

function insightHref(i: Insight) {
  return i.slug ? docHref(i.slug, i.cta?.tab ?? null) : null;
}

export default function AnalyticsHome() {
  const { ready } = useAnalyticsGate();
  const [params, setParams] = useParams();
  const toast = useToast();
  const range: AnalyticsRange = isRange(params.get("range")) ? (params.get("range") as AnalyticsRange) : "30d";
  const internal = params.get("internal") === "1";
  const res = useLoad(ready ? `home:${range}:${internal}` : null, () => getHome({ range, internal }));
  const [csvBusy, setCsvBusy] = useState(false);
  const h = res.data;
  const rangeLong = RANGES.find((r) => r.value === range)!.long;

  useEffect(() => { document.title = "Analytics · Markdrop"; }, []);

  async function csv() {
    setCsvBusy(true);
    try { await downloadHomeCsv(range); } catch { toast.error("Couldn't download the CSV. Try again."); } finally { setCsvBusy(false); }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4 sm:gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-[1_1_300px]">
          <h1 className="m-0 text-h2 text-text sm:text-h1">Analytics</h1>
          <p className="mt-0.5 mb-0 text-[13px] text-text-muted">Everything you&apos;ve published, {rangeLong}. Your own views aren&apos;t counted. <ReadMore topic="whatGetsCounted">What counts</ReadMore></p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {h && h.live.people > 0 ? (
            <Anchor href="/dashboard/live" className="md-focus rounded-full no-underline" aria-label={`${num(h.live.people)} ${h.live.people === 1 ? "person" : "people"} live now. Open live view`}>
              <Badge tone="success" live>{num(h.live.people)} {h.live.people === 1 ? "person" : "people"} live</Badge>
            </Anchor>
          ) : h ? (
            <Button variant="ghost" size="sm" iconLeft="wave" href="/dashboard/live">Live</Button>
          ) : null}
          <RangePicker value={range} onChange={(r) => setParams({ range: r === "30d" ? null : r })} />
          <Button variant="secondary" size="sm" iconLeft="download" loading={csvBusy} onClick={csv}>CSV</Button>
        </div>
      </div>

      {res.error && !h ? <LoadError error={res.error} retry={res.retry} /> : !h ? (
        <>
          <KpiGrid loading count={4} />
          <div className="flex flex-wrap gap-4"><PanelSkeleton height={260} className="flex-[999_1_560px]" /><PanelSkeleton height={160} className="flex-[1_1_280px]" /></div>
        </>
      ) : (
        <>
          <KpiGrid>{h.kpis.map((k) => <KpiTile key={k.key} kpi={k} range={range} />)}</KpiGrid>

          <div className="flex flex-wrap items-start gap-4">
            <Panel id="ah-links" title="Your links" className="flex-[999_1_560px]">
              {h.links.length ? (
                <div className="-mx-1 overflow-x-auto px-1">
                  <table className="w-full min-w-[620px] border-collapse text-[13px]">
                    <caption className="md-visually-hidden">Your links with views in the {rangeLong}</caption>
                    <thead>
                      <tr className="text-left text-eyebrow tracking-[0.08em] text-text-muted uppercase">
                        <th scope="col" className="px-2 py-1.5 font-bold">Link</th>
                        <th scope="col" className="px-2 py-1.5 font-bold">Views</th>
                        <th scope="col" className="px-2 py-1.5 font-bold">Trend</th>
                        <th scope="col" className="px-2 py-1.5 font-bold">Engagement</th>
                        <th scope="col" className="px-2 py-1.5 font-bold">Last view</th>
                      </tr>
                    </thead>
                    <tbody>
                      {h.links.map((l) => {
                        const t = l.title || l.slug;
                        return (
                          <tr key={l.slug} className="border-t border-border">
                            <th scope="row" className="max-w-[320px] px-2 py-2.5 text-left font-normal">
                              <Anchor href={docHref(l.slug)} className="md-focus flex min-w-0 items-center gap-2.5 rounded-sm text-text no-underline hover:text-accent-text">
                                <LinkIcon l={l} />
                                <span className="truncate font-semibold" dir="auto">{t}</span>
                                {l.live && <span aria-label="Live now" role="img" className="size-2 shrink-0 rounded-full bg-success-fill" />}
                              </Anchor>
                            </th>
                            <td className="px-2 py-2.5 font-semibold text-text tabular-nums">{num(l.views)}</td>
                            <td className="px-2 py-2.5"><Sparkline values={l.spark} label={`${t}: ${trendWords(l.spark)} over the last ${l.spark.length} days`} /></td>
                            <td className="px-2 py-2.5 text-text-secondary">{l.engage_label ?? "—"}</td>
                            <td className="px-2 py-2.5 whitespace-nowrap text-text-muted">{l.last_view ? relativeTime(l.last_view) : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState icon="chart" title="No views in this period" description="Share a link, then come back to see who opened it." actions={<Button variant="secondary" href="/dashboard">Your files</Button>} />
              )}
            </Panel>

            <aside className="flex min-w-0 flex-[1_1_280px] flex-col gap-4" aria-label="Insights">
              <Panel id="ah-feed" icon="bulb" title="Worth a look">
                {h.insights.length ? (
                  <ul className="m-0 flex list-none flex-col p-0">
                    {h.insights.slice(0, 4).map((i) => {
                      const href = insightHref(i);
                      const body = (
                        <>
                          <div className="text-[13px] leading-5 font-semibold text-text">{words(i.title)}</div>
                          <div className="text-caption text-text-muted">{words(i.body)}</div>
                        </>
                      );
                      return (
                        <li key={`${i.slug}-${i.key}`} className="border-t border-border pt-2.5 pb-1 first:border-t-0 first:pt-0">
                          {href ? <Anchor href={href} className="md-focus block rounded-sm no-underline hover:[&>div:first-child]:text-accent-text">{body}</Anchor> : body}
                        </li>
                      );
                    })}
                  </ul>
                ) : <Quiet>Nothing stands out yet. Insights appear once your links have about 20 visits.</Quiet>}
              </Panel>
              <section className="flex flex-col gap-1.5 rounded-xl bg-accent-soft px-4 py-4">
                <strong className="flex items-center gap-2 font-semibold text-text"><Icon name="zap" size={18} />Ask your AI assistant</strong>
                <span className="text-[13px] text-text-secondary">
                  Connected to Markdrop over MCP, it can read these numbers: &ldquo;Where do readers drop off in my getting-started guide? Rewrite that section.&rdquo;
                </span>
                <Anchor href="/mcp" className="inline-flex items-center gap-1 self-start text-[13px]">Connect an assistant<Icon name="arrowRight" size={14} /></Anchor>
              </section>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
