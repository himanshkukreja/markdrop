"use client";

/**
 * Analytics AI on the analytics home (lib/analyticsAi.ts; backend services/analytics_ai_home.py):
 *
 *  - ✦ Insights: what changed in the period and the likely cause, in 3-5 bullets that link to where
 *    to look (cached for the day; Refresh writes it again).
 *  - Ask your analytics: a question in plain words, answered from a fixed set of server-side queries
 *    over your own documents. The answer streams as plain text; the final answer's links are only
 *    ever the analytics pages the server returned.
 *  - Write this next: what people searched for in your workspace or asked your guides and didn't
 *    find, grouped into pages worth writing, each with "Create page from this outline". Shown only to
 *    a workspace's owners and admins, or to someone with personal Guides.
 *
 * Hidden entirely when Analytics AI is switched off or not set up on this server.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Anchor, Badge, Button, Icon, Select, Spinner, useToast } from "@/components/ui";
import { createPage } from "@/lib/pages";
import { rememberSecret } from "@/components/pages/TemplateGallery";
import {
  aiStatus, askAnalytics, getGaps, getStory, linkSegments, storyRangeOf,
  type AnalyticsAiStatus, type AnalyticsAskEvent, type AskLink, type Gap, type Gaps, type Story,
} from "@/lib/analyticsAi";
import { Panel, Quiet } from "./parts";

const HIDDEN = new Set(["off", "not_configured", "blocked"]);

export default function AnalyticsAI({ range }: { range: string }) {
  const [status, setStatus] = useState<AnalyticsAiStatus | null>(null);
  useEffect(() => {
    let live = true;
    aiStatus().then((s) => { if (live) setStatus(s); }).catch(() => { if (live) setStatus(null); });
    return () => { live = false; };
  }, []);
  if (!status || (status.reason && HIDDEN.has(status.reason))) return null;
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="analytics-ai">
      <InsightsCard range={range} status={status} />
      {status.gap_scopes.length > 0 && <WriteThisNext status={status} />}
    </div>
  );
}

/* ── ✦ Insights: the story and the Ask box ─────────────────────────────── */

function InsightsCard({ range, status }: { range: string; status: AnalyticsAiStatus }) {
  const sr = storyRangeOf(range);
  const [story, setStory] = useState<Story | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (fresh: boolean) => {
    setLoading(true);
    setFailed(false);
    try {
      setStory(await getStory(sr, fresh));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [sr]);

  useEffect(() => { void load(false); }, [load]);

  const periodWord = sr === "7d" ? "this week" : sr === "30d" ? "the last 30 days" : "the last 90 days";
  return (
    <Panel id="ah-ai" icon="sparkle" title="Insights" className="ph-no-capture"
      aside={story?.status === "ok" ? `${periodWord} vs the period before${story.cached ? " · from earlier today" : ""}` : undefined}
      headerExtra={story?.status === "ok" || story?.status === "error" || failed ? (
        <Button variant="ghost" size="sm" iconLeft="refresh" loading={loading} onClick={() => void load(true)}
          aria-label="Refresh the insights">Refresh</Button>
      ) : null}>
      <div aria-live="polite" aria-busy={loading}>
        {loading && !story ? <StorySkeleton /> : failed ? (
          <Quiet>Couldn&apos;t load the insights. <button type="button" className="md-focus cursor-pointer border-0 bg-transparent p-0 text-accent-text underline" onClick={() => void load(false)}>Try again</button></Quiet>
        ) : story?.status === "ok" ? (
          <div className="flex flex-col gap-2">
            <p className="m-0 text-[15px] leading-6 font-semibold text-text" data-testid="ai-story-headline">{story.headline}</p>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="ai-story">
              {(story.bullets || []).map((b, i) => (
                <li key={i} className="flex items-start gap-2 text-[13px] leading-5 text-text-secondary">
                  <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-accent" />
                  <span className="min-w-0 flex-1">
                    {b.text}{" "}
                    <Anchor href={b.href} className="md-focus inline-flex items-center gap-0.5 rounded-sm whitespace-nowrap text-accent-text">
                      {b.doc ? "Look" : "Open"}<Icon name="arrowRight" size={12} />
                    </Anchor>
                  </span>
                </li>
              ))}
            </ul>
            <p className="m-0 text-caption text-text-muted">Written by AI from your numbers only. It can be wrong; check the link.</p>
          </div>
        ) : story ? <Quiet>{story.message}</Quiet> : null}
      </div>
      <AskBox range={range} disabled={!status.enabled} disabledMessage={status.message} />
    </Panel>
  );
}

function StorySkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      <span className="h-4 w-2/5 animate-pulse rounded bg-surface-inset" />
      {[92, 80, 68].map((w) => <span key={w} className="h-3 animate-pulse rounded bg-surface-inset" style={{ width: `${w}%` }} />)}
    </div>
  );
}

const SUGGESTIONS = ["What changed this week?", "Which link did best this month?", "Where do my readers come from?"];

interface AskState {
  status: "idle" | "running" | "done" | "limit" | "error";
  question: string;
  stage: string;
  text: string;
  answer: string;
  links: AskLink[];
  message: string;
  cached: boolean;
}
const IDLE: AskState = { status: "idle", question: "", stage: "", text: "", answer: "", links: [], message: "", cached: false };

function AskBox({ range, disabled, disabledMessage }: { range: string; disabled: boolean; disabledMessage: string | null }) {
  const [q, setQ] = useState("");
  const [st, setSt] = useState<AskState>(IDLE);
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);

  const run = (question: string, fresh = false) => {
    const text = question.trim();
    if (!text) return;
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setSt({ ...IDLE, status: "running", question: text, stage: "Looking at your numbers" });
    const on = (e: AnalyticsAskEvent) => {
      if (c.signal.aborted) return;
      setSt((s) => {
        switch (e.type) {
          case "status": return { ...s, stage: e.label || s.stage };
          case "delta": return { ...s, text: e.reset ? e.text : s.text + e.text };
          case "done": return { ...s, status: "done", answer: e.answer, links: e.links || [], cached: !!e.cached };
          case "limit": return { ...s, status: "limit", message: e.message };
          case "error": return { ...s, status: "error", message: e.detail };
          default: return s;
        }
      });
    };
    void askAnalytics({ question: text, range: range === "all" ? "all" : range, fresh }, on, c.signal).then(() => {
      if (c.signal.aborted) return;
      setSt((s) => (s.status === "running" ? { ...s, status: "error", message: "The answer stopped early. Try again." } : s));
    });
  };

  const allowed = new Set(st.links.map((l) => l.href));
  const shown = st.status === "done" ? st.answer : st.text;
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); run(q); }} role="search" aria-label="Ask your analytics">
        <label htmlFor="ah-ask" className="md-visually-hidden">Ask about your analytics</label>
        <div className="flex min-w-0 flex-[1_1_240px] items-center gap-2 rounded-lg border border-border bg-surface-inset px-3 focus-within:border-accent">
          <Icon name="sparkle" size={14} className="shrink-0 text-text-muted" />
          <input id="ah-ask" value={q} onChange={(e) => setQ(e.target.value)} maxLength={500} disabled={disabled}
            placeholder={disabled ? (disabledMessage || "AI isn't available right now.") : "Ask your analytics, e.g. where did Tuesday's spike come from?"}
            className="min-w-0 flex-1 border-0 bg-transparent py-2 text-[14px] text-text outline-none placeholder:text-text-muted pointer-coarse:min-h-11" data-testid="ai-ask-input" />
        </div>
        <Button type="submit" size="sm" variant="secondary" disabled={disabled || !q.trim()} loading={st.status === "running"} className="pointer-coarse:min-w-11" data-testid="ai-ask-submit">Ask</Button>
      </form>
      {st.status === "idle" && !disabled && (
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" onClick={() => { setQ(s); run(s); }}
              className="md-focus cursor-pointer rounded-full border border-border bg-transparent px-2.5 py-1 text-caption text-text-secondary hover:border-accent hover:text-text pointer-coarse:min-h-11">{s}</button>
          ))}
        </div>
      )}
      {st.status !== "idle" && (
        <div className="rounded-lg bg-surface-inset px-3 py-2.5 text-[13px] leading-5 text-text" aria-live="polite" aria-busy={st.status === "running"} data-testid="ai-ask-answer">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-caption text-text-muted">
            <span className="font-semibold text-text-secondary" dir="auto">{st.question}</span>
            {st.status === "running" && <span className="inline-flex items-center gap-1"><Spinner size={12} />{st.stage}…</span>}
            {st.cached && <span>· from earlier today <button type="button" className="md-focus cursor-pointer border-0 bg-transparent p-0 text-accent-text underline" onClick={() => run(st.question, true)}>Ask again</button></span>}
          </div>
          {st.status === "limit" || st.status === "error" ? (
            <p className="m-0 text-text-secondary">{st.message}</p>
          ) : shown ? (
            <AnswerText text={shown} allowed={st.status === "done" ? allowed : new Set()} />
          ) : <span className="text-text-muted">…</span>}
          {st.status === "done" && <p className="mt-1.5 mb-0 text-caption text-text-muted">AI can be wrong. Numbers come from your own analytics; check the linked pages.</p>}
        </div>
      )}
    </div>
  );
}

/** Paragraphs, "- " lists, **bold**, and links only to the analytics pages the server returned. */
function AnswerText({ text, allowed }: { text: string; allowed: Set<string> }) {
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const inline = (s: string) => linkSegments(s, allowed).map((seg, i) => seg.href
    ? <Anchor key={i} href={seg.href} className="md-focus rounded-sm text-accent-text">{seg.text}</Anchor>
    : <Bold key={i} text={seg.text} />);
  return (
    <div className="flex flex-col gap-1.5">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return <ul key={i} className="m-0 pl-5">{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-*]\s+/, ""))}</li>)}</ul>;
        }
        return <p key={i} className="m-0">{inline(lines.join(" "))}</p>;
      })}
    </div>
  );
}

function Bold({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*\n]+\*\*)/g);
  return <>{parts.map((p, i) => (p.startsWith("**") && p.endsWith("**") && p.length > 4 ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p.replace(/_\((.*)\)_/, "($1)")}</span>))}</>;
}

/* ── Write this next: content gaps ─────────────────────────────────────── */

function WriteThisNext({ status }: { status: AnalyticsAiStatus }) {
  const [scope, setScope] = useState(status.gap_scopes[0].scope);
  const [data, setData] = useState<Gaps | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (fresh: boolean) => {
    setLoading(true);
    setFailed(false);
    try {
      setData(await getGaps(scope, fresh));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [scope]);
  useEffect(() => { void load(false); }, [load]);

  return (
    <Panel id="ah-gaps" icon="bulb" title="Write this next" className="ph-no-capture"
      aside={data ? `what people couldn't find, last ${data.days} days` : undefined}
      headerExtra={
        <div className="flex flex-wrap items-center gap-2">
          {status.gap_scopes.length > 1 && (
            <Select aria-label="Where to look" value={scope} onChange={(e) => setScope(e.target.value)} className="!h-8 !py-0 text-[13px]"
              options={status.gap_scopes.map((s) => ({ value: s.scope, label: s.label }))} />
          )}
          {data?.status === "ok" && <Button variant="ghost" size="sm" iconLeft="refresh" loading={loading} onClick={() => void load(true)} aria-label="Refresh the gaps">Refresh</Button>}
        </div>
      }>
      <div aria-live="polite" aria-busy={loading} data-testid="ai-gaps">
        {loading && !data ? <StorySkeleton /> : failed ? (
          <Quiet>Couldn&apos;t load the gaps. <button type="button" className="md-focus cursor-pointer border-0 bg-transparent p-0 text-accent-text underline" onClick={() => void load(false)}>Try again</button></Quiet>
        ) : data?.status === "ok" ? (
          data.gaps.length ? (
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3 p-0">
              {data.gaps.map((g) => <GapCard key={g.topic} gap={g} workspace={data.create.workspace} />)}
            </ul>
          ) : <Quiet>Nothing clusters into a page yet. Searches and questions people couldn&apos;t answer will show up here.</Quiet>
        ) : data ? <Quiet>{data.message}</Quiet> : null}
        {data?.status === "ok" && <p className="mt-2 mb-0 text-caption text-text-muted">Grouped by AI from anonymous search and question text. Nobody&apos;s name is kept with a search.</p>}
      </div>
    </Panel>
  );
}

function GapCard({ gap, workspace }: { gap: Gap; workspace: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const created = await createPage({ title: gap.topic.slice(0, 200), workspace, content: gap.markdown });
      rememberSecret(created);
      router.push(`/${encodeURIComponent(created.document.slug)}?edit=1`);
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : "Couldn't create the page. Try again.");
      setBusy(false);
    }
  }

  const counts = [gap.searches ? `${gap.searches} search${gap.searches === 1 ? "" : "es"}` : null,
    gap.questions ? `${gap.questions} question${gap.questions === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ");
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg border border-border px-3.5 py-3" data-testid="ai-gap">
      <div className="flex items-start gap-2">
        <strong className="min-w-0 flex-1 text-[14px] leading-5 text-text" dir="auto">{gap.topic}</strong>
        <Badge tone="info" size="sm">{gap.count}×</Badge>
      </div>
      {gap.why && <p className="m-0 text-[13px] leading-5 text-text-secondary">{gap.why}</p>}
      <p className="m-0 text-caption text-text-muted">{counts}{gap.guides.length ? ` · ${gap.guides.join(", ")}` : ""}</p>
      {gap.examples.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0" aria-label="What people typed">
          {gap.examples.slice(0, 4).map((x) => <li key={x} className="max-w-full truncate rounded-full bg-surface-inset px-2 py-0.5 text-caption text-text-secondary" dir="auto">{x}</li>)}
        </ul>
      )}
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className="md-focus flex cursor-pointer items-center gap-1 self-start border-0 bg-transparent p-0 text-caption text-text-secondary hover:text-text">
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />Outline ({gap.outline.length} sections)
      </button>
      {open && <ol className="m-0 pl-5 text-[13px] leading-5 text-text-secondary">{gap.outline.map((h) => <li key={h}>{h}</li>)}</ol>}
      <Button variant="secondary" size="sm" iconLeft="plus" loading={busy} onClick={() => void create()} className="mt-auto self-start" data-testid="ai-gap-create">
        Create page from this outline
      </Button>
    </li>
  );
}
