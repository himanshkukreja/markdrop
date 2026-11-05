"use client";

import { ReadMore } from "@/components/ReadMore";
import { useEffect, useMemo, useState } from "react";
import { Alert, Anchor, Badge, Button, Icon, Progress, Spinner, type Tone, useToast } from "@/components/ui";
import { useLocationSearch } from "@/components/shell/useLocation";
import {
  assetPreviewUrl, docsErrorMessage, listPages, presetName, type ImportReport, type Job, type JobStep, type ReportItem, type WorkerImportResult,
} from "@/lib/docsSites";
import { adoptGithubOpenapi } from "@/lib/docsGithub";
import { settingsHref } from "./settings/sections";
import { num, plural } from "./format";
import { previewTokens } from "./presets";
import SiteBar, { STUDIO_CHROME } from "./SiteBar";
import { useSite } from "./SiteContext";
import { studioNew, scopeOf } from "./routes";
import { useJob } from "./useJob";
import { ReleaseNotesOffer } from "./changelog/ReleaseNotesOffer";

interface StepDef { id: string; running: string; done: string; detail?: (r: ImportReport["summary"]) => string | null }

/** The worker's steps for a GitBook import, in order (progress.step names one of these; docs-platform/runner). */
export const IMPORT_STEPS: StepDef[] = [
  { id: "fetch", running: "Reading the navigation and page list", done: "Read the navigation and page list", detail: (s) => (s?.pages ? `${num(s.groups ?? 0)} groups · ${num(s.pages)} pages` : null) },
  { id: "convert", running: "Copying pages and converting blocks", done: "Copied pages and converted blocks", detail: () => "hints, tabs, steps, cards, code" },
  { id: "upload", running: "Copying images and files", done: "Copied images and files", detail: (s) => (s?.images !== undefined ? `${num(s.images)} images · ${num(s.files ?? 0)} ${s.files === 1 ? "file" : "files"}` : null) },
  { id: "save", running: "Saving the pages as drafts", done: "Saved the pages as drafts", detail: (s) => (s?.redirects ? `${num(s.redirects)} old links kept working` : null) },
];

/** A GitHub import's steps (docs-platform/runner: fetch → convert → upload → save). */
export const GITHUB_IMPORT_STEPS: StepDef[] = [
  { id: "fetch", running: "Downloading the repository", done: "Downloaded the repository" },
  { id: "convert", running: "Converting pages", done: "Converted pages", detail: (s) => (s?.pages ? `${num(s.groups ?? 0)} groups · ${num(s.pages)} pages` : null) },
  { id: "upload", running: "Copying images and files", done: "Copied images and files", detail: (s) => (s?.images !== undefined ? `${num(s.images)} images · ${num(s.files ?? 0)} ${s.files === 1 ? "file" : "files"}` : null) },
  { id: "save", running: "Saving as drafts", done: "Saved as drafts", detail: (s) => (s?.redirects ? `${num(s.redirects)} old links kept working` : null) },
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
  missing_assets: { tone: "warning", title: "Images or files we couldn't copy", body: "The download failed: they're missing or unreachable on the old site. Upload them again or remove them.", action: "Show" },
  kept_assets: { tone: "neutral", title: "Files still on GitBook", body: "Not copied (a file type we don't host, like a spreadsheet), but the page still shows or links them on GitBook. Upload your own copy before you close your GitBook site.", action: "Show" },
  lossy: { tone: "neutral", title: "Blocks converted approximately", body: "GitBook blocks with no exact match here. Check they read right.", action: "Show" },
};

/** The same rows for a GitHub import: about the repository, not a GitBook site. */
const GITHUB_REPORT_COPY: Record<string, { tone: Tone; title: string; body: string; action: string }> = {
  ...REPORT_COPY,
  alt_text: { tone: "warning", title: "Image descriptions we wrote for you", body: "These images had no alt text in the repository, so we used the file names. Screen readers and search read them: check they make sense.", action: "Show" },
  hidden_pages: { tone: "neutral", title: "Pages left out of the navigation", body: "In the repository but not in its sidebar. Imported and reachable by link: keep them hidden or show them.", action: "Review" },
  icons: { tone: "neutral", title: "Page icons we couldn't match", body: "Icons from the repository's config with no match here. Pick an icon or leave them blank.", action: "Show" },
  missing_assets: { tone: "warning", title: "Images or files we couldn't copy", body: "Missing from the repository, or a file we can't host. Add them to the repository or remove the reference.", action: "Show" },
  kept_assets: { tone: "neutral", title: "Files linked on GitHub", body: "Not copied (a file type we don't host), so the page links to the file in the repository instead.", action: "Show" },
  lossy: { tone: "neutral", title: "Blocks converted approximately", body: "Components with no exact match here. Check they read right.", action: "Show" },
};

type Row = { page?: string | null; line?: number | null; [k: string]: unknown };

/**
 * The worker's import result (services/docs_import_job.py: pages, nav_groups, assets, report
 * {counts, items, truncated}) → what this screen shows: a summary for the steps and the "needs a
 * look" rows. `pageIds` maps page paths to ids so a row can open the page in the editor.
 */
export function importReportOf(job: Job | null, pageIds: Map<string, string>, source: "gitbook" | "github" = "gitbook"): ImportReport | null {
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
    { kind: "kept_assets", count: total("keptOriginal"), items: (items.keptOriginal ?? []).map((x) => row(x, [q(x.src), q(x.reason)].filter(Boolean).join(" · ") || null)) },
    { kind: "broken_links", count: total("brokenLinks"), items: (items.brokenLinks ?? []).map((x) => row(x, [q(x.href), q(x.reason)].filter(Boolean).join(" · ") || null)) },
    { kind: "alt_text", count: total("altGenerated"), items: (items.altGenerated ?? []).map((x) => row(x, q(x.alt) ? `“${x.alt}”` : null)) },
    { kind: "hidden_pages", count: total("hidden"), items: (items.hidden ?? []).map((x) => row(x, q(x.title))) },
    {
      kind: "icons",
      count: (items.unmatchedIcons ?? []).reduce((n, x) => n + (Array.isArray(x.pages) ? x.pages.length : 1), 0),
      items: (items.unmatchedIcons ?? []).flatMap((x) => (Array.isArray(x.pages) ? (x.pages as string[]) : []).map((page) => row({ page }, `${source === "github" ? "Icon" : "GitBook icon"} “${String(x.icon ?? "")}”`))),
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
    ...(w.report?.brand ? { brand: w.report.brand } : {}),
  };
}

/**
 * "We picked up Acme's logo, colour and favicon and matched them with the Clean theme": only what
 * the guide actually has now (its saved logo and accent; the importer's word for the favicon), and
 * what didn't come across with the importer's reason, never a logo it didn't get.
 */
export function brandSentence(brand: { logo: boolean; accent: boolean; favicon: boolean; logoReason?: string | null }): { picked: string[]; missed: string | null } {
  const picked = [brand.logo && "logo", brand.accent && "colour", brand.favicon && "favicon"].filter(Boolean) as string[];
  const missed = !brand.logo && (brand.accent || brand.favicon) ? `We couldn't copy the logo${brand.logoReason ? ` (${brand.logoReason})` : ""}: upload it in Design.` : null;
  return { picked, missed };
}

const listWords = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

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

function ReportRow({ item, editorHref, github }: { item: ReportItem; editorHref: (pageId: string) => string; github?: boolean }) {
  const copy = (github ? GITHUB_REPORT_COPY : REPORT_COPY)[item.kind] ?? { tone: "neutral" as Tone, title: item.title ?? item.kind, body: item.body ?? "", action: "Show" };
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
        <ul id={listId} className="ph-no-capture flex flex-col gap-1.5 border-t border-border pt-3 text-[13px]">
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
    <div aria-hidden className="ph-no-capture overflow-hidden rounded-xl border border-border shadow-md" style={{ background: t.bg }}>
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

/** A GitHub import found an OpenAPI file: offer it as the guide's API reference (admins). */
function OpenapiOffer({ siteId, base, paths }: { siteId: string; base: string; paths: string[] }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [used, setUsed] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState("");
  const path = paths[0]!;
  if (hidden) return null;
  if (used) {
    return (
      <Alert tone="success" title="The API reference is set" live>
        From <code className="ph-sensitive ph-mask font-mono [overflow-wrap:anywhere]">{used}</code>. It goes live when you publish.{" "}
        <Anchor href={settingsHref(base, "api-reference")} className="font-semibold text-accent-text underline">API reference settings</Anchor>
      </Alert>
    );
  }
  async function use() {
    setBusy(true);
    setError("");
    try {
      await adoptGithubOpenapi(siteId, path);
      setUsed(path);
      toast.success("The API reference is set. It goes live when you publish.");
    } catch (e) {
      setError(docsErrorMessage(e, "We couldn't use that file. Try again."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="openapi-offer-h" className="flex min-w-0 flex-col gap-3 rounded-xl border-[1.5px] border-accent bg-surface px-[18px] py-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text" aria-hidden><Icon name="code" size={16} /></span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id="openapi-offer-h" className="font-semibold text-text">
            We found <code className="ph-sensitive ph-mask font-mono [overflow-wrap:anywhere]">{path.split("/").pop()}</code> in the repo
          </h2>
          <span className="text-[13px] text-text-secondary">
            Use it as the API reference? Readers get a page for every endpoint, code samples and Try it.
            {paths.length > 1 ? ` ${plural(paths.length - 1, "other OpenAPI file")} can be chosen in Settings › GitHub.` : ""}
          </span>
        </div>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" iconLeft="code" loading={busy} onClick={() => void use()}>Use as API reference</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setHidden(true)}>Not now</Button>
      </div>
    </section>
  );
}

/**
 * /guides/<site>/import?job=<id> (Import board): the import's steps with live progress (the
 * job is polled every 2 s), then "Needs a look before you publish" from the importer's report, and
 * a preview of the site in its matched theme. Safe to leave: the job runs on the server, and the
 * screen reopens from the site's last import (Settings › General › Imported from GitBook / GitHub).
 *
 * A GitHub import (site.source.kind "github") has its own steps and words (the repository, never a
 * GitBook site), says it's kept in sync and how when syncing is on, and offers an OpenAPI file the
 * import found in the repository as the guide's API reference (admins).
 */
export default function ImportProgress() {
  const { site, base, reload, canEdit, isAdmin } = useSite();
  const search = useLocationSearch();
  const jobId = new URLSearchParams(search).get("job") || site.job?.id || site.last_import_job_id || null;
  const { job, error } = useJob(site.id, jobId);
  const isTemplate = site.source.kind === "template";
  const isGithub = site.source.kind === "github";
  const steps = isTemplate ? TEMPLATE_STEPS : isGithub ? GITHUB_IMPORT_STEPS : IMPORT_STEPS;
  const at = stepIndex(job, steps);
  const [pageIds, setPageIds] = useState<Map<string, string>>(new Map());
  const report = useMemo(() => importReportOf(job, pageIds, isGithub ? "github" : "gitbook"), [job, pageIds, isGithub]);
  const done = job?.status === "done";
  const failed = job?.status === "failed";
  const fromHost = (() => {
    try { return site.source.url ? new URL(site.source.url).hostname : null; } catch { return null; }
  })();
  const repo = isGithub ? (site.github ?? site.source.repo ?? null) : null;
  const repoName = repo ? `${repo.owner}/${repo.name}` : null;
  const ghResult = (job?.result as WorkerImportResult | null | undefined)?.github ?? null;
  // Kept in sync after the import: the guide's link when it's there, else what the import was asked.
  const syncOn = isGithub && (site.github ? site.github.sync : !!site.source.sync);
  const syncMode = site.github?.mode ?? site.source.mode ?? "drafts";
  const syncBranch = site.github?.branch ?? site.source.repo?.branch ?? null;

  const rows: JobStep[] = job?.progress?.steps ?? steps.map((d, i) => ({
    id: d.id,
    label: i < at ? d.done : d.running,
    status: failed && i === at ? "failed" : i < at ? "done" : i === at ? "running" : "waiting",
    detail: i < at ? (isGithub && d.id === "fetch" && ghResult?.short_sha ? `Commit ${ghResult.short_sha}` : d.detail?.(report?.summary) ?? null) : i === at ? job?.progress?.message ?? null : i === at + 1 ? "next" : null,
  }));
  // Progress counts steps, plus how far the running step is ("Copying pages · 34 of 93" fills that
  // step's share of the bar), so a long step moves instead of sitting still.
  const total = steps.length;
  const p = job?.progress;
  const within = !done && p && typeof p.done === "number" && typeof p.total === "number" && p.total > 0 && steps[at]?.id === p.step
    ? Math.min(0.99, Math.max(0, p.done / p.total))
    : 0;
  const value = done ? total : at + within;
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
        crumb={isTemplate ? "Setting up from a template" : repoName ? `Import from ${repoName}` : fromHost ? `Import from ${fromHost}` : "Import"}
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
                  ? isGithub ? "Nothing was published, and your repository wasn't changed." : "Nothing was published, and your GitBook site wasn't changed."
                  : `This takes a few minutes for a large ${isGithub ? "repository" : "site"}. You can close this page: the import keeps running. Come back to Guides to see it.`}
            </p>
          </div>

          {!jobId && (
            <Alert tone="info" title="No import is running for this guide">
              <Anchor href={base} className="font-semibold text-accent-text underline">Open the editor</Anchor>
            </Alert>
          )}
          {error && !job && <Alert tone="danger" title="We couldn't check the import">{error}</Alert>}
          {failed && (
            <Alert tone="danger" title="Import failed" actions={<Button size="sm" variant="secondary" href={studioNew(scopeOf(site), isGithub ? "github" : null)}>Start again</Button>}>
              <span className="ph-sensitive ph-mask">{job?.error || "Something went wrong on our side."}</span>
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
                    {/* Phones: the detail goes under the label, so neither is squeezed to a word per line. */}
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
                      <span className={`min-w-0 text-text sm:flex-1 ${r.status === "running" ? "font-semibold" : r.status === "done" ? "font-medium" : "text-text-secondary"}`}>{r.label}</span>
                      {r.detail && <span className="ph-sensitive ph-mask text-[13px] tabular-nums text-text-muted [overflow-wrap:anywhere] sm:max-w-[45%] sm:text-right">{r.detail}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}

          {isGithub && jobId && syncOn && !failed && (
            <div className="flex min-w-0 flex-wrap items-start gap-3 rounded-xl border border-border bg-surface px-[18px] py-3.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text" aria-hidden><Icon name="refresh" size={16} /></span>
              <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-0.5">
                <strong className="font-semibold text-text">Kept in sync</strong>
                <span className="text-[13px] text-text-secondary">
                  Each push to {syncBranch ? <code className="ph-sensitive ph-mask font-mono">{syncBranch}</code> : "the branch"}{" "}
                  {syncMode === "publish" ? "is published after it syncs." : "updates the drafts. You publish when ready."}
                </span>
              </div>
              <Button variant="ghost" size="sm" iconRight="arrowRight" href={settingsHref(base, "github")}>GitHub settings</Button>
            </div>
          )}

          {isGithub && done && isAdmin && (ghResult?.openapi?.length ?? 0) > 0 && (
            <OpenapiOffer siteId={site.id} base={base} paths={ghResult!.openapi} />
          )}

          {!isTemplate && <ReleaseNotesOffer siteId={site.id} base={base} canEdit={canEdit} ready={done} />}

          {!isTemplate && jobId && (
            <section aria-labelledby="needs-h" className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline gap-x-3"><h2 id="needs-h" className="text-[16px] font-semibold text-text">Needs a look before you publish</h2><ReadMore topic="studioImportReport" className="text-[13px]" /></div>
              {needs.length > 0 ? (
                needs.map((item) => <ReportRow key={item.kind} item={item} github={isGithub} editorHref={(pid) => `${base}?page=${encodeURIComponent(pid)}`} />)
              ) : done ? (
                <p className="text-body text-text-secondary">Nothing. Everything came across cleanly.</p>
              ) : (
                <p className="flex items-center gap-2 text-body text-text-muted"><Spinner size={14} /> We list anything that needs your eyes as we find it.</p>
              )}
              {skipped.length > 0 && (
                <Alert tone="warning" title={`${plural(skipped.length, "thing")} we left out`}>
                  <ul className="ph-no-capture flex list-disc flex-col gap-1 pl-4 text-[13px]">{skipped.slice(0, 20).map((x) => <li key={x} className="[overflow-wrap:anywhere]">{x}</li>)}</ul>
                </Alert>
              )}
              {report?.markdown && (
                <details className="ph-no-capture rounded-lg border border-border bg-surface px-4 py-3 text-[13px]">
                  <summary className="cursor-pointer font-semibold text-text">The full import report</summary>
                  <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap font-mono text-[12.5px] leading-5 text-text-secondary">{report.markdown}</pre>
                </details>
              )}
            </section>
          )}
        </div>

        {/* Beside the steps, the preview and "Open the editor" stay in view while a long report scrolls. */}
        <aside aria-label="Preview" className="flex min-w-0 flex-[1_1_320px] flex-col gap-3 lg:sticky lg:self-start" style={{ top: `calc(${STUDIO_CHROME} + 24px)` }}>
          <MiniSite name={report?.brand?.name || site.name} />
          <p className="text-[13px] text-text-muted">
            {(() => {
              const b = site.settings.theme.brand;
              const got = brandSentence({
                logo: !!b.logo_url,
                accent: b.enabled && !!(b.accent || b.colors?.[0]),
                favicon: !!(report?.brand?.favicon ?? report?.brand?.favicon_url),
                logoReason: report?.brand?.logoReason,
              });
              const theme = presetName(site.settings.theme.preset);
              const design = <Anchor href={`${base}/design`} className="text-accent-text underline">Design</Anchor>;
              if (!done || !got.picked.length) return <>Your guide uses the {theme} theme. Change it in {design}.</>;
              return (
                <>
                  We picked up <span className="ph-sensitive ph-mask">{report?.brand?.name || site.name.replace(/\s+docs$/i, "")}</span>&apos;s {listWords(got.picked)} and matched {got.picked.length === 1 ? "it" : "them"} with the {theme} theme.{" "}
                  {got.missed && <>{got.missed} </>}Change it in {design}.
                </>
              );
            })()}
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
