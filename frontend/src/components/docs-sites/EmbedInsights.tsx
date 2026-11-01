"use client";

/**
 * Insights › Embedded files: every Markdrop file block of the guide (page + block), over the range:
 * views, how many readers used it, full screen / opened on Markdrop; for a video plays, how far
 * viewers got and where most of them stop; for a PDF the page readers typically reach. From the
 * blocks' own Insights events (services/docs_embeds.py stats; the Fix list ranks the same data).
 */
import { Badge, FileIcon, Icon } from "@/components/ui";
import { Quiet, useLoad } from "@/components/analytics/parts";
import { embedStats, type EmbedBlockStats } from "@/lib/docsEmbeds";
import { num } from "./format";

const KIND: Record<string, string> = { html: "Interactive page", bundle: "Website", pdf: "PDF", video: "Video", doc: "Document" };

function clock(s: number): string {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

function pct(x: number | null | undefined): string {
  return x == null ? "—" : `${Math.round(x * 100)}%`;
}

/** The one-line finding for a block (what the Fix list would say about it). */
export function blockFinding(b: EmbedBlockStats): string | null {
  if (b.drop_off && b.drop_off.of >= 3 && b.drop_off.stopped / b.drop_off.of >= 0.3)
    return `${b.drop_off.stopped} of ${b.drop_off.of} viewers stop around ${clock(b.drop_off.at)}`;
  if (b.pdf?.median_page && b.pdf.pages && b.pdf.readers >= 3 && b.pdf.median_page < b.pdf.pages * 0.6)
    return `Most readers stop at page ${Math.round(b.pdf.median_page)} of ${b.pdf.pages}`;
  if ((b.renderer === "html" || b.renderer === "bundle") && b.views >= 10 && (b.interaction_rate ?? 0) < 0.1)
    return "Few readers try it: say what to do with it in the text around it";
  return null;
}

function Row({ b }: { b: EmbedBlockStats }) {
  const finding = blockFinding(b);
  const renderer = b.renderer === "bundle" ? "zip" : b.renderer;
  const facts: string[] = [`${num(b.views)} ${b.views === 1 ? "view" : "views"}`];
  if (b.renderer === "video") {
    facts.push(`${num(b.plays)} ${b.plays === 1 ? "play" : "plays"}`);
    if (b.watched_share != null) facts.push(`${pct(b.watched_share)} watched (median)`);
  } else if (b.renderer === "pdf" && b.pdf?.median_page) {
    facts.push(`page ${Math.round(b.pdf.median_page)}${b.pdf.pages ? ` of ${b.pdf.pages}` : ""} reached (median)`);
  } else if (b.interaction_rate != null) {
    facts.push(`${pct(b.interaction_rate)} used it`);
  }
  if (b.fullscreen) facts.push(`${num(b.fullscreen)} full screen`);
  if (b.opens) facts.push(`${num(b.opens)} opened on Markdrop`);
  return (
    <li className="flex items-start gap-3 rounded-lg px-2.5 py-2.5 hover:bg-surface-hover">
      <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-inset" aria-hidden>
        <FileIcon renderer={(renderer && ["pdf", "video", "html", "zip"].includes(renderer) ? renderer : null) as never} size={18} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-body font-semibold text-text">{b.title ?? "A file that isn't public any more"}</span>
          {!b.public && <Badge size="sm" tone="warning" icon="lock">Not public</Badge>}
        </span>
        <span className="truncate text-caption text-text-muted">
          {KIND[b.renderer ?? ""] ?? "File"} on <span className="font-mono">{b.page}</span>{b.embed !== b.slug ? ` (block ${b.embed.split("~")[1] ?? ""})` : ""}
        </span>
        <span className="text-caption tabular-nums text-text-secondary">{facts.join(" · ")}</span>
        {b.renderer === "video" && b.plays > 0 && (
          <span className="mt-1 flex items-center gap-1.5" aria-label={`Reached: 25% ${b.quartiles["25"]}, 50% ${b.quartiles["50"]}, 75% ${b.quartiles["75"]}, end ${b.quartiles["100"]}`}>
            {(["25", "50", "75", "100"] as const).map((q) => (
              <span key={q} className="flex flex-col items-center gap-0.5" aria-hidden>
                <span className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-inset">
                  <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.round((b.quartiles[q] / Math.max(1, b.plays)) * 100))}%` }} />
                </span>
                <span className="text-micro text-text-muted">{q === "100" ? "End" : `${q}%`}</span>
              </span>
            ))}
          </span>
        )}
        {finding && (
          <span className="mt-1 inline-flex items-center gap-1.5 text-caption font-medium text-warning">
            <Icon name="alertCircle" size={14} />{finding}
          </span>
        )}
      </span>
    </li>
  );
}

export function EmbedInsights({ siteId, range, rangeWords, uid }: { siteId: string; range: string; rangeWords: string; uid: string }) {
  const load = useLoad(`embeds:${siteId}:${range}`, () => embedStats(siteId, range));
  const data = load.data;
  if (load.error || !data) return null;
  if (!data.embeds.length) return null;
  const t = data.totals;
  return (
    <section aria-labelledby={`${uid}-emb`} className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id={`${uid}-emb`} className="m-0 flex-1 text-[16px] font-semibold leading-6 text-text">Embedded files</h2>
        <span className="text-caption tabular-nums text-text-muted">
          {num(t.views)} views · {num(t.plays)} plays{t.watch_s ? ` · ${num(Math.round(t.watch_s / 60))} min watched` : ""}
        </span>
      </div>
      <ol className="ph-no-capture m-0 flex list-none flex-col gap-0.5 p-0">
        {data.embeds.slice(0, 12).map((b) => <Row key={`${b.page}|${b.embed}`} b={b} />)}
      </ol>
      {data.embeds.length > 12 && <Quiet>And {data.embeds.length - 12} more blocks in the last {rangeWords}.</Quiet>}
    </section>
  );
}
