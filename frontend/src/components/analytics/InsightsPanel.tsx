"use client";

/**
 * "✦ Insights" (Analytics AI per document, services/analytics_ai_doc.py): at the top of the Content,
 * Pages, Video / Listening and Versions tabs. Claude Haiku 5.5 reads the tab's numbers (and the
 * owner's own content where it helps) and comes back with 3 to 5 findings that point at the exact
 * section, moment, page or version.
 *
 *   empty  → what it does, what's sent, and Analyse (44 px)
 *   thin   → how many sessions there are and how many it needs (the model isn't called)
 *   ready  → summary, findings, extras per kind (rewrite with Copy / Apply in page, timestamp chips
 *            that mark the moment on the retention chart, chapters with Copy, the versions verdict
 *            with the server's confidence), generated time, Re-analyse, and a note when stale
 *
 * Nothing is applied by itself: a rewrite is copied, or offered in the page's editor as a
 * suggestion (lib/insightApply.ts), where Accept is the only thing that changes the page.
 */
import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, CopyButton, Icon, Skeleton, cx, type Tone } from "@/components/ui";
import {
  AiError, getAiAnalysis, runAiAnalysis,
  type AiAnalysis, type AiFinding, type AiKind, type AiResult, type AnalyticsRange,
} from "@/lib/analytics";
import { applyHref, storeRewrite } from "@/lib/insightApply";
import { clock, num, pct, secs } from "./format";
import { FrameThumb, useLoad } from "./parts";
import "./insights.css";

const SEVERITY: Record<AiFinding["severity"], { tone: Tone; label: string }> = {
  high: { tone: "warning", label: "High impact" },
  medium: { tone: "info", label: "Medium" },
  low: { tone: "neutral", label: "Low" },
};

const STAGES: Record<AiKind, string[]> = {
  content: ["Reading the numbers…", "Reading the sections where readers leave…", "Writing suggestions…"],
  media: ["Reading the numbers…", "Looking at the key moments…", "Writing suggestions…"],
  pages: ["Reading the numbers…", "Reading the pages where readers stop…", "Writing suggestions…"],
  versions: ["Comparing the versions…", "Writing the verdict…"],
};

const WHAT: Record<AiKind, string> = {
  content: "Finds where readers stop and why, section by section, and suggests rewrites.",
  media: "Finds the moments people drop, skip or rewatch, and suggests cuts, chapters and pacing.",
  pages: "Finds the pages where readers stop or linger, and suggests what to change.",
  versions: "Compares your versions and says which works better, and how sure that is.",
};

function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function Sparkle({ className }: { className?: string }) {
  return <span aria-hidden className={cx("an-ai__spark", className)}>✦</span>;
}

export interface InsightsPanelProps {
  slug: string;
  kind: AiKind;
  range: AnalyticsRange;
  internal: boolean;
  /** media: the version on show. */
  ver?: number | null;
  /** media: video (frames) or audio. */
  video?: boolean;
  /** media: mark a moment on the retention chart. */
  onMoment?: (t: number) => void;
  /** media: the moment marked now. */
  activeT?: number | null;
}

export default function InsightsPanel({ slug, kind, range, internal, ver = null, video = false, onMoment, activeT = null }: InsightsPanelProps) {
  const scope = useMemo(() => ({ range, internal }), [range, internal]);
  const key = `ai:${slug}:${kind}:${range}:${internal}:${ver ?? ""}`;
  const loaded = useLoad(key, () => getAiAnalysis(slug, kind, scope, ver));
  const [mine, setMine] = useState<{ key: string; data: AiAnalysis } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; limit: boolean } | null>(null);
  const [stage, setStage] = useState(0);
  useEffect(() => { setError(null); }, [key]);
  useEffect(() => {
    if (!busy) return;
    setStage(0);
    const id = window.setInterval(() => setStage((s) => Math.min(s + 1, STAGES[kind].length - 1)), 2600);
    return () => window.clearInterval(id);
  }, [busy, kind]);

  const a = mine?.key === key ? mine.data : loaded.data;

  async function analyse(refresh: boolean) {
    setBusy(true);
    setError(null);
    try {
      const d = await runAiAnalysis(slug, kind, scope, ver, refresh);
      setMine({ key, data: d });
    } catch (e) {
      const limit = e instanceof AiError && e.code === "limit";
      setError({ message: e instanceof Error && e.message ? e.message : "AI hit a problem. Try again in a moment.", limit });
    } finally {
      setBusy(false);
    }
  }

  if (loaded.error && !a) return null;            // the tab's own numbers still show
  if (!a) {
    return (
      <section className="an-ai rounded-xl border border-border bg-surface p-4 sm:p-5" aria-busy>
        <Skeleton width={120} height={16} />
        <Skeleton width="70%" height={12} className="mt-3" />
      </section>
    );
  }
  if (a.state === "unsupported") return null;

  const limited = a.limit && !a.result ? a.limit : null;
  const header = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h2 id={`an-ai-${kind}`} className="m-0 flex flex-1 items-center gap-2 text-h4 text-text">
        <Sparkle />Insights
        <Badge size="sm" tone="neutral">AI</Badge>
      </h2>
      {a.state === "ready" && a.result && !busy && (
        <span className="an-ai__meta flex flex-wrap items-center gap-2 text-caption text-text-muted">
          <span>Generated {ago(a.generated_at)}</span>
          <Button variant="ghost" size="sm" iconLeft="refresh" onClick={() => analyse(true)} disabled={!!a.limit}>Re-analyse</Button>
        </span>
      )}
    </div>
  );

  return (
    <section aria-labelledby={`an-ai-${kind}`} className="an-ai flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4 sm:px-5" data-state={busy ? "running" : a.state}>
      {header}

      {a.state === "encrypted" && (
        <p className="m-0 flex items-start gap-2 text-[13px] leading-5 text-text-secondary"><Icon name="lock" size={14} className="mt-0.5 shrink-0" />{a.note}</p>
      )}

      {a.state === "thin" && a.sample && (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-[13px] leading-5 text-text-secondary">{a.note}</p>
          <div className="flex items-center gap-3">
            <span className="h-1.5 flex-1 rounded-full bg-(--chart-track)" aria-hidden>
              <span className="block h-1.5 rounded-full bg-(--chart-1)" style={{ width: `${Math.min(100, (100 * a.sample.have) / Math.max(1, a.sample.need))}%` }} />
            </span>
            <span className="text-caption text-text-muted tabular-nums">{num(a.sample.have)} of {num(a.sample.need)} sessions</span>
          </div>
        </div>
      )}

      {busy && <Running stage={STAGES[kind][stage]!} />}

      {!busy && a.state === "empty" && (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[13px] leading-5 text-text-secondary">{WHAT[kind]}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" iconLeft="sparkle" onClick={() => analyse(false)} disabled={!!limited}>Analyse</Button>
            <span className="text-caption text-text-muted">Only the numbers{kind === "versions" ? "" : " and your own content"} are sent to Claude, never anything about your readers.</span>
          </div>
        </div>
      )}

      {limited && !busy && <p className="m-0 text-caption text-text-muted" role="status">{limited.message}</p>}

      {error && !busy && (
        <Alert tone={error.limit ? "warning" : "danger"} title={error.limit ? "AI limit reached" : "Couldn't analyse it"}
          actions={!error.limit ? <Button size="sm" variant="secondary" iconLeft="refresh" onClick={() => analyse(a.state === "ready")}>Try again</Button> : undefined}>
          {error.message}
        </Alert>
      )}

      {!busy && a.state === "ready" && a.result && (
        <Result a={a} r={a.result} kind={kind} slug={slug} video={video} ver={ver} onMoment={onMoment} activeT={activeT} />
      )}
    </section>
  );
}

function Running({ stage }: { stage: string }) {
  return (
    <div className="flex flex-col gap-3" role="status" aria-live="polite">
      <span className="an-ai__stage flex items-center gap-2 text-[13px] text-text-secondary"><Sparkle className="an-ai__spark--busy" />{stage}</span>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <Skeleton width={90} height={18} />
          <Skeleton width="60%" height={14} />
          <Skeleton width="90%" height={12} />
        </div>
      ))}
    </div>
  );
}

function Result({ a, r, kind, slug, video, ver, onMoment, activeT }: {
  a: AiAnalysis; r: AiResult; kind: AiKind; slug: string; video: boolean; ver: number | null;
  onMoment?: (t: number) => void; activeT: number | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      {a.stale && (
        <Alert tone="info" icon="refresh">
          {kind === "content" ? "The document changed" : "The file changed"} since this analysis. Re-analyse to update it.
        </Alert>
      )}
      {r.summary && <p className="ph-no-capture m-0 text-body text-text">{r.summary}</p>}
      {r.verdict && <Verdict v={r.verdict} />}
      <ol className="ph-no-capture m-0 flex list-none flex-col gap-2.5 p-0" aria-label="Findings">
        {r.findings.map((f, i) => (
          <FindingCard key={i} f={f} kind={kind} slug={slug} video={video} ver={r.ver ?? ver} canApply={a.can_apply}
            onMoment={onMoment} active={f.t != null && activeT != null && Math.abs(f.t - activeT) < 0.5} />
        ))}
      </ol>
      {r.chapters && r.chapters.length > 1 && <Chapters chapters={r.chapters} />}
      {a.note && <p className="m-0 text-caption text-text-muted">{a.note}</p>}
    </div>
  );
}

function Where({ f, kind, slug, video, ver, onMoment, active }: {
  f: AiFinding; kind: AiKind; slug: string; video: boolean; ver: number | null; onMoment?: (t: number) => void; active: boolean;
}) {
  if (kind === "content" && f.section) {
    return <span className="an-ai__where inline-flex min-w-0 items-center gap-1 text-caption text-text-secondary"><Icon name="hash" size={12} className="shrink-0" /><span className="truncate" dir="auto">{f.section.title}</span>{f.section.lost_before_pct > 0 && <span className="shrink-0 text-text-muted">· −{pct(f.section.lost_before_pct)} reach</span>}</span>;
  }
  if (kind === "pages" && f.page) {
    return <span className="an-ai__where inline-flex items-center gap-1 text-caption text-text-secondary"><Icon name="doc" size={12} />Page {f.page}</span>;
  }
  if (kind === "versions" && f.version) {
    return <span className="an-ai__where inline-flex items-center gap-1 text-caption text-text-secondary"><Icon name="history" size={12} />Version {f.version}</span>;
  }
  if (kind === "media" && f.t != null) {
    const label = f.end != null ? `${clock(f.t)}–${clock(f.end)}` : clock(f.t);
    return (
      <button type="button" className={cx("an-ai__chip md-focus", active && "an-ai__chip--on")} aria-pressed={active}
        onClick={() => onMoment?.(f.t!)} aria-label={`Mark ${label} on the chart`}>
        {video && f.frame_t != null
          ? <FrameThumb slug={slug} t={f.frame_t} ver={ver} width={48} height={27} alt="" fallback={<Icon name="film" size={12} />} />
          : <Icon name={video ? "film" : "music"} size={12} />}
        <span className="font-mono tabular-nums">{label}</span>
      </button>
    );
  }
  return null;
}

function FindingCard({ f, kind, slug, video, ver, canApply, onMoment, active }: {
  f: AiFinding; kind: AiKind; slug: string; video: boolean; ver: number | null; canApply: boolean;
  onMoment?: (t: number) => void; active: boolean;
}) {
  const sev = SEVERITY[f.severity] ?? SEVERITY.medium;
  return (
    <li className={cx("an-ai__card flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-surface p-3 sm:p-3.5", f.severity === "high" && "an-ai__card--high")}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge size="sm" tone={sev.tone}>{sev.label}</Badge>
        <Where f={f} kind={kind} slug={slug} video={video} ver={ver} onMoment={onMoment} active={active} />
      </div>
      <h3 className="m-0 text-body-strong text-text" dir="auto">{f.title}</h3>
      {f.why && <p className="m-0 text-[13px] leading-5 text-text-secondary" dir="auto">{f.why}</p>}
      {f.suggestion && (
        <p className="m-0 flex items-start gap-1.5 text-[13px] leading-5 text-text" dir="auto">
          <Icon name="bulb" size={14} className="mt-[3px] shrink-0 text-accent-text" /><span>{f.suggestion}</span>
        </p>
      )}
      {f.rewrite && f.section && <Rewrite slug={slug} f={f} canApply={canApply} />}
    </li>
  );
}

function Rewrite({ slug, f, canApply }: { slug: string; f: AiFinding; canApply: boolean }) {
  const [open, setOpen] = useState(false);
  const section = f.section!;
  function apply() {
    const ok = storeRewrite({ slug, heading: section.title, level: section.depth, markdown: f.rewrite!, title: `Suggested rewrite of “${section.title}”` });
    if (ok) window.location.assign(applyHref(slug));
  }
  return (
    <div className="mt-1 flex flex-col gap-2">
      <button type="button" className="an-ai__toggle md-focus self-start" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />{open ? "Hide the suggested rewrite" : "Show a suggested rewrite"}
      </button>
      {open && (
        <>
          <pre className="an-ai__rewrite m-0 max-h-72 overflow-auto rounded-md border border-(--code-border) bg-(--code-bg) p-3 font-mono text-caption whitespace-pre-wrap text-text" dir="auto">{f.rewrite}</pre>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton text={f.rewrite!} label="Copy rewrite" size="sm" />
            {canApply && <Button size="sm" variant="secondary" iconLeft="edit" onClick={apply}>Apply in page</Button>}
            <span className="text-caption text-text-muted">{canApply ? "Opens the page with it offered over that section. Nothing changes until you accept." : "Paste it over the section's text when you next edit."}</span>
          </div>
        </>
      )}
    </div>
  );
}

function Chapters({ chapters }: { chapters: { t: number; title: string }[] }) {
  const text = chapters.map((c) => `${clock(c.t)} ${c.title}`).join("\n");
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-surface-inset p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 flex-1 text-body-strong text-text">Suggested chapters</h3>
        <CopyButton text={text} label="Copy chapters" size="sm" />
      </div>
      <ol className="ph-no-capture m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
        {chapters.map((c) => (
          <li key={c.t} className="flex gap-3"><span className="w-12 shrink-0 font-mono text-text-muted tabular-nums">{clock(c.t)}</span><span className="min-w-0 text-text" dir="auto">{c.title}</span></li>
        ))}
      </ol>
    </div>
  );
}

const CONF: Record<"high" | "medium" | "low", { tone: Tone; label: string }> = {
  high: { tone: "success", label: "High confidence" },
  medium: { tone: "info", label: "Medium confidence" },
  low: { tone: "warning", label: "Low confidence" },
};

function Verdict({ v }: { v: NonNullable<AiResult["verdict"]> }) {
  const c = CONF[v.confidence.level];
  const fmt = (x: number) => (v.unit === "seconds" ? secs(x) : pct(x));
  return (
    <div className="an-ai__verdict flex flex-col gap-2 rounded-lg border border-border p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="success" size="sm" icon="checkCircle">Version {v.winner}</Badge>
        <Badge tone={c.tone} size="sm">{c.label}</Badge>
      </div>
      <h3 className="m-0 text-h4 text-text">{v.headline}</h3>
      <p className="m-0 text-[13px] leading-5 text-text-secondary">
        {v.metric}: <strong className="text-text tabular-nums">{fmt(v.value)}</strong> over {num(v.sessions)} sessions
        {v.runner_up && <> vs <strong className="text-text tabular-nums">{fmt(v.runner_up.value)}</strong> for version {v.runner_up.version} ({num(v.runner_up.sessions)} sessions)</>}.
        {v.explanation ? ` ${v.explanation}` : ""}
      </p>
      <p className="m-0 flex items-start gap-1.5 text-caption text-text-muted"><Icon name="info" size={12} className="mt-0.5 shrink-0" />{v.confidence.note} Markdrop computes this from the numbers, not the AI.</p>
    </div>
  );
}
