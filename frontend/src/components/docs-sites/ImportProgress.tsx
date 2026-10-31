"use client";

import { ReadMore } from "@/components/ReadMore";
import { useEffect, useMemo, useState } from "react";
import { Alert, Anchor, Badge, Button, Icon, Progress, Spinner, type Tone } from "@/components/ui";
import { useLocationSearch } from "@/components/shell/useLocation";
import {
  assetPreviewUrl, listPages, presetName, type ImportReport, type Job, type JobStep, type ReportItem, type WorkerImportResult,
} from "@/lib/docsSites";
import { num, plural } from "./format";
import { previewTokens } from "./presets";
import SiteBar from "./SiteBar";
import { useSite } from "./SiteContext";
import { studioNew, scopeOf } from "./routes";
import { useJob } from "./useJob";

interface StepDef { id: string; running: string; done: string; detail?: (r: ImportReport["summary"]) => string | null }

/** The worker's steps for a GitBook import, in order (progress.step names one of these; docs-platform/runner). */
export const IMPORT_STEPS: StepDef[] = [
  { id: "fetch", running: "Reading the navigation and page list", done: "Read the navigation and page list", detail: (s) => (s?.pages ? `${num(s.groups ?? 0)} groups · ${num(s.pages)} pages` : null) },
  { id: "convert", running: "Copying pages and converting blocks", done: "Copied pages and converted blocks", detail: () => "hints, tabs, steps, cards, code" },
  { id: "upload", running: "Copying images and files", done: "Copied images and files", detail: (s) => (s?.images !== undefined ? `${num(s.images)} images · ${num(s.files ?? 0)} ${s.files === 1 ? "file" : "files"}` : null) },
  { id: "save", running: "Saving the pages as drafts", done: "Saved the pages as drafts", detail: (s) => (s?.redirects ? `${num(s.redirects)} old links kept working` : null) },
];

const TEMPLATE_STEPS: StepDef[] = [
  { id: "seed", running: "Adding the template's pages", done: "Added the template's pages" },
  { id: "check", running: "Getting the editor ready", done: "The editor is ready" },
];

const REPORT_COPY: Record<string, { tone: Tone; title: string; body: string; action: string }> = {
  alt_text: { tone: "warning", title: "Image descriptions we wrote for you", body: "GitBook had no alt text for these, so we used the file names. Screen readers and search read them: check they make sense.", action: "Show" },
  hidden_pages: { tone: "neutral", title: "Pages hidden from the sidebar in GitBook", body: "Imported and reachable by link. Keep them hidden or show them.", action: "Review" },
  broken_links: { tone: "danger", title: "Links that were already broken", body: "Fix or remove them.", action: "Show links" },
  icons: { tone: "neutral", title: "Page icons we couldn't match", body: "Brand logos and single letters. Pick an icon or leave them blank.", action: "Show" },
  missing_assets: { tone: "warning", title: "Images or files we couldn't copy", body: "They were missing or unreachable on the old site.", action: "Show" },
  lossy: { tone: "neutral", title: "Blocks converted approximately", body: "GitBook blocks with no exact match here. Check they read right.", action: "Show" },
};

type Row = { page?: string | null; line?: number | null; [k: string]: unknown };

/**
 * The worker's import result (services/docs_import_job.py: pages, nav_groups, assets, report
 * {counts, items, truncated}) → what this screen shows: a summary for the steps and the "needs a
 * look" rows. `pageIds` maps page paths to ids so a row can open the page in the editor.
 */
export function importReportOf(job: Job | null, pageIds: Map<string, string>): ImportReport | null {
  const r = job?.result as WorkerImportResult | ImportReport | null | undefined;
  if (!r) return null;
  if ("needs_look" in r || "summary" in r) return r as ImportReport;
  const w = r as WorkerImportResult;
  const counts = w.report?.counts ?? {};
  const items = w.report?.items ?? {};
  const total = (k: string) => (w.report?.truncated?.[k] ?? (typeof counts[k] === "number" ? (counts[k] as number) : ((items as Record<string, unknown[] | undefined>)[k]?.length ?? 0)));
  const row = (x: Row, detail: string | null) => {
    const path = typeof x.page === "string" ? x.page : "";
    return { page_id: pageIds.get(path) ?? null, path: path || "(site)", line: typeof x.line === "number" ? x.line : null, detail };
  };
  const q = (v: unknown) => (typeof v === "string" && v ? v : null);
  const needs: ReportItem[] = [
    { kind: "missing_assets", count: total("missing"), items: (items.missing ?? []).map((x) => row(x, [q(x.src), q(x.reason)].filter(Boolean).join(" · ") || null)) },
    { kind: "broken_links", count: total("brokenLinks"), items: (items.brokenLinks ?? []).map((x) => row(x, [q(x.href), q(x.reason)].filter(Boolean).join(" · ") || null)) },
    { kind: "alt_text", count: total("altGenerated"), items: (items.altGenerated ?? []).map((x) => row(x, q(x.alt) ? `“${x.alt}”` : null)) },
    { kind: "hidden_pages", count: total("hidden"), items: (items.hidden ?? []).map((x) => row(x, q(x.title))) },
    {
      kind: "icons",
      count: (items.unmatchedIcons ?? []).reduce((n, x) => n + (Array.isArray(x.pages) ? x.pages.length : 1), 0),
      items: (items.unmatchedIcons ?? []).flatMap((x) => (Array.isArray(x.pages) ? (x.pages as string[]) : []).map((page) => row({ page }, `GitBook icon “${String(x.icon ?? "")}”`))),
    },
    { kind: "lossy", count: total("notes"), items: (items.notes ?? []).map((x) => row(x, q(x.message))) },
  ];
  return {
    summary: {
      pages: w.pages?.total ?? (counts.pages as number | undefined),
      groups: w.nav_groups ?? (counts.groups as number | undefined),
      images: counts.images as number | undefined,
      files: counts.files as number | undefined,
      redirects: counts.redirects as number | undefined,
      anchors: counts.headingIdsChanged as number | undefined,
    },
    needs_look: needs.filter((n) => n.count > 0),
    skipped: w.skipped ?? [],
  };
}

/** The step index a job is on (0-based), from `progress.step` (an id or a 1-based number). */
function stepIndex(job: Job | null, steps: StepDef[]): number {
  if (!job) return 0;
  if (job.status === "done") return steps.length;
  const s = job.progress?.step;
  if (typeof s === "number") return Math.max(0, Math.min(steps.length - 1, s - 1));
  const i = steps.findIndex((d) => d.id === s);
  if (i >= 0) return i;
  return Math.max(0, Math.min(steps.length - 1, job.progress?.done ?? 0));
}

function StepDot({ status }: { status: JobStep["status"] }) {
  const map = {
    done: { icon: "check", cls: "bg-success-soft text-success" },
    running: { icon: "refresh", cls: "bg-accent-soft text-accent-text" },
    waiting: { icon: "clock", cls: "bg-surface-inset text-text-muted" },
    failed: { icon: "x", cls: "bg-danger-soft text-danger" },
  }[status];
  return (
    <span className={`grid size-6 shrink-0 place-items-center rounded-full ${map.cls}`} aria-hidden>
      <Icon name={map.icon} size={14} className={status === "running" ? "motion-safe:animate-spin" : undefined} />
    </span>
  );
}

function ReportRow({ item, editorHref }: { item: ReportItem; editorHref: (pageId: string) => string }) {
  const copy = REPORT_COPY[item.kind] ?? { tone: "neutral" as Tone, title: item.title ?? item.kind, body: item.body ?? "", action: "Show" };
  const [open, setOpen] = useState(false);
  const listId = `report-${item.kind}`;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={copy.tone} size="sm">{num(item.count)}</Badge>
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-0.5">
          <strong className="font-semibold text-text">{item.title ?? copy.title}</strong>
          <span className="text-[13px] text-text-secondary">{item.body ?? copy.body}</span>
        </div>
        {!!item.items?.length && (
          <Button variant="secondary" size="sm" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : copy.action}
          </Button>
        )}
      </div>
      {open && item.items && (
        <ul id={listId} className="flex flex-col gap-1.5 border-t border-border pt-3 text-[13px]">
          {item.items.map((x, i) => (
            <li key={i} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              {x.page_id ? (
                <Anchor href={editorHref(x.page_id)} className="font-mono text-accent-text underline-offset-2 hover:underline">{x.path}{x.line ? `:${x.line}` : ""}</Anchor>
              ) : (
                <code className="font-mono text-text">{x.path}{x.line ? `:${x.line}` : ""}</code>
              )}
              {x.detail && <span className="min-w-0 text-text-muted [overflow-wrap:anywhere]">{x.detail}</span>}
            </li>
          ))}
          {item.items.length < item.count && <li className="text-text-muted">…and {num(item.count - item.items.length)} more. They&apos;re marked in the editor.</li>}
        </ul>
      )}
    </div>
  );
}

/** A tiny drawing of the imported site in its theme and brand (Import board's right column). */
function MiniSite({ name }: { name: string }) {
  const { site } = useSite();
  const t = previewTokens(site.settings.theme, false);
  const logo = site.settings.theme.brand.enabled ? assetPreviewUrl(site.id, site.settings.theme.brand.logo_url) : null;
  const bar = (w: string | number, h: number, bg: string, extra?: React.CSSProperties) => <span className="block" style={{ width: w, height: h, borderRadius: 3, background: bg, ...extra }} />;
  return (
    <div aria-hidden className="overflow-hidden rounded-xl border border-border shadow-md" style={{ background: t.bg }}>
      <div className="flex items-center gap-2 px-3.5 py-2.5" style={{ borderBottom: `1px solid ${t.line}`, background: t.header }}>
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt="" className="size-[22px] rounded-md object-contain" />
        ) : (
          <span className="grid size-[22px] place-items-center rounded-md text-[12px] font-extrabold" style={{ background: t.accent, color: t.onAccent }}>{name.charAt(0).toUpperCase()}</span>
        )}
        <strong style={{ color: t.text }}>{name.replace(/\s+docs$/i, "")}</strong>
        <span style={{ color: t.muted }}>Docs</span>
      </div>
      <div className="flex gap-3 p-3.5">
        <div className="flex w-[90px] shrink-0 flex-col gap-2">
          {bar(70, 7, t.soft)}{bar(80, 6, t.line)}{bar(64, 6, t.line)}{bar(76, 6, t.line)}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {bar("70%", 12, t.text)}{bar("100%", 6, t.line)}{bar("92%", 6, t.line)}
          {bar("100%", 34, t.soft, { borderRadius: 6 })}
          {bar("100%", 70, t.code, { borderRadius: 6 })}
        </div>
      </div>
    </div>
  );
}

/**
 * /guides/<site>/import?job=<id> (Import board): the import's steps with live progress (the
 * job is polled every 2 s), then "Needs a look before you publish" from the importer's report, and
 * a preview of the site in its matched theme. Safe to leave: the job runs on the server, and the
 * screen reopens from the site's last import (Settings › Imported from GitBook).
 */
export default function ImportProgress() {
  const { site, base, reload } = useSite();
  const search = useLocationSearch();
  const jobId = new URLSearchParams(search).get("job") || site.job?.id || site.last_import_job_id || null;
  const { job, error } = useJob(site.id, jobId);
  const isTemplate = site.source.kind === "template";
  const steps = isTemplate ? TEMPLATE_STEPS : IMPORT_STEPS;
  const at = stepIndex(job, steps);
  const [pageIds, setPageIds] = useState<Map<string, string>>(new Map());
  const report = useMemo(() => importReportOf(job, pageIds), [job, pageIds]);
  const done = job?.status === "done";
  const failed = job?.status === "failed";
  const fromHost = (() => {
    try { return site.source.url ? new URL(site.source.url).hostname : null; } catch { return null; }
  })();

  const rows: JobStep[] = job?.progress?.steps ?? steps.map((d, i) => ({
    id: d.id,
    label: i < at ? d.done : d.running,
    status: failed && i === at ? "failed" : i < at ? "done" : i === at ? "running" : "waiting",
    detail: i < at ? d.detail?.(report?.summary) ?? null : i === at ? job?.progress?.message ?? null : i === at + 1 ? "next" : null,
  }));
  // Progress counts steps; the running step's own count ("12 of 40 files") is its detail.
  const total = steps.length;
  const value = done ? total : at;
  const needs = report?.needs_look?.filter((x) => x.count > 0) ?? [];

  // The site finished importing: refresh it once so the editor opens with its pages and brand, and
  // learn the pages' ids so a "needs a look" row opens its page.
  useEffect(() => {
    if (!done) return;
    void reload();
    listPages(site.id).then((r) => setPageIds(new Map(r.pages.map((p) => [p.path, p.id])))).catch(() => {});
  }, [done, reload, site.id]);

  const queued = job?.status === "queued";
  const skipped = report?.skipped ?? [];

  return (
    <>
      <SiteBar
        section={null}
        crumb={isTemplate ? "Setting up from a template" : fromHost ? `Import from ${fromHost}` : "Import"}
        status={job ? <Badge size="sm" tone={failed ? "danger" : done ? "success" : "neutral"} dot>{failed ? "Failed" : done ? "Imported" : queued ? "Waiting to start" : "Importing"}</Badge> : null}
      />

      <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-[1120px] flex-wrap gap-8 px-4 pb-16 pt-8 outline-none sm:px-6 sm:pt-10">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[24px] font-bold leading-8 text-text">
              {done ? "Your pages are here" : failed ? "The import stopped" : "Bringing your pages across"}
            </h1>
            <p className="text-[15px] leading-6 text-text-secondary">
              {done
                ? "Everything is in the editor as a draft. Nothing is public until you publish."
                : failed
                  ? "Nothing was published, and your GitBook site wasn't changed."
                  : "This takes a few minutes for a large site. You can close this page: the import keeps running. Come back to Guides to see it."}
            </p>
          </div>

          {!jobId && (
            <Alert tone="info" title="No import is running for this guide">
              <Anchor href={base} className="font-semibold text-accent-text underline">Open the editor</Anchor>
            </Alert>
          )}
          {error && !job && <Alert tone="danger" title="We couldn't check the import">{error}</Alert>}
          {failed && (
            <Alert tone="danger" title="Import failed" actions={<Button size="sm" variant="secondary" href={studioNew(scopeOf(site))}>Start again</Button>}>
              {job?.error || "Something went wrong on our side."}
            </Alert>
          )}

          {jobId && (
            <>
              <Progress
                value={value}
                max={total}
                label={done ? "Done" : queued ? "Waiting for a builder to pick it up…" : job ? `Step ${Math.min(at + 1, total)} of ${total}` : "Starting…"}
                showValue={!!job}
                indeterminate={!job}
                tone={failed ? "danger" : done ? "success" : "accent"}
                valueText={`Step ${Math.min(at + 1, total)} of ${total}`}
              />
              <ol aria-label="Import steps" className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface">
                {rows.map((r, i) => (
                  <li key={r.id} className={`flex items-center gap-3 px-[18px] py-3.5 ${i ? "border-t border-border" : ""}`} aria-current={r.status === "running" ? "step" : undefined}>
                    <StepDot status={r.status} />
                    <span className={`min-w-0 flex-1 text-text ${r.status === "running" ? "font-semibold" : r.status === "done" ? "font-medium" : "text-text-secondary"}`}>{r.label}</span>
                    {r.detail && <span className="shrink-0 text-right text-[13px] tabular-nums text-text-muted">{r.detail}</span>}
                  </li>
                ))}
              </ol>
            </>
          )}

          {!isTemplate && jobId && (
            <section aria-labelledby="needs-h" className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline gap-x-3"><h2 id="needs-h" className="text-[16px] font-semibold text-text">Needs a look before you publish</h2><ReadMore topic="studioImportReport" className="text-[13px]" /></div>
              {needs.length > 0 ? (
                needs.map((item) => <ReportRow key={item.kind} item={item} editorHref={(pid) => `${base}?page=${encodeURIComponent(pid)}`} />)
              ) : done ? (
                <p className="text-body text-text-secondary">Nothing. Everything came across cleanly.</p>
              ) : (
                <p className="flex items-center gap-2 text-body text-text-muted"><Spinner size={14} /> We list anything that needs your eyes as we find it.</p>
              )}
              {skipped.length > 0 && (
                <Alert tone="warning" title={`${plural(skipped.length, "thing")} we left out`}>
                  <ul className="flex list-disc flex-col gap-1 pl-4 text-[13px]">{skipped.slice(0, 20).map((x) => <li key={x} className="[overflow-wrap:anywhere]">{x}</li>)}</ul>
                </Alert>
              )}
              {report?.markdown && (
                <details className="rounded-lg border border-border bg-surface px-4 py-3 text-[13px]">
                  <summary className="cursor-pointer font-semibold text-text">The full import report</summary>
                  <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap font-mono text-[12.5px] leading-5 text-text-secondary">{report.markdown}</pre>
                </details>
              )}
            </section>
          )}
        </div>

        <aside aria-label="Preview" className="flex min-w-0 flex-[1_1_320px] flex-col gap-3">
          <MiniSite name={report?.brand?.name || site.name} />
          <p className="text-[13px] text-text-muted">
            {site.settings.theme.brand.enabled
              ? <>We picked up {report?.brand?.name || site.name.replace(/\s+docs$/i, "")}&apos;s logo, colour and favicon and matched them with the {presetName(site.settings.theme.preset)} theme. Change it in <Anchor href={`${base}/design`} className="text-accent-text underline">Design</Anchor>.</>
              : <>Your guide uses the {presetName(site.settings.theme.preset)} theme. Change it in <Anchor href={`${base}/design`} className="text-accent-text underline">Design</Anchor>.</>}
          </p>
          {done ? (
            <Button variant="primary" block iconLeft="edit" href={base}>Open the editor</Button>
          ) : (
            <Button variant="secondary" block iconLeft="eye" disabled>Preview when ready</Button>
          )}
        </aside>
      </main>
    </>
  );
}
