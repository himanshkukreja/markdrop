"use client";

/** Shared atoms for admin Journeys, on the Markdrop design system. */
import { createContext, useContext, useEffect, useState } from "react";
import { Alert, Button, Icon, SegmentedControl, Tag, cx } from "@/components/ui";
import { readQuery, writeQuery } from "../shared";
import { JourneysError, type DocRef, type Kind, type PageRef, type Stale } from "./api";

// ── URL state ────────────────────────────────────────────────────────────────

/** Journeys' views. "Live" moved to its own admin section (`?tab=live`). */
export type SubTab = "people" | "recordings" | "paths" | "pages";
export const SUBTABS: SubTab[] = ["people", "recordings", "paths", "pages"];
export type RangeKey = "24h" | "7d" | "30d" | "90d";
export const RANGE_DAYS: Record<RangeKey, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };

/** Everything Journeys keeps in the admin URL (`?tab=journeys&jt=…`). */
export interface JState {
  jt: SubTab;
  range: RangeKey | null;
  q: string;
  kind: "all" | "identified" | "anonymous";
  person: string | null;
  path: string | null;
  who: string | null;
}
/** Query keys Journeys owns; cleared when another admin section opens. */
export const JOURNEYS_KEYS = ["jt", "q", "kind", "person", "path", "who"] as const;

export function readState(): JState {
  const q = readQuery();
  const jt = q.get("jt");
  const range = q.get("range");
  const kind = q.get("kind");
  return {
    jt: (SUBTABS as string[]).includes(jt ?? "") ? (jt as SubTab) : "people",
    range: range && range in RANGE_DAYS ? (range as RangeKey) : null,
    q: (q.get("q") ?? "").slice(0, 80),
    kind: kind === "identified" || kind === "anonymous" ? kind : "all",
    person: q.get("person") || null,
    path: q.get("path") || null,
    who: q.get("who") || null,
  };
}

export type Patch = Partial<Record<keyof JState, string | null>>;

export interface Nav {
  state: JState;
  /** Apply a patch to the URL and state. `push` adds a history entry (Back returns). */
  go: (patch: Patch, push?: boolean) => void;
  /** The real URL of a patch, for links that open in a new tab. */
  href: (patch: Patch) => string;
}
export const NavContext = createContext<Nav | null>(null);
export function useNav(): Nav {
  const n = useContext(NavContext);
  if (!n) throw new Error("Journeys nav missing");
  return n;
}

export function hrefFor(patch: Patch): string {
  if (typeof window === "undefined") return "/admin?tab=journeys";
  const q = new URLSearchParams(window.location.search);
  q.set("tab", "journeys");
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") q.delete(k);
    else q.set(k, v);
  }
  return `/admin?${q.toString()}`;
}

export function applyPatch(patch: Patch, push: boolean) {
  writeQuery(patch, push);
}

/** A link inside Journeys: a real href (new tab works), switching in place on a plain click. */
export function NavLink({ to, push = true, className, children, title, "aria-label": ariaLabel }: {
  to: Patch; push?: boolean; className?: string; children: React.ReactNode; title?: string; "aria-label"?: string;
}) {
  const nav = useNav();
  return (
    <a
      href={nav.href(to)}
      title={title}
      aria-label={ariaLabel}
      className={cx("md-focus rounded-sm", className)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        nav.go(to, push);
      }}
    >
      {children}
    </a>
  );
}

/** The days window of a tab: the shared `?range=`, else the tab's own default. */
export function useDays(fallback: RangeKey): { days: number; range: RangeKey } {
  const { state } = useNav();
  const range = state.range ?? fallback;
  return { days: RANGE_DAYS[range], range };
}

export function DaysPicker({ fallback, size = "md" }: { fallback: RangeKey; size?: "sm" | "md" }) {
  const { state, go } = useNav();
  const value = state.range ?? fallback;
  return (
    <SegmentedControl<RangeKey>
      size={size}
      aria-label="Time range"
      value={value}
      onChange={(v) => go({ range: v }, false)}
      options={(Object.keys(RANGE_DAYS) as RangeKey[]).map((r) => ({ value: r, label: r }))}
    />
  );
}

// ── Formatting ───────────────────────────────────────────────────────────────

const NUM = new Intl.NumberFormat("en-IN");
export const fmtNum = (n: number) => NUM.format(n);
export const fmtPct = (x: number, digits = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : "—");

export function timeAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(iso);
}

export function fmtDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return withTime ? `${date}, ${hhmm(iso)}` : date;
}

export function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(iso: string, now: number): string {
  const d = new Date(iso);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

/** 0:42 · 12:05 · 1:02:09 */
export function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function countryFlag(code: string | null | undefined): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return "";
  const up = code.toUpperCase();
  return String.fromCodePoint(0x1f1e6 + up.charCodeAt(0) - 65, 0x1f1e6 + up.charCodeAt(1) - 65);
}

export function place(city: string | null | undefined, country: string | null | undefined): string {
  const words = [city, country].filter(Boolean).join(", ");
  return words ? `${countryFlag(country)} ${words}`.trim() : "Unknown place";
}

export const plural = (n: number, one: string, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;

/** Re-render every `ms` (relative times). */
export function useNow(ms = 0): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!ms) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

// ── Event kinds ──────────────────────────────────────────────────────────────

type Tone = "accent" | "danger" | "success" | "muted";
export const KIND_META: Record<Kind, { glyph: string; tone: Tone; name: string }> = {
  pageview: { glyph: "→", tone: "muted", name: "Page" },
  click: { glyph: "⌖", tone: "muted", name: "Click" },
  form: { glyph: "✎", tone: "muted", name: "Form" },
  rage: { glyph: "‼", tone: "danger", name: "Frustration" },
  read: { glyph: "▤", tone: "success", name: "Reading" },
  publish: { glyph: "✦", tone: "accent", name: "Publish" },
  share: { glyph: "↗", tone: "accent", name: "Share" },
  export: { glyph: "↓", tone: "success", name: "Export" },
  connect: { glyph: "⇄", tone: "accent", name: "Connect" },
  signin: { glyph: "⎆", tone: "accent", name: "Sign in" },
  cta: { glyph: "»", tone: "muted", name: "Call to action" },
  play: { glyph: "◆", tone: "muted", name: "Play" },
  error: { glyph: "!", tone: "danger", name: "Error" },
  event: { glyph: "·", tone: "muted", name: "Event" },
};

const TONE: Record<Tone, string> = {
  accent: "border-accent bg-accent text-on-accent",
  danger: "border-danger bg-danger-soft text-danger",
  success: "border-success bg-surface text-success",
  muted: "border-border-strong bg-surface text-text-muted",
};

export function KindMark({ kind, className }: { kind: Kind; className?: string }) {
  const m = KIND_META[kind] ?? KIND_META.event;
  return (
    <span
      aria-hidden
      title={m.name}
      className={cx("grid size-6 shrink-0 place-items-center rounded-md border font-mono text-caption leading-none", TONE[m.tone], className)}
    >
      {m.glyph}
    </span>
  );
}

/** Label weight by kind: page views plain, clicks and forms quiet, moments emphasised. */
export function labelClass(kind: Kind): string {
  if (kind === "pageview") return "text-text";
  if (kind === "click" || kind === "form") return "text-text-secondary";
  return "font-medium text-text";
}

// ── People ───────────────────────────────────────────────────────────────────

export function WhoDot({ identified }: { identified: boolean }) {
  return (
    <span
      aria-hidden
      className={cx("size-2 shrink-0 rounded-full", identified ? "bg-accent" : "border border-text-muted")}
    />
  );
}

/** A person: dot (filled = signed in) and email, name or "anon xxxxxx", linked to their journey. */
export function Who({ who, identified, personId, className }: { who: string; identified: boolean; personId?: string | null; className?: string }) {
  const body = (
    <>
      <WhoDot identified={identified} />
      <span className="min-w-0 truncate">{who}</span>
      <span className="md-visually-hidden">{identified ? " (signed in)" : " (anonymous)"}</span>
    </>
  );
  const cls = cx("inline-flex min-w-0 max-w-full items-center gap-1.5 font-mono text-caption", identified ? "text-text" : "text-text-secondary", className);
  if (!personId) return <span className={cls}>{body}</span>;
  return (
    <NavLink to={{ person: personId }} className={cx(cls, "hover:text-accent-text hover:underline hover:underline-offset-4")}>
      {body}
    </NavLink>
  );
}

// ── Pages and documents ──────────────────────────────────────────────────────

export function docUrl(slug: string): string {
  const origin = typeof window === "undefined" ? "https://markdrop.in" : window.location.origin;
  return `${origin}/${slug}`;
}

/** Open a document on the site (admin only: PostHog never had the slug). */
export function DocLink({ doc, className }: { doc: DocRef; className?: string }) {
  if (!doc.slug) return null;
  return (
    <a
      href={docUrl(doc.slug)}
      target="_blank"
      rel="noopener noreferrer"
      className={cx("md-focus inline-flex size-6 shrink-0 items-center justify-center rounded-sm align-middle text-text-muted hover:text-accent-text", className)}
      aria-label={`Open “${doc.title}” in a new tab`}
      title={`markdrop.in/${doc.slug}`}
    >
      <Icon name="external" size={13} />
    </a>
  );
}

/** The detail line of an event: where a document lives (admin only), then the server's detail. */
export function eventDetail(e: { kind: Kind; detail: string | null; page: PageRef | null }): string | null {
  if (e.kind === "pageview" && e.page?.doc) return [pageSub(e.page), e.detail].filter(Boolean).join(" · ");
  return e.detail;
}

/** A page's name: an app page's title, or a document's resolved title. */
export function pageName(p: PageRef | null | undefined): string {
  if (!p) return "a page";
  return p.title || p.path;
}

/** The small line under a page name: its route, or where the document lives. */
export function pageSub(p: PageRef): string {
  if (p.doc) {
    if (p.doc.slug) return `markdrop.in/${p.doc.slug}`;
    return `document #${p.doc.ref.slice(0, 6)} · not in this database`;
  }
  return p.path;
}

export function PageIcon({ page, className }: { page: PageRef; className?: string }) {
  const name = page.doc ? (page.doc.encrypted ? "lock" : page.doc.kind === "artifact" ? "image" : "doc") : "globe";
  return <Icon name={name} size={14} className={cx("shrink-0 text-text-muted", className)} />;
}

// ── Layout ───────────────────────────────────────────────────────────────────

export const EYEBROW = "text-eyebrow uppercase text-text-muted";

/** A card: eyebrow, title, a right-side action, and a body (padded unless `pad={false}`). */
export function Panel({ eyebrow, title, action, pad = true, className, children, titleId }: {
  eyebrow?: React.ReactNode; title?: React.ReactNode; action?: React.ReactNode; pad?: boolean; className?: string;
  children: React.ReactNode; titleId?: string;
}) {
  return (
    <section aria-labelledby={titleId} className={cx("min-w-0 rounded-xl border border-border bg-surface", className)}>
      {(title || eyebrow || action) && (
        <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border px-4 py-2.5">
          <div className="min-w-0">
            {eyebrow && <p className={EYEBROW}>{eyebrow}</p>}
            {title && <h2 id={titleId} className="text-h4 text-text">{title}</h2>}
          </div>
          {action && <div className="flex min-w-0 flex-wrap items-center gap-2">{action}</div>}
        </div>
      )}
      <div className={pad ? "p-4" : undefined}>{children}</div>
    </section>
  );
}

export function Field({ label, children, title }: { label: React.ReactNode; children: React.ReactNode; title?: string }) {
  return (
    <div className="min-w-0">
      <dt className={EYEBROW}>{label}</dt>
      <dd className="mt-0.5 truncate text-body text-text" title={title}>{children}</dd>
    </div>
  );
}

export function LiveDot({ on }: { on: boolean }) {
  return (
    <span aria-hidden className="relative inline-flex size-2.5 shrink-0">
      {on && <span className="absolute inset-0 rounded-full bg-accent opacity-60 motion-safe:animate-ping" />}
      <span className={cx("relative size-2.5 rounded-full", on ? "bg-accent" : "bg-text-muted")} />
    </span>
  );
}

export function ExtLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Button size="sm" variant="secondary" iconRight="external" href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
      <span className="md-visually-hidden"> (opens in a new tab)</span>
    </Button>
  );
}

// ── Lists ────────────────────────────────────────────────────────────────────

export interface BarItem { key: string; label: React.ReactNode; hint?: React.ReactNode; value: number; to?: Patch; icon?: React.ReactNode; title?: string }

/** Ranked rows with a translucent bar behind each label, the value and its share of the total. */
export function BarList({ items, limit = 10, empty = "No data for this range", label }: { items: BarItem[]; limit?: number; empty?: string; label?: string }) {
  if (!items.length) return <p className="py-6 text-center text-caption text-text-muted">{empty}</p>;
  const shown = items.slice(0, limit);
  const max = Math.max(1, ...items.map((i) => i.value));
  const sum = items.reduce((a, i) => a + i.value, 0) || 1;
  return (
    <div>
      <ul className="flex flex-col gap-1" aria-label={label}>
        {shown.map((it) => {
          const inner = (
            <>
              <span aria-hidden className="absolute inset-y-0 left-0 rounded-md bg-accent/15 transition-colors group-hover:bg-accent/25" style={{ width: `${Math.max(1.5, (it.value / max) * 100)}%` }} />
              <span className="relative flex min-w-0 flex-1 items-center gap-2 py-1.5">
                {it.icon}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-body text-text" title={it.title}>{it.label}</span>
                  {it.hint && <span className="truncate font-mono text-micro text-text-muted">{it.hint}</span>}
                </span>
              </span>
              <span className="relative shrink-0 font-mono text-caption tabular-nums text-text">{fmtNum(it.value)}</span>
              <span className="relative w-12 shrink-0 text-right font-mono text-micro tabular-nums text-text-muted">{fmtPct(it.value / sum, 0)}</span>
            </>
          );
          const cls = "group relative flex min-h-10 min-w-0 items-center gap-3 rounded-md px-2";
          return (
            <li key={it.key}>
              {it.to ? <NavLink to={it.to} className={cx(cls, "hover:text-text")}>{inner}</NavLink> : <div className={cls}>{inner}</div>}
            </li>
          );
        })}
      </ul>
      {items.length > limit && <p className="mt-2 px-2 font-mono text-micro text-text-muted">+{items.length - limit} more</p>}
    </div>
  );
}

/** Removable filter chips, with "Clear all" when there's more than one. */
export function FilterChips({ chips, onClearAll }: { chips: { key: string; label: string; onRemove: () => void }[]; onClearAll: () => void }) {
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Active filters">
      <span className={EYEBROW}>Filter</span>
      {chips.map((c) => (
        <Tag key={c.key} onRemove={c.onRemove} removeLabel={`Remove filter ${c.label}`} className="max-w-full">
          <span className="truncate font-mono">{c.label}</span>
        </Tag>
      ))}
      {chips.length > 1 && <Button size="sm" variant="ghost" onClick={onClearAll}>Clear all</Button>}
    </div>
  );
}

/** "4 min ago", "40 s ago". */
export function fmtAge(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

export function fmtWait(sec: number): string {
  const s = Math.max(1, Math.round(sec));
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/**
 * PostHog failed but data is on screen: a small, non-blocking line saying how old the data is,
 * why, and when we ask again. `stale` comes from the answer (the API served its last good
 * result); `error` is a failed refresh while the previous answer is still shown.
 */
export function StaleNotice({ stale, error, className }: { stale?: Stale | null; error?: JourneysError | null; className?: string }) {
  const now = useNow(5_000);
  if (!stale && !error) return null;
  let lead: string;
  let why: string;
  let retry: number | null = null;
  if (stale) {
    const age = Math.max(stale.age_s, (now - new Date(stale.as_of).getTime()) / 1000);
    lead = age < 15 ? "Some of this didn't refresh" : `Showing data from ${fmtAge(age)}`;
    why = stale.message;
    // The answer left the API at as_of + age_s; count the retry down from there.
    retry = stale.retry_in ? (new Date(stale.as_of).getTime() + (stale.age_s + stale.retry_in) * 1000 - now) / 1000 : null;
    if (retry !== null && retry < 1) retry = null;
  } else {
    lead = "Couldn't refresh";
    why = error!.message.replace(/[.;]\s*trying again in .*$/i, "");
    retry = error!.retryIn;
  }
  return (
    <p role="status" className={cx("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-warning/40 bg-warning-soft px-3 py-1.5 font-mono text-micro text-text", className)}>
      <Icon name="clock" size={12} className="shrink-0 text-warning" />
      <span>{lead}</span>
      <span aria-hidden className="text-text-muted">·</span>
      <span className="min-w-0 text-text-secondary">{why}</span>
      {retry ? (
        <>
          <span aria-hidden className="text-text-muted">·</span>
          <span className="text-text-secondary">retrying in {fmtWait(retry)}</span>
        </>
      ) : null}
    </p>
  );
}

// ── Errors ───────────────────────────────────────────────────────────────────

const SCOPE_IN_MESSAGE = /“([a-z_]+:(?:read|write))”/;

/** A failed request. A missing PostHog key scope (424) gets its own card saying exactly what to add. */
export function PhErrorState({ error, onRetry, title, scope, className }: {
  error: JourneysError | string | null; onRetry?: () => void; title?: React.ReactNode; scope?: string | null; className?: string;
}) {
  const status = error instanceof JourneysError ? error.status : undefined;
  const msg = typeof error === "string" ? error : error?.message ?? "";
  const sc = scope || (error instanceof JourneysError ? error.scope : null) || (status === 424 ? msg.match(SCOPE_IN_MESSAGE)?.[1] : null);
  if (sc) {
    return (
      <div role="alert" className={cx("flex flex-col items-start gap-2 rounded-xl border border-dashed border-accent bg-accent-soft px-4 py-4", className)}>
        <span className="font-mono text-caption text-accent-text">scope missing · {sc}</span>
        <p className="text-body-strong text-text">This part needs one more permission on the PostHog key</p>
        <p className="max-w-prose text-body text-text-secondary">
          PostHog → Account settings → Personal API keys → edit the key used for MARKDROP_POSTHOG_PERSONAL_API_KEY → add{" "}
          <b className="font-mono text-text">{sc}</b>. No restart needed; retry after saving.
        </p>
        {onRetry && <Button size="sm" variant="secondary" iconLeft="refresh" onClick={onRetry}>Retry</Button>}
      </div>
    );
  }
  return (
    <Alert
      tone="danger"
      className={className}
      title={title ?? "Couldn't load this from PostHog"}
      actions={onRetry ? <Button size="sm" variant="secondary" iconLeft="refresh" onClick={onRetry}>Retry</Button> : undefined}
    >
      <span className="block font-mono text-caption">{status ? `ERR ${status} · ` : ""}{msg || "Request failed"}</span>
    </Alert>
  );
}
