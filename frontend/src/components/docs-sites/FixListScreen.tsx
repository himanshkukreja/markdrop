"use client";

/**
 * /guides/<site>/fixes: the Fix list. One ranked list of what to fix next in the guide, from what
 * its readers (and the AI agents reading it) run into: where readers leave a page, searches that
 * find nothing, questions Ask AI couldn't answer, pages marked not helpful, the moment a video or a
 * PDF loses its readers, broken links, stale and heavy pages, and pages agents can't use. Ranked by
 * impact (readers affected x severity x recency); each item opens a drawer with its evidence, an
 * AI-drafted fix ("Open in editor" offers it as a suggestion over the section; nothing is published),
 * and Start / Mark fixed / Dismiss. Backend: services/guide_fixes.py.
 *
 * Before there is anything to rank, the screen says why (Insights off, not published, no readers
 * yet) and what it watches, and offers a sample list (fictional Acme data, ?sample=1) so the value
 * is visible before traffic. Readers' and agents' words (queries, comments) are the customer's
 * content: every list of them is ph-no-capture.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { useRouter } from "next/navigation";
import {
  Alert, Badge, Button, Dialog, Disclosure, Drawer, EmptyState, Icon, RadioGroup, Select, Skeleton, Tabs, Textarea,
  Tooltip, copyText, cx, useToast,
} from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { LoadError, useLoad, useParams } from "@/components/analytics/parts";
import { createPage, docsErrorMessage, updateSite } from "@/lib/docsSites";
import {
  checkFixes, draftFix, fixApplied, getFix, getFixes, setFixStatus,
  type DismissReason, type DropPoint, type FixDraft, type FixItem, type FixList, type FixStatus, type FixStatusFilter, type FixType, type PdfPoint,
} from "@/lib/guideFixes";
import { guideEvents } from "@/lib/guidesEvents";
import { num, plural, timeAgo } from "./format";
import {
  CONFIDENCE_META, DISMISS_REASONS, FIX_TYPES, LEVEL_META, STATUS_META, TYPE_META, clock, demoExtras, demoItems, diffCounts, diffLines,
  draftLabel, draftUsesAi, editorHref, familyShares, impactWidth, pendingPct, pendingWords, readersWords, retentionPoints,
} from "./fixesModel";
import SiteBar from "./SiteBar";
import { useSite } from "./SiteContext";

const STATUS_TABS: { value: FixStatusFilter; label: string }[] = [
  { value: "active", label: "To fix" },
  { value: "fixed", label: "Fixed" },
  { value: "dismissed", label: "Dismissed" },
  { value: "all", label: "All" },
];
const isStatus = (v: string | null): v is FixStatusFilter => !!v && STATUS_TABS.some((t) => t.value === v);
const isType = (v: string | null): v is FixType => !!v && (FIX_TYPES as string[]).includes(v);

/* ── Small pieces ─────────────────────────────────────────────────────── */

function TypeTile({ type, level, size = 36 }: { type: FixType; level?: FixItem["level"]; size?: number }) {
  const tone = level === "high" ? "bg-danger-soft text-danger" : level === "medium" ? "bg-warning-soft text-warning" : "bg-accent-soft text-accent-text";
  return (
    <span className={cx("grid shrink-0 place-items-center rounded-[10px]", tone)} style={{ width: size, height: size }} aria-hidden>
      <Icon name={TYPE_META[type].icon} size={Math.round(size * 0.47)} />
    </span>
  );
}

function Section({ id, title, aside, children, className }: { id: string; title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={cx("flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4 sm:p-5", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id={id} className="m-0 flex-1 text-[16px] font-semibold leading-6 text-text">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: string; note?: React.ReactNode; tone?: "danger" | "success" | "muted" }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-surface p-3 sm:p-4">
      <span className="text-caption text-text-muted">{label}</span>
      <strong className="text-[22px] font-bold leading-7 tracking-[-0.01em] text-text tabular-nums sm:text-[26px] sm:leading-8">{value}</strong>
      {note && <span className={cx("text-caption", tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-text-muted")}>{note}</span>}
    </div>
  );
}

/* ── A row ────────────────────────────────────────────────────────────── */

function FixRow({ item, max, onOpen }: { item: FixItem; max: number; onOpen: () => void }) {
  const level = LEVEL_META[item.level];
  const st = STATUS_META[item.status];
  const where = item.page_title || item.path;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="md-focus group flex w-full flex-wrap items-start gap-x-3.5 gap-y-2 rounded-xl border border-border bg-surface p-3.5 text-left transition-colors hover:border-border-strong hover:bg-surface-hover sm:flex-nowrap sm:p-4"
      >
        <TypeTile type={item.type} level={item.level} />
        <span className="flex min-w-0 flex-[1_1_240px] flex-col gap-1">
          <span className="text-micro font-semibold uppercase tracking-[0.04em] text-text-muted">{TYPE_META[item.type].label}</span>
          <strong className="ph-no-capture break-words text-body-strong text-text" dir="auto">{item.title}</strong>
          <span className="ph-no-capture line-clamp-2 text-[13px] leading-5 text-text-secondary">{item.summary}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-text-muted">
            {where && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <Icon name="doc" size={12} className="shrink-0" />
                <span className="truncate" title={item.path ?? undefined}>{where}{item.section_title && item.type === "drop" ? ` › ${item.section_title}` : ""}</span>
              </span>
            )}
            {item.detected_at && <span>Found {timeAgo(item.detected_at)}</span>}
            {item.confidence !== "high" && <span title={CONFIDENCE_META[item.confidence].hint}>{CONFIDENCE_META[item.confidence].label}</span>}
            {item.reopened > 0 && item.status === "open" && <span className="text-warning">Came back</span>}
            {item.has_draft && item.status !== "fixed" && <span className="inline-flex items-center gap-1 text-accent-text"><Icon name="sparkle" size={12} />Draft ready</span>}
          </span>
        </span>
        <span className="flex w-full shrink-0 items-center gap-2.5 sm:w-[168px] sm:flex-col sm:items-end sm:gap-1.5">
          {item.status === "open"
            ? <Badge tone={level.tone} size="sm">{level.label}</Badge>
            : <Badge tone={st.tone} size="sm" icon={st.icon}>{st.label}</Badge>}
          <span className="flex min-w-0 flex-1 items-center gap-2 sm:w-full sm:flex-none">
            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-inset" aria-hidden>
              <span className={cx("block h-full rounded-full", item.level === "high" ? "bg-danger" : item.level === "medium" ? "bg-warning" : "bg-accent")}
                style={{ width: impactWidth(item.impact, max) }} />
            </span>
          </span>
          <span className="text-caption tabular-nums text-text-secondary sm:text-right">{readersWords(item.type, item.readers)}</span>
        </span>
      </button>
    </li>
  );
}

function RowsSkeleton() {
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <li key={i} className="flex items-start gap-3.5 rounded-xl border border-border bg-surface p-4">
          <Skeleton variant="rect" width={36} height={36} />
          <span className="flex flex-1 flex-col gap-2"><Skeleton width="30%" height={10} /><Skeleton width="70%" height={16} /><Skeleton width="90%" height={12} /></span>
        </li>
      ))}
    </ul>
  );
}

/* ── Evidence ─────────────────────────────────────────────────────────── */

function DropChart({ curve, section }: { curve: DropPoint[]; section: string | null }) {
  return (
    <ol className="ph-no-capture m-0 flex list-none flex-col gap-1.5 p-0" aria-label="How far readers got down the page">
      {curve.map((p) => {
        const flagged = (section === null ? p.i === -1 : p.id === section) && p.left_pct > 0;
        return (
          <li key={p.i} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
            <span className={cx("truncate text-[13px]", flagged ? "font-semibold text-text" : "text-text-secondary")}>{p.title}</span>
            <span className={cx("text-caption tabular-nums", flagged ? "font-semibold text-danger" : "text-text-muted")}>
              {p.reached_pct}%{flagged ? ` · ${p.left_pct}% left here` : ""}
              <span className="md-visually-hidden"> of readers reached it</span>
            </span>
            <span className="col-span-2 h-2 overflow-hidden rounded-full bg-surface-inset" aria-hidden>
              <span className={cx("block h-full rounded-full", flagged ? "bg-danger" : "bg-accent")} style={{ width: `${Math.max(2, p.reached_pct)}%` }} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function RetentionChart({ curve, length, at, uid }: { curve: number[]; length: number; at: number; uid: string }) {
  const pts = retentionPoints(curve, length);
  const W = 320, H = 120, padL = 30, padB = 18;
  const x = (s: number) => padL + (length ? (s / length) * (W - padL - 6) : 0);
  const y = (v: number) => 6 + (1 - v / 100) * (H - padB - 6);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts[pts.length - 1]?.x ?? 0).toFixed(1)},${y(0)} L${x(pts[0]?.x ?? 0).toFixed(1)},${y(0)} Z`;
  return (
    <figure className="m-0 flex flex-col gap-1.5">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-labelledby={`${uid}-ret`}>
        <title id={`${uid}-ret`}>{`Viewers still watching over the video's ${clock(length)}: most stop around ${clock(at)}.`}</title>
        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - 6} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeDasharray={v ? "3 3" : undefined} />
            <text x={padL - 6} y={y(v) + 3.5} textAnchor="end" fontSize="9" fill="var(--text-muted)">{v}%</text>
          </g>
        ))}
        <path d={area} fill="var(--accent)" opacity="0.12" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
        <line x1={x(at)} x2={x(at)} y1={6} y2={y(0)} stroke="var(--danger)" strokeWidth="1.5" strokeDasharray="4 3" />
        <text x={Math.min(W - 30, x(at) + 4)} y={16} fontSize="10" fontWeight="600" fill="var(--danger)">{clock(at)}</text>
        <text x={padL} y={H - 4} fontSize="9" fill="var(--text-muted)">0:00</text>
        <text x={W - 6} y={H - 4} textAnchor="end" fontSize="9" fill="var(--text-muted)">{clock(length)}</text>
      </svg>
    </figure>
  );
}

function PdfChart({ curve, page }: { curve: PdfPoint[]; page: number }) {
  return (
    <div className="flex h-[120px] items-end gap-1" role="img" aria-label={`Readers still reading, page by page: most stop at page ${page}.`}>
      {curve.slice(0, 40).map((p) => (
        <span key={p.page} className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <span className={cx("w-full rounded-t-[3px]", p.page === page ? "bg-danger" : "bg-accent opacity-70")} style={{ height: `${Math.max(3, p.reached_pct)}px` }} />
          <span className={cx("text-[10px] tabular-nums", p.page === page ? "font-semibold text-danger" : "text-text-muted")}>{p.page}</span>
        </span>
      ))}
    </div>
  );
}

function Quotes({ rows, icon }: { rows: { text: string; n?: number }[]; icon: string }) {
  return (
    <ul className="ph-no-capture m-0 flex list-none flex-col gap-1.5 p-0">
      {rows.map((r, i) => (
        <li key={`${r.text}-${i}`} className="flex items-start gap-2.5 rounded-md bg-surface-inset px-2.5 py-2 text-body">
          <Icon name={icon} size={14} className="mt-[3px] shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1 break-words text-text" dir="auto">{r.text}</span>
          {r.n != null && r.n > 1 && <span className="shrink-0 text-caption tabular-nums text-text-muted">{num(r.n)}×</span>}
        </li>
      ))}
    </ul>
  );
}

function Evidence({ item, uid }: { item: FixItem; uid: string }) {
  const ev = item.evidence;
  switch (item.type) {
    case "drop":
      return (
        <>
          <p className="m-0 text-body text-text-secondary">
            Of {num(ev.measured ?? 0)} measured readers, <strong className="text-text">{ev.left_pct}%</strong> stopped at this section. Elsewhere on the page about {ev.typical_pct}% stop per section.
            {ev.seconds ? ` Readers spent ${clock(ev.seconds)} on the page on average.` : ""}
          </p>
          {Array.isArray(ev.curve) && <DropChart curve={ev.curve as DropPoint[]} section={item.section} />}
        </>
      );
    case "video":
      return (
        <>
          <p className="m-0 text-body text-text-secondary">
            Played {plural(ev.plays ?? 0, "time")}. <strong className="text-text">{ev.fall_pct}%</strong> of viewers stop around {clock(ev.at ?? 0)}, where
            {" "}{ev.typical_pct ?? 0}% would be usual for this video.{ev.embed ? " An embedded Markdrop video." : ""}
          </p>
          {Array.isArray(ev.curve) && <RetentionChart curve={ev.curve as number[]} length={ev.length ?? 0} at={ev.at ?? 0} uid={uid} />}
        </>
      );
    case "pdf":
      return (
        <>
          <p className="m-0 text-body text-text-secondary">
            {num(ev.readers_pdf ?? 0)} readers opened “{ev.name}”. <strong className="text-text">{ev.left_pct}%</strong> go no further than page {ev.page} of {ev.pages_total}.
          </p>
          {Array.isArray(ev.curve) && <PdfChart curve={ev.curve as PdfPoint[]} page={ev.page ?? 0} />}
        </>
      );
    case "search":
    case "agent_unanswered":
    case "ask":
      return (
        <>
          <p className="m-0 text-body text-text-secondary">
            {item.type === "ask" ? `Asked ${plural(ev.questions ?? 0, "time")}` : `${plural(ev.searches ?? 0, "search", "searches")} found nothing`}
            {(ev.samples?.length ?? 0) > 1 ? `, grouped from ${ev.samples!.length} wordings that mean the same thing:` : ":"}
            {item.type === "agent_unanswered" ? " AI assistants asked through the docs MCP server." : ""}
          </p>
          <Quotes rows={ev.samples ?? []} icon={item.type === "search" ? "search" : item.type === "ask" ? "sparkle" : "terminal"} />
          {!!ev.pages?.length && <p className="m-0 text-caption text-text-muted">Asked on {ev.pages.map((p) => p.title).join(", ")}.</p>}
        </>
      );
    case "not_helpful":
      return (
        <>
          <div className="flex items-center gap-3">
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-danger-soft" aria-hidden>
              <span className="block h-full rounded-full bg-success" style={{ width: `${ev.helpful_pct ?? 0}%` }} />
            </span>
            <span className="text-caption tabular-nums text-text-secondary">{ev.helpful_pct}% helpful · {num(ev.yes ?? 0)} yes, {num(ev.no ?? 0)} no</span>
          </div>
          {ev.comments?.length ? <Quotes rows={ev.comments.map((c) => ({ text: c.text }))} icon="message" /> : <p className="m-0 text-caption text-text-muted">No comments, just votes.</p>}
        </>
      );
    case "broken":
      return (
        <>
          <p className="m-0 text-body text-text-secondary">
            <code className="rounded bg-surface-inset px-1 py-0.5 text-[13px]">{ev.target}</code> isn’t a page in this guide.
            {ev.hits ? ` Readers hit it ${plural(ev.hits, "time")}.` : " Nobody has clicked it yet, but it’s in a published page."}
            {ev.suggested ? <> It looks like <code className="rounded bg-surface-inset px-1 py-0.5 text-[13px]">{ev.suggested}</code> was meant.</> : ""}
          </p>
          {!!ev.pages?.length && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px] text-text-secondary">
              {ev.pages.map((p) => <li key={p.path}>{p.link ? "Linked from" : "Readers came from"} {p.title}{p.hits ? ` (${p.hits})` : ""}</li>)}
            </ul>
          )}
        </>
      );
    case "stale":
      return <p className="m-0 text-body text-text-secondary">Last edited {ev.updated_at ? timeAgo(ev.updated_at) : "a long time ago"} ({num(ev.age_days ?? 0)} days), and {plural(ev.readers ?? 0, "reader")} opened it in the last 30 days.</p>;
    case "heavy":
      return <p className="m-0 text-body text-text-secondary">{num(ev.words ?? 0)} words and {num(ev.media ?? 0)} images and videos. Long pages are slow on phones, and readers can’t find what they came for.</p>;
    case "agent_unfriendly":
      return (
        <>
          <p className="m-0 text-body text-text-secondary">
            Read by AI agents {plural(ev.agent_reads ?? 0, "time")}{ev.via?.markdown ? `, ${num(ev.via.markdown)} of them as Markdown` : ""}.
            {" "}{ev.reason === "hidden" ? "It’s hidden, so it isn’t in llms.txt." : ev.reason === "media" ? `Most of it is images or video, with ${num(ev.words ?? 0)} words of text.` : `${num(ev.words ?? 0)} words and no headings.`}
          </p>
          {!!ev.families?.length && (
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {familyShares(ev.families).map((f) => <li key={f.name}><Badge size="sm">{f.name} {f.pct}%</Badge></li>)}
            </ul>
          )}
        </>
      );
  }
}

/* ── The drafted fix ──────────────────────────────────────────────────── */

function DiffView({ draft }: { draft: FixDraft }) {
  const lines = useMemo(() => diffLines(draft.before || "", draft.after || ""), [draft.before, draft.after]);
  const { added, removed } = diffCounts(lines);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-caption text-text-muted">
        <span className="text-success">+{added}</span> <span className="text-danger">−{removed}</span> lines
        {draft.heading ? ` in “${draft.heading}”` : draft.kind === "section" ? " in the introduction" : ""}
      </span>
      <pre className="ph-no-capture m-0 max-h-[340px] overflow-auto rounded-lg border border-border bg-surface-inset p-0 text-[12.5px] leading-[1.55]" aria-label="Suggested change, line by line">
        {lines.map((l, i) => (
          <div key={i} className={cx("whitespace-pre-wrap break-words px-3", l.op === "+" ? "bg-success-soft text-text" : l.op === "-" ? "bg-danger-soft text-text-secondary line-through decoration-danger/40" : "text-text-secondary")}>
            <span className="mr-2 inline-block w-3 select-none text-text-muted" aria-hidden>{l.op === " " ? "" : l.op === "+" ? "+" : "−"}</span>
            <span className="md-visually-hidden">{l.op === "+" ? "Added: " : l.op === "-" ? "Removed: " : ""}</span>
            {l.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

const DEMO_DRAFT: FixDraft = {
  kind: "section", heading: "Sign in", section: "sign-in", depth: 2,
  before: "## Sign in\n\nRun `acme login` and paste the code from your browser. If it fails, check your network and try again.",
  after: "## Sign in\n\n1. Run `acme login`. Your browser opens.\n2. Paste the code it shows into the terminal.\n\n:::note[Behind a corporate proxy?]\nSet `HTTPS_PROXY` before you run `acme login`: [Add the proxy steps]\n:::",
  summary: "Splits sign-in into two steps and answers the proxy question readers kept asking.",
};

/* ── The drawer ───────────────────────────────────────────────────────── */

function FixDrawer({ item: base, demo, open, onClose, onChanged }: {
  item: FixItem | null; demo: boolean; open: boolean; onClose: () => void; onChanged: (it: FixItem) => void;
}) {
  const { site, base: siteBase, canEdit } = useSite();
  const router = useRouter();
  const toast = useToast();
  const uid = useId();
  const [full, setFull] = useState<FixItem | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [demoDraft, setDemoDraft] = useState(false);

  useEffect(() => {
    setFull(null);
    setDraftError("");
    setDemoDraft(false);
    if (!base || demo || !open) return;
    let live = true;
    getFix(site.id, base.id).then((f) => live && setFull(f)).catch(() => {});
    return () => { live = false; };
  }, [base, demo, open, site.id]);

  const item = full ?? base;
  if (!item) return <Drawer open={false} onClose={onClose} title="" />;
  const draft = demo ? (demoDraft ? DEMO_DRAFT : null) : item.draft ?? null;
  const editable = canEdit && !demo;
  const where = item.page_title || item.path;

  async function makeDraft() {
    if (demo) { setDemoDraft(true); return; }
    setDrafting(true);
    setDraftError("");
    try {
      const got = await draftFix(site.id, item!);
      setFull(got);
      onChanged(got);
    } catch (e) {
      setDraftError(docsErrorMessage(e));
    } finally {
      setDrafting(false);
    }
  }

  async function status(s: FixStatus, reason?: DismissReason, note?: string) {
    setBusy(s);
    try {
      const got = await setFixStatus(site.id, item!, s, reason, note);
      setFull(got);
      onChanged(got);
      toast.success(s === "fixed" ? "Marked fixed. If it comes back, it reopens." : s === "dismissed" ? "Dismissed." : s === "in_progress" ? "Started." : "Reopened.");
      if (s === "dismissed" || s === "fixed") onClose();
    } catch (e) {
      toast.error(docsErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function createFromDraft(d: FixDraft) {
    setBusy("create");
    try {
      const page = await createPage(site.id, { path: d.path || "/new-page", title: d.title || "New page", markdown: d.after });
      const got = await fixApplied(site.id, item!.id, page.id);
      guideEvents.fixApplied(item!.type, "new_page");
      onChanged(got);
      router.push(`${siteBase}?page=${encodeURIComponent(page.id)}`);
    } catch (e) {
      toast.error(docsErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const usesAi = draftUsesAi(item.type, item.evidence.reason);
  const footer = editable ? (
    <div className="flex w-full flex-wrap items-center gap-2">
      {item.status === "open" && <Button size="sm" variant="secondary" iconLeft="edit" loading={busy === "in_progress"} onClick={() => void status("in_progress")}>Start</Button>}
      {(item.status === "open" || item.status === "in_progress") && <Button size="sm" variant="secondary" iconLeft="check" loading={busy === "fixed"} onClick={() => void status("fixed")}>Mark fixed</Button>}
      {(item.status === "open" || item.status === "in_progress") && <Button size="sm" variant="ghost" iconLeft="x" onClick={() => setDismissing(true)}>Dismiss</Button>}
      {(item.status === "fixed" || item.status === "dismissed") && <Button size="sm" variant="secondary" iconLeft="refresh" loading={busy === "open"} onClick={() => void status("open")}>Reopen</Button>}
    </div>
  ) : demo ? <span className="text-caption text-text-muted">Sample data: actions are off.</span> : undefined;

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        width={560}
        title={<span className="flex items-center gap-2.5"><TypeTile type={item.type} level={item.level} size={28} /><span className="min-w-0">{TYPE_META[item.type].label}</span></span>}
        footer={footer}
        bodyClassName="flex flex-col gap-5"
      >
        <div className="flex flex-col gap-2">
          <h3 className="ph-no-capture m-0 text-[18px] font-semibold leading-7 text-text" dir="auto">{item.title}</h3>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={LEVEL_META[item.level].tone} size="sm">{LEVEL_META[item.level].label}</Badge>
            <Badge tone={STATUS_META[item.status].tone} size="sm" icon={STATUS_META[item.status].icon}>{STATUS_META[item.status].label}</Badge>
            <Tooltip content={CONFIDENCE_META[item.confidence].hint}><span><Badge size="sm" variant="outline">{CONFIDENCE_META[item.confidence].label}</Badge></span></Tooltip>
            {item.reopened > 0 && <Badge tone="warning" size="sm">Came back {item.reopened > 1 ? `${item.reopened}×` : ""}</Badge>}
          </div>
          <p className="ph-no-capture m-0 text-body text-text-secondary">{item.summary}</p>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
            {where && (<><dt className="text-text-muted">Page</dt><dd className="m-0 min-w-0 truncate text-text" title={item.path ?? undefined}>{where}{item.section_title && item.type === "drop" ? ` › ${item.section_title}` : ""}</dd></>)}
            <dt className="text-text-muted">Impact</dt>
            <dd className="m-0 text-text">{readersWords(item.type, item.readers)} <span className="text-text-muted">· score {item.impact}</span></dd>
            {item.detected_at && (<><dt className="text-text-muted">Found</dt><dd className="m-0 text-text">{timeAgo(item.detected_at)}{item.last_seen_at ? `, last seen ${timeAgo(item.last_seen_at)}` : ""}</dd></>)}
            {item.status === "dismissed" && item.reason && (<><dt className="text-text-muted">Why</dt><dd className="m-0 text-text">{DISMISS_REASONS.find((r) => r.value === item.reason)?.label}{item.note ? `: ${item.note}` : ""}</dd></>)}
            {item.status === "fixed" && item.fixed_by && (<><dt className="text-text-muted">Fixed</dt><dd className="m-0 text-text">{item.fixed_by === "publish" ? `Published${item.fixed_build ? ` in #${item.fixed_build}` : ""}` : item.fixed_by === "detector" ? "Not seen for a week" : "Marked fixed"}</dd></>)}
          </dl>
        </div>

        <section aria-labelledby={`${uid}-ev`} className="flex flex-col gap-3">
          <h4 id={`${uid}-ev`} className="m-0 text-micro font-semibold uppercase tracking-[0.04em] text-text-muted">Evidence</h4>
          {!full && !demo ? <Skeleton variant="rect" height={120} /> : <Evidence item={item} uid={uid} />}
        </section>

        <section aria-labelledby={`${uid}-fx`} className="flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-3.5 sm:p-4">
          <h4 id={`${uid}-fx`} className="m-0 flex items-center gap-2 text-body-strong text-text"><Icon name="sparkle" size={15} className="text-accent-text" />Suggested fix</h4>
          {draft ? (
            <>
              {draft.summary && <p className="ph-no-capture m-0 text-body text-text">{draft.summary}</p>}
              {draft.kind === "new_page" && <p className="m-0 text-[13px] text-text-secondary">A new page: <strong className="text-text">{draft.title}</strong> at <code>{draft.path}</code></p>}
              {draft.kind === "notes"
                ? <pre className="ph-no-capture m-0 max-h-[300px] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-inset p-3 text-[13px] leading-[1.55] text-text">{draft.after}</pre>
                : <DiffView draft={draft.kind === "new_page" ? { ...draft, before: "" } : draft} />}
              <div className="flex flex-wrap items-center gap-2">
                {(draft.kind === "section" || draft.kind === "append" || draft.kind === "link") && (
                  demo
                    ? <Tooltip content="Sample data"><span><Button size="sm" variant="primary" iconLeft="edit" disabled>Open in editor</Button></span></Tooltip>
                    : <Button size="sm" variant="primary" iconLeft="edit" disabled={!editable || !draft.page_id}
                        href={draft.page_id ? editorHref(siteBase, draft.page_id, item.id) : undefined}>Open in editor</Button>
                )}
                {draft.kind === "new_page" && <Button size="sm" variant="primary" iconLeft="plus" disabled={!editable} loading={busy === "create"} onClick={() => void createFromDraft(draft)}>Create the page</Button>}
                {draft.kind === "notes" && <Button size="sm" variant="secondary" iconLeft="copy" onClick={() => void copyText(draft.after).then((ok) => ok && toast.success("Copied"))}>Copy</Button>}
                {editable && usesAi && <Button size="sm" variant="ghost" iconLeft="refresh" loading={drafting} onClick={() => void makeDraft()}>Draft again</Button>}
              </div>
              <p className="m-0 text-caption text-text-muted">
                {draft.kind === "notes" ? "Advice only: nothing to apply." : "Opens as a suggestion you can edit or discard. Nothing is published until you publish."} AI can make mistakes: check it first.
              </p>
            </>
          ) : (
            <>
              <p className="m-0 text-body text-text-secondary">
                {item.type === "broken" ? "Point the link at the page it was meant for." : "Get a concrete edit drafted from this evidence, ready to review in the editor."}
              </p>
              {draftError && <Alert tone="warning">{draftError}</Alert>}
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="primary" iconLeft="sparkle" loading={drafting} disabled={!canEdit && !demo} onClick={() => void makeDraft()}>
                  {draftLabel(item.type)}
                </Button>
                {item.page_id && !demo && <Button size="sm" variant="ghost" iconLeft="doc" href={`${siteBase}?page=${encodeURIComponent(item.page_id)}`}>Open page</Button>}
              </div>
              <p className="m-0 text-caption text-text-muted">
                {!canEdit && !demo ? "Editors of this guide can draft fixes." : usesAi ? "Uses one of this guide’s monthly AI uses (shared with Ask AI)." : "Free: no AI needed."}
              </p>
            </>
          )}
        </section>

        {!!full?.history?.length && (
          <Disclosure summary={`History (${full.history.length})`}>
            <ol className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px] text-text-secondary">
              {[...full.history].reverse().map((h, i) => (
                <li key={i} className="flex gap-2"><span className="w-[92px] shrink-0 text-text-muted">{timeAgo(h.at)}</span><span>{h.note || STATUS_META[h.status].label}</span></li>
              ))}
            </ol>
          </Disclosure>
        )}
      </Drawer>
      <DismissDialog open={dismissing} busy={busy === "dismissed"} onClose={() => setDismissing(false)}
        onDismiss={(r, n) => { setDismissing(false); void status("dismissed", r, n); }} />
    </>
  );
}

function DismissDialog({ open, busy, onClose, onDismiss }: { open: boolean; busy: boolean; onClose: () => void; onDismiss: (r: DismissReason, note: string) => void }) {
  const [reason, setReason] = useState<DismissReason>("not_a_problem");
  const [note, setNote] = useState("");
  return (
    <Dialog open={open} onClose={onClose} title="Dismiss this item?" description="It leaves the list and stays dismissed, even if it's seen again."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => onDismiss(reason, note)}>Dismiss</Button></>}>
      <div className="flex flex-col gap-3">
        <RadioGroup name="fix-dismiss" aria-label="Why" value={reason} onChange={(v: string) => setReason(v as DismissReason)}
          options={DISMISS_REASONS.map((r) => ({ value: r.value, label: r.label, description: r.hint }))} />
        <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="A note for your team (optional)" aria-label="Note" />
      </div>
    </Dialog>
  );
}

/* ── Side cards ───────────────────────────────────────────────────────── */

function PendingCard({ rows, uid }: { rows: FixList["pending"]; uid: string }) {
  if (!rows.length) return null;
  return (
    <Section id={`${uid}-pend`} title="Needs more readers" aside={<span className="text-caption text-text-muted">Not judged on a tiny sample</span>}>
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {rows.map((p, i) => (
          <li key={`${p.type}-${p.title}-${i}`} className="flex flex-col gap-1">
            <span className="flex items-center gap-2 text-[13px]">
              <Icon name={TYPE_META[p.type].icon} size={13} className="shrink-0 text-text-muted" />
              <span className="min-w-0 flex-1 truncate text-text">{p.title}</span>
              <span className="shrink-0 tabular-nums text-text-muted">{pendingWords(p)}</span>
            </span>
            <span className="h-1.5 overflow-hidden rounded-full bg-surface-inset" aria-hidden>
              <span className="block h-full rounded-full bg-border-strong" style={{ width: `${pendingPct(p)}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

const VIA_WORD: Record<string, string> = { page: "Pages", markdown: "Markdown", llms: "llms.txt", mcp: "MCP" };

function AgentsCard({ agents, uid }: { agents: NonNullable<FixList["agents"]>; uid: string }) {
  if (!agents.total) {
    return (
      <Section id={`${uid}-ag`} title="AI agents">
        <p className="m-0 text-[13px] text-text-secondary">No agent reads yet. When ChatGPT, Claude, Perplexity or your readers’ tools read this guide, they show here, counted apart from people.</p>
      </Section>
    );
  }
  const shares = familyShares(agents.families);
  return (
    <Section id={`${uid}-ag`} title="AI agents" aside={<ReadMore topic="studioFixListAgents" className="text-caption">How agents are counted</ReadMore>}>
      <p className="m-0 text-[13px] text-text-secondary">
        <strong className="text-text">{num(agents.total)}</strong> agent reads in 30 days{agents.readers ? <>, next to {num(agents.readers)} readers</> : ""}. Counted apart from people.
      </p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {shares.slice(0, 5).map((f) => (
          <li key={f.name} className="grid grid-cols-[96px_minmax(0,1fr)_40px] items-center gap-2 text-[13px]">
            <span className="truncate text-text">{f.name}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-surface-inset" aria-hidden><span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(3, f.pct)}%` }} /></span>
            <span className="text-right tabular-nums text-text-muted">{f.pct}%</span>
          </li>
        ))}
      </ul>
      <p className="m-0 flex flex-wrap gap-x-3 gap-y-1 text-caption text-text-muted">
        {Object.entries(agents.via).filter(([, n]) => n).map(([k, n]) => <span key={k}>{VIA_WORD[k] ?? k} {num(n ?? 0)}</span>)}
      </p>
    </Section>
  );
}

/** What the Fix list watches: the empty state's grid. */
function Watches({ id }: { id: string }) {
  const shown: FixType[] = ["drop", "search", "ask", "not_helpful", "video", "broken", "agent_unanswered", "stale"];
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3.5">
      <h2 id={id} className="m-0 text-[18px] font-semibold leading-7 text-text">What it watches</h2>
      <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-4">
        {shown.map((t) => (
          <li key={t} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4">
            <TypeTile type={t} />
            <strong className="text-body-strong text-text">{TYPE_META[t].label}</strong>
            <span className="text-[13px] leading-5 text-text-secondary">{TYPE_META[t].watches}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PrivacyLine() {
  return (
    <p className="m-0 text-[13px] leading-5 text-text-muted">
      Built from Insights, with the same rules: no cookies, no personal data, nothing stored in readers’ browsers, nothing sent when a browser asks not to be tracked.{" "}
      <ReadMore topic="studioFixListPrivacy">What it collects</ReadMore>
    </p>
  );
}

/* ── The screen ───────────────────────────────────────────────────────── */

export default function FixListScreen() {
  const { site, setSite, isAdmin, canEdit, base } = useSite();
  const toast = useToast();
  const uid = useId();
  const [params, setParams] = useParams();
  const status: FixStatusFilter = isStatus(params.get("status")) ? (params.get("status") as FixStatusFilter) : "active";
  const type = isType(params.get("type")) ? (params.get("type") as FixType) : null;
  const path = params.get("page");
  const sample = params.get("sample") === "1";
  const [nonce, setNonce] = useState(0);
  const [patched, setPatched] = useState<Record<string, FixItem>>({});
  const [openId, setOpenId] = useState<string | null>(params.get("item"));
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const enabled = site.settings.insights?.enabled !== false;
  const load = useLoad<FixList>(sample ? null : `fix:${site.id}:${status}:${type}:${path}:${nonce}`, () => getFixes(site.id, { status, type, path }));
  const seenDemo = useRef(false);
  useEffect(() => {
    if (sample && !seenDemo.current) { seenDemo.current = true; guideEvents.fixDemo(); }
  }, [sample]);

  const demo = useMemo(() => {
    if (!sample) return null;
    const items = demoItems().map((d) => ({ ...d, applied: null, has_draft: false } as unknown as FixItem)).sort((a, b) => b.impact - a.impact);
    const x = demoExtras();
    return {
      items, counts: { open: items.length, in_progress: 0, fixed: 4, dismissed: 1 }, types: {} as FixList["types"], pages: [], checked_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
      readers: x.agents.readers, window_days: 30, can_edit: false, enabled: true, live: true, pending: x.pending, agents: x.agents,
    } satisfies FixList;
  }, [sample]);

  const data: FixList | null = demo ?? load.data;
  const items = (data?.items ?? []).map((i) => patched[i.id] ?? i).filter((i) => {
    if (status === "active") return i.status === "open" || i.status === "in_progress";
    if (status === "all") return true;
    return i.status === status;
  }).filter((i) => (!type || i.type === type) && (!path || i.path === path));
  const max = Math.max(1, ...items.map((i) => i.impact));
  const openItem = openId ? (data?.items.find((i) => i.id === openId) ? patched[openId] ?? data!.items.find((i) => i.id === openId)! : null) : null;
  const high = items.filter((i) => i.status === "open" && i.level === "high").length;

  async function recheck() {
    setChecking(true);
    try {
      const got = await checkFixes(site.id);
      setPatched({});
      setNonce((n) => n + 1);
      const s = got.stats;
      toast.success(s ? (s.new ? `Checked: ${plural(s.new, "new item")}.` : "Checked: nothing new.") : "Checked.");
    } catch (e) {
      toast.error(docsErrorMessage(e));
    } finally {
      setChecking(false);
    }
  }

  async function turnOn() {
    setSaving(true);
    try {
      setSite(await updateSite(site.id, { settings: { insights: { enabled: true } } }));
      toast.success("Insights is on. The Fix list fills in as readers arrive.");
      setNonce((n) => n + 1);
    } catch (e) {
      toast.error(docsErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const header = (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-[1_1_320px]">
        <h1 className="m-0 text-[24px] font-bold leading-8 text-text sm:text-[26px]">Fix list</h1>
        <p className="m-0 mt-0.5 text-body text-text-secondary">
          What to fix next in <span className="ph-sensitive ph-mask">{site.name}</span>, ranked by how many readers it affects.
        </p>
      </div>
      {data && !sample && (
        <div className="flex items-center gap-2.5 text-caption text-text-muted">
          {data.checked_at && <span>Checked {timeAgo(data.checked_at)}</span>}
          {canEdit && data.live && <Button size="sm" variant="secondary" iconLeft="refresh" loading={checking} onClick={() => void recheck()}>Check now</Button>}
        </div>
      )}
      {sample && <Button size="sm" variant="secondary" iconLeft="x" onClick={() => setParams({ sample: null })}>Close the sample</Button>}
    </div>
  );

  const hasAny = !!data && (Object.values(data.counts).some(Boolean) || data.items.length > 0);
  const filters = data && hasAny && (
    <div className="flex flex-wrap items-center gap-2">
      <Tabs variant="pill" size="sm" aria-label="Status" value={status} onChange={(v) => setParams({ status: v === "active" ? null : v })}
        items={STATUS_TABS.map((t) => ({ value: t.value, label: t.label, count: t.value === "active" ? (data.counts.open + data.counts.in_progress) : t.value === "all" ? undefined : data.counts[t.value as FixStatus] }))} />
      <span className="flex-1" />
      <div className="w-[190px] max-sm:flex-1">
        <Select aria-label="Type" value={type ?? ""} onChange={(e) => setParams({ type: e.target.value || null })}
          options={[{ value: "", label: "Every type" }, ...FIX_TYPES.map((t) => ({ value: t, label: TYPE_META[t].label }))]} />
      </div>
      {!!data.pages.length && (
        <div className="w-[190px] max-sm:flex-1">
          <Select aria-label="Page" value={path ?? ""} onChange={(e) => setParams({ page: e.target.value || null })}
            options={[{ value: "", label: "Every page" }, ...data.pages.map((p) => ({ value: p.path, label: `${p.title || p.path} (${p.n})` }))]} />
        </div>
      )}
    </div>
  );

  let body: React.ReactNode;
  if (load.error && !data) {
    body = <>{header}<LoadError error={load.error} retry={load.retry} what="the Fix list" /></>;
  } else if (!data) {
    body = <div className="flex flex-col gap-4" aria-busy>{header}<span className="md-visually-hidden" role="status">Loading the Fix list</span><RowsSkeleton /></div>;
  } else if (!sample && (!enabled || !data.live) && !hasAny) {
    body = (
      <>
        {header}
        <EmptyHero
          badge={!enabled ? <Badge>Insights is off</Badge> : <Badge>Not published yet</Badge>}
          title={!enabled ? "The Fix list needs Insights" : "Publish your guide to start the Fix list"}
          text={!enabled
            ? "It’s built from what Insights collects: where readers leave, what they search for, what Ask AI couldn’t answer. Turn Insights on and it fills in as readers arrive."
            : "Once readers arrive, it ranks what they run into: the section where they give up, the search that finds nothing, the question nobody answers, with a drafted fix for each."}
          action={!enabled
            ? (isAdmin ? <Button variant="primary" iconLeft="eye" loading={saving} onClick={() => void turnOn()}>Turn on Insights</Button> : <span className="text-[13px] text-text-muted">An admin of this guide can turn it on.</span>)
            : (canEdit ? <Button variant="primary" iconRight="arrowRight" href={`${base}/publish`}>Go to Publish</Button> : null)}
          onSample={() => setParams({ sample: "1" })}
        />
        <Watches id={`${uid}-w`} />
        <PrivacyLine />
      </>
    );
  } else if (!sample && !hasAny) {
    body = (
      <>
        {header}
        <EmptyHero
          badge={<Badge tone="success" dot>Watching</Badge>}
          title="Nothing to fix yet"
          text="The Fix list watches how readers and AI agents use your guide and checks every day. Problems show up here once enough readers run into them: it never flags a page on a handful of visits."
          onSample={() => setParams({ sample: "1" })}
        />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <PendingCard rows={data.pending} uid={uid} />
          {data.agents && <AgentsCard agents={data.agents} uid={uid} />}
        </div>
        <Watches id={`${uid}-w`} />
        <PrivacyLine />
      </>
    );
  } else {
    body = (
      <>
        {header}
        {sample && (
          <Alert tone="info" title="A sample Fix list">
            Fictional data for an example guide (Acme), so you can see what the Fix list shows once readers arrive. Open any item to see its evidence and a drafted fix.
          </Alert>
        )}
        {!enabled && !sample && <Alert tone="warning" title="Insights is off">Nothing new is collected, so the Fix list won’t change until it’s back on.</Alert>}
        <section aria-label="Summary" className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
          <Stat label="To fix" value={num(data.counts.open + data.counts.in_progress)} note={high ? `${high} high impact` : "None high impact"} tone={high ? "danger" : "muted"} />
          <Stat label="In progress" value={num(data.counts.in_progress)} note="Fixed when you publish" />
          <Stat label="Fixed" value={num(data.counts.fixed)} note="Reopen if they come back" tone="success" />
          <Stat label="Agent reads" value={data.agents ? num(data.agents.total) : "—"} note={data.agents?.readers ? `${num(data.agents.readers)} readers, counted apart` : "Counted apart from readers"} />
        </section>
        {filters}
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-5">
          <div className="flex min-w-0 flex-col gap-3">
            {items.length ? (
              <ul className="m-0 flex list-none flex-col gap-2.5 p-0" aria-label="Things to fix, biggest impact first">
                {items.map((i) => <FixRow key={i.id} item={i} max={max} onOpen={() => setOpenId(i.id)} />)}
              </ul>
            ) : (
              <EmptyState icon={status === "active" ? "checkCircle" : "inbox"}
                title={status === "active" ? "Nothing to fix right now" : `Nothing ${STATUS_TABS.find((t) => t.value === status)?.label.toLowerCase()}`}
                description={status === "active" ? "Everything found has been fixed or dismissed. New problems show up here after the daily check." : "Try another filter."} />
            )}
            <PrivacyLine />
          </div>
          <aside className="flex min-w-0 flex-col gap-4" aria-label="More">
            <PendingCard rows={data.pending} uid={uid} />
            {data.agents && <AgentsCard agents={data.agents} uid={uid} />}
          </aside>
        </div>
      </>
    );
  }

  return (
    <>
      <SiteBar section="fixes" />
      <main id="main" tabIndex={-1} className="mx-auto flex w-full min-w-0 max-w-[1180px] flex-col gap-4 px-4 pb-16 pt-6 outline-none sm:gap-5 sm:px-6 sm:pt-8">
        {body}
      </main>
      <FixDrawer item={openItem} demo={sample} open={!!openItem} onClose={() => setOpenId(null)}
        onChanged={(it) => setPatched((p) => ({ ...p, [it.id]: it }))} />
    </>
  );
}

function EmptyHero({ badge, title, text, action, onSample }: { badge: React.ReactNode; title: string; text: string; action?: React.ReactNode; onSample: () => void }) {
  const peek = demoItems().sort((a, b) => b.impact - a.impact).slice(0, 3);
  return (
    <section className="flex flex-wrap items-center gap-6 rounded-2xl border border-border bg-surface p-5 sm:gap-9 sm:p-8">
      <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-3">
        <div>{badge}</div>
        <h2 className="m-0 text-[24px] font-bold leading-8 text-text sm:text-[28px] sm:leading-9">{title}</h2>
        <p className="m-0 text-[15px] leading-6 text-text-secondary">{text}</p>
        <div className="flex flex-wrap items-center gap-2">
          {action}
          <Button variant="secondary" iconLeft="eye" onClick={onSample}>See a sample Fix list</Button>
        </div>
      </div>
      <div aria-hidden className="flex min-w-0 flex-[1_1_300px] flex-col gap-2 opacity-90">
        {peek.map((d) => (
          <div key={d.id} className="flex items-start gap-3 rounded-xl border border-border bg-surface-raised p-3">
            <TypeTile type={d.type} level={d.level} size={30} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <strong className="truncate text-[13px] text-text">{d.title}</strong>
              <span className="truncate text-caption text-text-muted">{readersWords(d.type, d.readers)}</span>
            </span>
            <Badge tone={LEVEL_META[d.level].tone} size="sm">{LEVEL_META[d.level].label}</Badge>
          </div>
        ))}
        <span className="text-center text-caption text-text-muted">Sample</span>
      </div>
    </section>
  );
}

