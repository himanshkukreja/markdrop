"use client";

/**
 * Content tab (Content board, markdown documents): reading KPIs, how far people read section by
 * section (with Most copied / Most time / Readers leave here flags), Most copied code and the links
 * people click. Section titles come from the document's own markdown (heading ids → text); copied
 * blocks are matched by hashing each fenced block (FNV-1a 32) — the reader's copy is never stored.
 */
import { useMemo } from "react";
import { Badge, EmptyState, cx } from "@/components/ui";
import { blockPreview, getContent, type AnalyticsRange, type Overview } from "@/lib/analytics";
import type { Heading } from "@/components/reading/slug";
import { clock, num, pct, secs } from "./format";
import { TrackingNote } from "./OverviewTab";
import { KpiGrid, LoadError, Panel, PanelSkeleton, Quiet, StatBox, useLoad } from "./parts";

export default function ContentTab({ slug, ov, range, internal, headings, blocks, titleFor }: {
  slug: string;
  ov: Overview;
  range: AnalyticsRange;
  internal: boolean;
  headings: Heading[];
  blocks: string[];
  titleFor: (id: string) => string;
}) {
  const content = useLoad(ov.has_engagement ? `content:${slug}:${range}:${internal}` : null, () => getContent(slug, { range, internal }));
  const c = content.data;

  const rows = useMemo(() => {
    if (!c) return [];
    const order = new Map(headings.map((h, i) => [h.id, i]));
    const depth = new Map(headings.map((h) => [h.id, h.depth]));
    const ordered = [...c.sections].sort((a, b) => (order.get(a.id) ?? 1e6) - (order.get(b.id) ?? 1e6));
    const copiedBy = new Map<string, number>();
    for (const x of c.copies) copiedBy.set(x.section, (copiedBy.get(x.section) ?? 0) + x.n);
    const mostCopied = [...copiedBy.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const mostTime = ordered.length > 1 ? ordered.reduce((b, s) => (s.median_s > b.median_s ? s : b), ordered[0]!).id : null;
    let leave: string | null = null, worst = 9.99;
    for (let i = 1; i < ordered.length; i++) {
      const d = ordered[i - 1]!.reached_pct - ordered[i]!.reached_pct;
      if (d > worst) { worst = d; leave = ordered[i]!.id; }
    }
    const minDepth = Math.min(...ordered.map((s) => depth.get(s.id) ?? 2));
    return ordered.map((s) => {
      const flags: { text: string; tone: "info" | "warning" }[] = [];
      if (s.id === mostCopied) flags.push({ text: "Most copied", tone: "info" });
      if (s.id === mostTime) flags.push({ text: "Most time", tone: "info" });
      if (s.id === leave) flags.push({ text: "Readers leave here", tone: "warning" });
      const d = depth.get(s.id) ?? minDepth;
      return { ...s, title: titleFor(s.id), sub: d > minDepth, flags };
    });
  }, [c, headings, titleFor]);

  if (!ov.has_engagement) {
    return (
      <div className="flex flex-col gap-4">
        <TrackingNote since={ov.tracking_since} />
        <EmptyState icon="lines" title="No reading data yet" description="Section reach, copied code and clicked links appear here once people read it." />
      </div>
    );
  }
  if (content.error) return <LoadError error={content.error} retry={content.retry} />;
  if (!c) {
    return (
      <div className="flex flex-col gap-4">
        <KpiGrid loading count={4} />
        <PanelSkeleton height={260} />
      </div>
    );
  }

  const people = ov.kpis.find((k) => k.key === "people");
  const cc = ov.kpis.find((k) => k.key === "copies_clicks");
  const copiesN = c.copies.reduce((a, x) => a + x.n, 0);
  const linksN = c.links.reduce((a, x) => a + x.n, 0);

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <KpiGrid>
        <StatBox label="Readers" value={num(c.sessions)} note={people?.note ?? "reading sessions"} />
        <StatBox label="Read it all" value={pct(c.read_all_pct)} note="reached the last section" />
        <StatBox label="Time spent reading" value={secs(c.median_active_s)} note="typical reader, active time only" />
        <StatBox label="Copies and clicks" value={num(cc?.value ?? copiesN + linksN)} note={cc?.note ?? `code copied ${num(copiesN)} · links ${num(linksN)}`} />
      </KpiGrid>

      <div className="flex flex-wrap items-start gap-4">
        <Panel id="ct-sections" title="How far people read, section by section" aside="reached · time spent there" className="flex-[999_1_520px]">
          {rows.length ? (
            <ul className="m-0 flex list-none flex-col p-0" aria-label="Sections: share of readers who reached each, and typical time there">
              {rows.map((s) => (
                <li key={s.id} className="grid grid-cols-[minmax(0,1fr)_96px_44px] items-center gap-2 border-t border-border py-2 sm:grid-cols-[minmax(0,1fr)_160px_64px] sm:gap-3">
                  <div className={cx("min-w-0", s.sub && "pl-4")}>
                    <span className={cx("break-words text-text", s.sub ? "font-normal" : "font-semibold")} dir="auto">{s.title}</span>
                    {s.flags.map((f) => <Badge key={f.text} tone={f.tone} size="sm" className="ml-1.5 align-middle">{f.text}</Badge>)}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-2 flex-1 rounded-full bg-(--chart-track)" aria-hidden>
                      <span className="block h-2 rounded-full bg-(--chart-1)" style={{ width: `${Math.max(0, Math.min(100, s.reached_pct))}%` }} />
                    </span>
                    <span className="w-9 text-right text-caption font-semibold text-text tabular-nums">
                      {pct(s.reached_pct)}<span className="md-visually-hidden"> reached</span>
                    </span>
                  </div>
                  <span className="text-right text-caption text-text-secondary tabular-nums">
                    {clock(s.median_s)}<span className="md-visually-hidden"> typical time</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : <Quiet>No sections yet. Documents with headings show reach for each one.</Quiet>}
        </Panel>

        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          <Panel id="ct-copied" title="Most copied">
            {c.copies.length ? (
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {c.copies.slice(0, 5).map((x) => {
                  const where = x.section ? titleFor(x.section) : null;
                  const preview = blockPreview(blocks, x.hash) ?? `Code block in ${where ?? "this document"}`;
                  return (
                    <li key={`${x.hash}|${x.section}`} className="flex min-w-0 flex-col gap-1">
                      <code className="block truncate rounded-md border border-(--code-border) bg-(--code-bg) px-2 py-1.5 font-mono text-caption text-text" title={preview}>{preview}</code>
                      <span className="text-caption text-text-muted">{where ? `${where} · ` : ""}copied {num(x.n)} {x.n === 1 ? "time" : "times"}</span>
                    </li>
                  );
                })}
              </ul>
            ) : <Quiet>Nothing copied yet.</Quiet>}
            <p className="m-0 text-micro text-text-muted">We count which of your blocks get copied. What readers copy is never stored.</p>
          </Panel>

          <Panel id="ct-links" title="Links people click">
            {c.links.length ? (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {c.links.slice(0, 8).map((l) => (
                  <li key={`${l.href}|${l.section}`} className="flex items-center gap-2.5 text-[13px]">
                    <span className="min-w-0 flex-1 truncate font-mono text-caption text-text" title={l.href}>{l.href}</span>
                    {l.section && <span className="hidden max-w-[40%] truncate text-caption text-text-muted sm:inline">{titleFor(l.section)}</span>}
                    <strong className="w-9 shrink-0 text-right font-semibold tabular-nums text-text">{num(l.n)}</strong>
                  </li>
                ))}
              </ul>
            ) : <Quiet>No link clicks yet.</Quiet>}
            {c.prints > 0 && <Quiet>Printed {num(c.prints)} {c.prints === 1 ? "time" : "times"}.</Quiet>}
          </Panel>
        </div>
      </div>
    </div>
  );
}
