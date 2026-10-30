"use client";

/**
 * One document's analytics (/dashboard/analytics/<slug>): header (back, title, kind · length ·
 * address · version, live badge, date range, CSV), then tabs by kind (build spec §"Tabs per kind")
 * kept in ?tab=. Range and the workspace-members switch live in ?range= and ?internal=1.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Anchor, Badge, Button, FileIcon, Icon, IconButton, Skeleton, Tabs, cx, useToast, type TabItem } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import type { DocsTopic } from "@/lib/docsLinks";
import { usePhone } from "@/components/dashboard/hooks";
import { extractHeadings, type Heading } from "@/components/reading/slug";
import {
  downloadDocCsv, fencedBlocks, getDocMarkdown, getOverview, isRange,
  type AnalyticsDoc, type AnalyticsRange, type Insight, type TrackKind,
} from "@/lib/analytics";
import AudienceTab from "./AudienceTab";
import ContentTab from "./ContentTab";
import MediaTab from "./MediaTab";
import OverviewTab from "./OverviewTab";
import PagesTab from "./PagesTab";
import VersionsTab from "./VersionsTab";
import { KIND_WORD, clock, day, num, pagesLabel, prettyHeadingId } from "./format";
import { KpiGrid, LoadError, PanelSkeleton, RangePicker, useAnalyticsGate, useLoad, useParams } from "./parts";

type Tab = "overview" | "video" | "listening" | "content" | "pages" | "audience" | "versions";

export function tabsFor(kind: TrackKind, fileVersion: number): TabItem[] {
  const v: TabItem[] = fileVersion > 1 ? [{ value: "versions", label: "Versions", count: fileVersion }] : [];
  const o: TabItem = { value: "overview", label: "Overview" };
  const a: TabItem = { value: "audience", label: "Audience" };
  switch (kind) {
    case "doc": return [o, { value: "content", label: "Content" }, a];
    case "pdf": return [o, { value: "pages", label: "Pages" }, a, ...v];
    case "video": return [o, { value: "video", label: "Video" }, a, ...v];
    case "audio": return [o, { value: "listening", label: "Listening" }, a, ...v];
    default: return [o, a, ...v];
  }
}

const LIVE_WORD: Record<TrackKind, string> = { video: "watching now", audio: "listening now", doc: "reading now", pdf: "reading now", other: "viewing now" };

function KindTile({ doc }: { doc: AnalyticsDoc }) {
  const name = doc.title || doc.slug;
  return (
    <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-accent-soft">
      {doc.kind === "doc"
        ? <Icon name="lines" size={22} className="text-cat-document" />
        : <FileIcon name={name} mime={doc.mime || ""} renderer={(doc.renderer as never) || null} size={22} />}
    </span>
  );
}

/** The docs page that explains this kind's numbers. */
const readMoreFor = (kind: string): DocsTopic =>
  kind === "video" || kind === "audio" ? "videoAnalytics" : kind === "doc" || kind === "pdf" ? "documentAnalytics" : "analytics";

function metaLine(ov: { doc: AnalyticsDoc; versions_marks: { date: string; version: number }[] }) {
  const d = ov.doc;
  const parts: React.ReactNode[] = [KIND_WORD[d.kind]];
  if ((d.kind === "video" || d.kind === "audio") && d.duration_s) parts.push(clock(d.duration_s));
  if (d.kind === "pdf" && d.npages) parts.push(pagesLabel(d.npages));
  parts.push(<code key="a" className="font-mono text-caption break-all">{d.address}</code>);
  const fv = d.file_version ?? 1;
  if (fv > 1) {
    const mark = ov.versions_marks.find((m) => m.version === fv);
    parts.push(`version ${fv}${mark ? ` since ${day(mark.date)}` : ""}`);
  }
  return parts.flatMap((p, i) => (i ? [" · ", p] : [p]));
}

export default function DocAnalytics({ slug }: { slug: string }) {
  const { ready } = useAnalyticsGate();
  const [params, setParams] = useParams();
  const phone = usePhone();
  const toast = useToast();
  const range: AnalyticsRange = isRange(params.get("range")) ? (params.get("range") as AnalyticsRange) : "30d";
  const internal = params.get("internal") === "1";
  const [csvBusy, setCsvBusy] = useState(false);

  const ovRes = useLoad(ready ? `ov:${slug}:${range}:${internal}` : null, () => getOverview(slug, { range, internal }));
  const ov = ovRes.data;
  const doc = ov?.doc ?? null;
  const items = useMemo(() => (doc ? tabsFor(doc.kind, doc.file_version ?? 1) : []), [doc]);
  const rawTab = params.get("tab");
  // A "video" link to an audio file (or the reverse) lands on its media tab.
  const asked = doc?.kind === "audio" && rawTab === "video" ? "listening" : doc?.kind === "video" && rawTab === "listening" ? "video" : rawTab;
  const tab = (items.some((t) => t.value === asked) ? asked : "overview") as Tab;

  // Markdown documents: heading ids → titles, and the fenced blocks for "Most copied".
  const md = useLoad(ready && doc?.kind === "doc" && !doc.encrypted ? `md:${slug}` : null, () => getDocMarkdown(slug));
  const headings: Heading[] = useMemo(() => (md.data ? extractHeadings(md.data) : []), [md.data]);
  const blocks = useMemo(() => (md.data ? fencedBlocks(md.data) : []), [md.data]);
  const titleFor = useCallback((id: string) => headings.find((h) => h.id === id)?.text || prettyHeadingId(id), [headings]);
  const rewrite = useCallback((s: string) => s.replace(/#?user-content-[^\s,;:!?"')]+/g, (raw) => {
    const id = raw.replace(/^#/, "");
    const clean = id.replace(/[.]+$/, "");
    return titleFor(clean) + id.slice(clean.length);
  }), [titleFor]);

  const title = doc ? doc.title || doc.slug : null;
  useEffect(() => {
    if (title) document.title = `${title} · Analytics · Markdrop`;
  }, [title]);

  const setTab = (t: string) => setParams({ tab: t === "overview" ? null : t });
  const onInsight = (i: Insight) => {
    let t = String(i.cta?.tab ?? "overview");
    if (doc?.kind === "audio" && t === "video") t = "listening";
    if (doc?.kind === "video" && t === "listening") t = "video";
    setTab(items.some((x) => x.value === t) ? t : "overview");
    document.getElementById("an-tabs")?.scrollIntoView({ block: "nearest" });
  };

  async function csv() {
    setCsvBusy(true);
    try {
      await downloadDocCsv(slug, range);
    } catch {
      toast.error("Couldn't download the CSV. Try again.");
    } finally {
      setCsvBusy(false);
    }
  }

  if (ovRes.error && !ov) {
    return (
      <div className="flex flex-col gap-5">
        <Anchor href="/dashboard/analytics" className="inline-flex items-center gap-1.5 self-start text-[13px] no-underline">
          <Icon name="chevronLeft" size={14} />Analytics
        </Anchor>
        <LoadError error={ovRes.error} retry={ovRes.retry} />
      </div>
    );
  }

  if (!ov || !doc) {
    return (
      <div className="flex flex-col gap-5" aria-busy>
        <Skeleton width={90} height={14} />
        <div className="flex items-center gap-4">
          <Skeleton variant="rect" width={44} height={44} />
          <div className="flex flex-1 flex-col gap-2"><Skeleton width="50%" height={28} /><Skeleton width="70%" height={14} /></div>
        </div>
        <Skeleton height={36} />
        <KpiGrid loading count={phone ? 4 : 5} />
        <PanelSkeleton height={180} />
        <span className="md-visually-hidden">Loading analytics</span>
      </div>
    );
  }

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      {!phone && ov.live > 0 && <Badge tone="success" live>{num(ov.live)} {LIVE_WORD[doc.kind]}</Badge>}
      <RangePicker value={range} onChange={(r) => setParams({ range: r === "30d" ? null : r })} />
      <Button variant="secondary" size="sm" iconLeft="download" loading={csvBusy} onClick={csv}>CSV</Button>
    </div>
  );

  return (
    <div className="flex min-w-0 flex-col gap-4 sm:gap-5">
      {phone ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <IconButton icon="chevronLeft" label="Back to analytics" href="/dashboard/analytics" />
            <div className="min-w-0 flex-1">
              <div className="text-caption text-text-muted">Analytics</div>
              <h1 className="m-0 truncate text-[17px] leading-6 font-bold text-text" dir="auto">{title}</h1>
            </div>
            {ov.live > 0 && <Badge tone="success" live size="sm">{num(ov.live)} live</Badge>}
          </div>
          <p className="m-0 text-caption text-text-muted">{metaLine(ov)}</p>
          {controls}
        </div>
      ) : (
        <>
          <Anchor href="/dashboard/analytics" className="inline-flex items-center gap-1.5 self-start text-[13px] no-underline">
            <Icon name="chevronLeft" size={14} />Analytics
          </Anchor>
          <div className="flex flex-wrap items-start gap-4">
            <KindTile doc={doc} />
            <div className="min-w-0 flex-[1_1_320px]">
              <h1 className="m-0 text-h1 text-text break-words" dir="auto">{title}</h1>
              <p className="mt-1 mb-0 text-[13px] text-text-muted">{metaLine(ov)} · <ReadMore topic={readMoreFor(ov.doc.kind)} /></p>
            </div>
            {controls}
          </div>
        </>
      )}

      <div id="an-tabs" className="scroll-mt-20">
        <Tabs items={items} value={tab} onChange={setTab} idPrefix="an" aria-label="Analytics sections" />
      </div>

      <div role="tabpanel" id={`an-panel-${tab}`} aria-labelledby={`an-tab-${tab}`} className={cx("min-w-0 transition-opacity", ovRes.loading && "opacity-60")} aria-busy={ovRes.loading || undefined}>
        {tab === "overview" && <OverviewTab slug={slug} ov={ov} range={range} internal={internal} onInsight={onInsight} rewrite={rewrite} />}
        {(tab === "video" || tab === "listening") && <MediaTab slug={slug} ov={ov} range={range} internal={internal} />}
        {tab === "content" && <ContentTab slug={slug} ov={ov} range={range} internal={internal} headings={headings} blocks={blocks} titleFor={titleFor} />}
        {tab === "pages" && <PagesTab slug={slug} ov={ov} range={range} internal={internal} />}
        {tab === "audience" && <AudienceTab slug={slug} ov={ov} range={range} internal={internal} onInternal={(v) => setParams({ internal: v ? "1" : null })} />}
        {tab === "versions" && <VersionsTab slug={slug} ov={ov} range={range} internal={internal} />}
      </div>
    </div>
  );
}

