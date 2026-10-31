"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Alert, Anchor, Badge, Button, EmptyState, Icon, Select, Skeleton, cx } from "@/components/ui";
import { useLocationSearch, useMounted } from "@/components/shell/useLocation";
import { guideEvents } from "@/lib/guidesEvents";
import {
  comparePublishes, docsErrorMessage, listBuilds, primaryAddress,
  type Build, type ComparePage, type CompareResponse, type DiffRow,
} from "@/lib/docsSites";
import { plural, whenShort } from "../format";
import { liveUrl, usePublishState } from "../PublishState";
import { useSite } from "../SiteContext";

/** /guides/<site>/publish/compare?from=<publish id|live|none>&to=<publish id|live|drafts>&page=<page id>&view=split */
export function compareHref(base: string, from: string, to: string, page?: string | null): string {
  const q = new URLSearchParams({ from, to });
  if (page) q.set("page", page);
  return `${base}/publish/compare?${q.toString()}`;
}

type View = "text" | "split";
const DOT: Record<ComparePage["change"], string> = { added: "bg-success", edited: "bg-accent", removed: "bg-danger" };

function optionLabel(b: Build): string {
  const bits = [`#${b.number}`, b.live ? "Live" : whenShort(b.finished_at ?? b.created_at)];
  if (b.status === "failed") bits.push("failed");
  if (b.note?.trim()) bits.push(b.note.trim().length > 40 ? `${b.note.trim().slice(0, 39)}…` : b.note.trim());
  return bits.join(" · ");
}

/** Side by side: unchanged lines on both sides, a run of deletions next to the additions that replace it. */
function pairRows(rows: DiffRow[]): Array<{ left: DiffRow | null; right: DiffRow | null; gap?: string }> {
  const out: Array<{ left: DiffRow | null; right: DiffRow | null; gap?: string }> = [];
  for (let i = 0; i < rows.length;) {
    const r = rows[i]!;
    if (r.op === "gap") { out.push({ left: null, right: null, gap: r.text }); i++; continue; }
    if (r.op === "same") { out.push({ left: r, right: r }); i++; continue; }
    const dels: DiffRow[] = [];
    const adds: DiffRow[] = [];
    while (i < rows.length && rows[i]!.op === "del") dels.push(rows[i++]!);
    while (i < rows.length && rows[i]!.op === "add") adds.push(rows[i++]!);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return out;
}

const SIGN: Record<DiffRow["op"], string> = { add: "+", del: "-", same: " ", gap: "" };
const ROW_BG: Record<DiffRow["op"], string> = { add: "bg-success-soft", del: "bg-danger-soft", same: "", gap: "" };
const SIGN_INK: Record<DiffRow["op"], string> = { add: "text-success", del: "text-danger", same: "text-text-muted", gap: "" };

function Gap({ n }: { n: string }) {
  return (
    <div className="flex items-center gap-2 bg-surface-inset px-4 py-0.5 font-sans text-[12px] text-text-muted">
      <Icon name="more" size={12} /> {plural(Number(n) || 0, "unchanged line")}
    </div>
  );
}

function TextDiff({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="flex min-w-0 flex-col font-mono text-[13px] leading-[22px]">
      {rows.map((r, i) => r.op === "gap" ? <Gap key={i} n={r.text} /> : (
        <div key={i} className={cx("flex gap-3 px-4", ROW_BG[r.op])}>
          <span className={cx("w-3.5 shrink-0 select-none", SIGN_INK[r.op])} aria-hidden>{SIGN[r.op]}</span>
          <span className="md-visually-hidden">{r.op === "add" ? "Added: " : r.op === "del" ? "Removed: " : ""}</span>
          <span className={cx("min-w-0 flex-1 whitespace-pre-wrap break-words", r.op === "same" ? "text-text-secondary" : "text-text")} dir="auto">{r.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

function SplitDiff({ rows }: { rows: DiffRow[] }) {
  const pairs = useMemo(() => pairRows(rows), [rows]);
  const cell = (r: DiffRow | null, side: "left" | "right") => (
    <div className={cx("flex min-w-0 gap-2 px-3", r ? ROW_BG[r.op] : "bg-surface-inset/50", side === "left" && "border-r border-border")}>
      <span className="w-8 shrink-0 select-none text-right text-text-muted" aria-hidden>{r ? (side === "left" ? r.a : r.b) ?? "" : ""}</span>
      {r && <span className="md-visually-hidden">{r.op === "add" ? "Added: " : r.op === "del" ? "Removed: " : ""}</span>}
      <span className={cx("min-w-0 flex-1 whitespace-pre-wrap break-words", r?.op === "same" ? "text-text-secondary" : "text-text")} dir="auto">{r ? r.text || " " : ""}</span>
    </div>
  );
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[640px] grid-cols-2 font-mono text-[13px] leading-[22px]">
        <div className="border-b border-r border-border px-3 py-1 font-sans text-[12px] font-semibold text-text-muted">Before</div>
        <div className="border-b border-border px-3 py-1 font-sans text-[12px] font-semibold text-text-muted">After</div>
        {pairs.map((p, i) => p.gap !== undefined
          ? <div key={i} className="col-span-2"><Gap n={p.gap} /></div>
          : <div key={i} className="contents">{cell(p.left, "left")}{cell(p.right, "right")}</div>)}
      </div>
    </div>
  );
}

/**
 * What changed (Compare board): any publish against any other, or the live publish against the
 * unpublished drafts. The changed pages (added / edited / removed, +lines −lines) and the selected
 * page's Markdown as a line diff, as text or side by side.
 */
export default function CompareScreen() {
  const { site, base } = useSite();
  const { status } = usePublishState();
  const uid = useId();
  const mounted = useMounted();
  const search = useLocationSearch();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const [builds, setBuilds] = useState<Build[] | null>(null);
  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("text");
  const tracked = useRef("");

  const pending = status?.count ?? 0;
  const from = params.get("from") || "live";
  const to = params.get("to") || "drafts";
  const page = params.get("page");

  useEffect(() => {
    if (params.get("view") === "split") setView("split");
  }, [params]);

  useEffect(() => { listBuilds(site.id).then(setBuilds).catch(() => setBuilds([])); }, [site.id]);

  useEffect(() => {
    if (!mounted) return;
    let live = true;
    setLoading(true);
    comparePublishes(site.id, from, to, page)
      .then((r) => {
        if (!live) return;
        setData(r);
        setError("");
        const key = `${from}>${to}`;
        if (tracked.current !== key) {
          tracked.current = key;
          guideEvents.compareViewed(r.from.kind === "publish" ? "publish" : "none", r.to.kind === "drafts" ? "drafts" : "publish");
        }
      })
      .catch((e) => live && setError(docsErrorMessage(e, "Couldn't compare these versions.")))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [mounted, site.id, from, to, page]);

  const go = (next: { from?: string; to?: string; page?: string | null; view?: View }) => {
    const q = new URLSearchParams(search);
    if (next.from !== undefined) q.set("from", next.from);
    if (next.to !== undefined) q.set("to", next.to);
    if (next.page !== undefined) { if (next.page) q.set("page", next.page); else q.delete("page"); }
    if (next.view !== undefined) { if (next.view === "split") q.set("view", "split"); else q.delete("view"); }
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${q.toString()}`);
  };

  const withSnapshot = (builds ?? []).filter((b) => !!b.snapshot_id);
  const liveBuild = withSnapshot.find((b) => b.live);
  // "live" in the address is the live publish: the pickers show its number.
  const fromValue = from === "live" && liveBuild ? liveBuild.id : from;
  const toValue = to === "live" && liveBuild ? liveBuild.id : to;
  const fromOptions = [
    ...withSnapshot.map((b) => ({ value: b.id, label: optionLabel(b) })),
    { value: "none", label: "Nothing (before the first publish)" },
    ...(fromValue === "live" ? [{ value: "live", label: "The live publish" }] : []),
  ];
  const toOptions = [
    { value: "drafts", label: pending ? `Unpublished changes (drafts) · ${plural(pending, "change")}` : "Unpublished changes (drafts)" },
    ...withSnapshot.map((b) => ({ value: b.id, label: optionLabel(b) })),
  ];

  const s = data?.summary;
  const sel = data?.page ?? null;
  const host = primaryAddress(site);
  // The page's live address: only when one side is what readers see now and the page is in it.
  const liveSide = data?.to.live ? "to" : data?.from.live ? "from" : null;
  const inLive = !!sel && site.status === "live" && !!liveSide && (liveSide === "to" ? sel.change !== "removed" : sel.change !== "added");
  const livePath = sel ? (liveSide === "from" ? sel.moved_from || sel.path : sel.path) : "/";

  return (
    <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-[1240px] flex-col gap-[18px] px-4 pb-14 pt-6 outline-none sm:px-6">
      <Anchor href={`${base}/publish`} className="inline-flex items-center gap-1.5 self-start text-[13px] text-accent-text no-underline hover:underline">
        <Icon name="chevronLeft" size={14} /> Back to Publish
      </Anchor>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 flex-[1_1_320px] text-[24px] font-bold leading-8 text-text">What changed</h1>
        <label className="flex min-w-0 items-center gap-2 text-[13px] text-text-muted max-sm:w-full">
          From
          <Select aria-label="From publish" value={fromValue} onChange={(e) => go({ from: e.target.value, page: null })} options={fromOptions} className="ph-no-capture min-w-0 max-w-[300px] max-sm:max-w-none max-sm:flex-1" />
        </label>
        <Icon name="arrowRight" size={16} className="text-text-muted max-sm:hidden" />
        <label className="flex min-w-0 items-center gap-2 text-[13px] text-text-muted max-sm:w-full">
          To
          <Select aria-label="To publish" value={toValue} onChange={(e) => go({ to: e.target.value, page: null })} options={toOptions} className="ph-no-capture min-w-0 max-w-[300px] max-sm:max-w-none max-sm:flex-1" />
        </label>
      </div>

      {s && (
        <div className="flex flex-wrap gap-2">
          <Badge tone="success" icon="plus">{plural(s.added, "page")} added</Badge>
          <Badge tone="info" icon="edit">{plural(s.edited, "page")} edited</Badge>
          <Badge tone={s.removed ? "danger" : "neutral"} icon={s.removed ? "minus" : undefined}>{s.removed} removed</Badge>
          <Badge tone="neutral" icon="sun">{s.design ? "Design changed" : "Design unchanged"}</Badge>
          <Badge tone="neutral" icon="link">{s.redirects ? "Redirects changed" : "Redirects unchanged"}</Badge>
          {s.api && <Badge tone="neutral" icon="code">API reference changed</Badge>}
          {s.settings.some((k) => !["theme", "redirects", "api"].includes(k)) && <Badge tone="neutral" icon="settings">Settings changed</Badge>}
        </div>
      )}

      {error && <Alert tone="danger" title="We couldn't compare these">{error}</Alert>}
      {!data && !error && (
        <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]" aria-busy="true" aria-label="Loading the comparison">
          <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4"><Skeleton width="80%" /><Skeleton width="70%" /><Skeleton width="75%" /></div>
          <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4"><Skeleton width="60%" /><Skeleton width="90%" /><Skeleton width="85%" /><Skeleton width="70%" /></div>
        </div>
      )}
      {data && data.pages.length === 0 && (
        <EmptyState icon="checkCircle" title="No page changes" description={s && s.settings.length ? "Only settings differ between these two versions (see above)." : "These two versions are the same."} />
      )}

      {data && data.pages.length > 0 && (
        <div className={cx("grid items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]", loading && "opacity-70")} aria-busy={loading || undefined}>
          <nav aria-label="Changed pages" className="ph-no-capture flex max-h-[70dvh] flex-col overflow-y-auto rounded-xl border border-border bg-surface lg:sticky lg:top-[80px]">
            {data.pages.map((p) => {
              const on = sel?.id === p.id;
              const delta = p.change === "added" ? "new" : p.change === "removed" ? "removed" : `+${p.added_lines} −${p.removed_lines}`;
              return (
                <a
                  key={p.id}
                  href={compareHref(base, from, to, p.id)}
                  aria-current={on ? "page" : undefined}
                  onClick={(e) => { e.preventDefault(); go({ page: p.id }); }}
                  className={cx("md-focus flex items-center gap-2.5 border-b border-border px-3.5 py-[11px] text-text no-underline last:border-b-0", on ? "bg-accent-soft" : "hover:bg-surface-hover")}
                >
                  <span className={cx("size-2 shrink-0 rounded-full", DOT[p.change])} aria-hidden />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <strong className="ph-sensitive ph-mask truncate font-semibold" dir="auto">{p.title}</strong>
                    <span className="ph-sensitive ph-mask truncate font-mono text-[11px] text-text-muted">{p.path}</span>
                  </span>
                  <span className="shrink-0 text-[12px] text-text-muted">
                    {delta}<span className="md-visually-hidden">{p.change === "edited" ? ` lines, edited` : ""}</span>
                  </span>
                </a>
              );
            })}
          </nav>

          {sel && (
            <section aria-labelledby={`${uid}-page`} className="ph-no-capture flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface">
              <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3">
                <strong id={`${uid}-page`} className="ph-sensitive ph-mask min-w-0 flex-1 truncate text-[15px]" dir="auto">{sel.title}</strong>
                <span className="text-[12px] text-success">+{plural(sel.added_lines, "line")}</span>
                <span className="text-[12px] text-danger">−{plural(sel.removed_lines, "line")}</span>
                <div role="group" aria-label="View" className="inline-flex rounded-lg bg-surface-inset p-[3px]">
                  {(["text", "split"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={view === v}
                      onClick={() => { setView(v); go({ view: v }); guideEvents.compareView(v); }}
                      className={cx("md-focus h-[26px] rounded-md px-2.5 text-[12px]", view === v ? "bg-surface text-text shadow-sm" : "text-text-muted hover:text-text")}
                    >
                      {v === "text" ? "Text" : "Side by side"}
                    </button>
                  ))}
                </div>
                {inLive ? (
                  <Button variant="ghost" size="sm" iconRight="external" href={liveUrl(host, livePath)} target="_blank" rel="noopener noreferrer" onClick={() => guideEvents.liveOpened("compare")}>
                    Open live page<span className="md-visually-hidden"> in a new tab</span>
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" iconRight="external" disabled title={site.status === "live" ? "This page isn't live" : "The guide isn't published"}>Open live page</Button>
                )}
              </div>
              {sel.moved_from && <p className="border-b border-border px-4 py-2 text-[12px] text-text-muted">Moved from <span className="ph-sensitive ph-mask font-mono">{sel.moved_from}</span> to <span className="ph-sensitive ph-mask font-mono">{sel.path}</span></p>}
              {sel.change === "edited" && !sel.added_lines && !sel.removed_lines && (
                <p className="px-4 py-3 text-[13px] text-text-muted">The text is the same; {sel.fields?.length ? `the page's ${sel.fields.map((f) => (f === "path" ? "address" : f)).join(", ")} changed` : "only page details changed"}.</p>
              )}
              <div className="ph-sensitive ph-mask">
                {view === "split" ? <SplitDiff rows={sel.rows} /> : <TextDiff rows={sel.rows} />}
              </div>
              {sel.truncated && <p className="border-t border-border px-4 py-2 text-[12px] text-text-muted">This page changed a lot: the diff is cut short.</p>}
            </section>
          )}
        </div>
      )}
    </main>
  );
}
