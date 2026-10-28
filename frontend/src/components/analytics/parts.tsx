"use client";

/** Building blocks shared by the analytics pages: cards, KPI tiles, insights, states, loaders. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, EmptyState, Icon, SegmentedControl, Skeleton, cx } from "@/components/ui";
import { useLocationSearch, useMounted } from "@/components/shell/useLocation";
import { useAuth } from "@/contexts/AuthContext";
import {
  RANGES, fixtureMode, getFrameUrl, isNotYours, isSignedOut,
  type AnalyticsRange, type Insight, type Kpi,
} from "@/lib/analytics";
import { kpiDelta, kpiValue } from "./format";

/* ── Loading ──────────────────────────────────────────────────────────── */

export interface Loaded<T> { data: T | null; error: unknown; loading: boolean; retry: () => void }

/** Runs `load` whenever `key` changes (null = don't load). Keeps the last data while reloading. */
export function useLoad<T>(key: string | null, load: () => Promise<T>): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(!!key);
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!key) return;
    let live = true;
    setLoading(true);
    setError(null);
    loadRef.current()
      .then((d) => { if (live) { setData(d); setLoading(false); } })
      .catch((e) => { if (live) { setError(e); setLoading(false); } });
    return () => { live = false; };
  }, [key, attempt]);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { data, error, loading, retry };
}

/* ── Card ─────────────────────────────────────────────────────────────── */

export function Panel({ title, aside, icon, id, children, className, headerExtra }: {
  title: React.ReactNode;
  aside?: React.ReactNode;
  icon?: string;
  id: string;
  children: React.ReactNode;
  className?: string;
  headerExtra?: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className={cx("flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4 sm:px-5", className)}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 id={id} className="m-0 flex flex-1 items-center gap-2 text-h4 text-text">
          {icon && <Icon name={icon} size={18} className="text-text-secondary" />}
          {title}
        </h2>
        {aside && <span className="text-caption text-text-muted">{aside}</span>}
        {headerExtra}
      </div>
      {children}
    </section>
  );
}

/* ── KPI tiles ────────────────────────────────────────────────────────── */

const KPI_ICON: Record<string, string> = {
  people: "user", watch_time: "clock", avg_watched: "film", played: "zap", read_all: "checkCircle", read_time: "clock",
  copies_clicks: "copy", reached_end: "checkCircle", pages_npages: "doc", time: "clock", returning: "refresh", read_end: "checkCircle",
};

export function KpiTile({ kpi, range, big }: { kpi: Kpi; range: AnalyticsRange; big?: boolean }) {
  const delta = kpiDelta(kpi, range);
  const line = delta?.text ?? kpi.note ?? null;
  const icon = delta ? (delta.dir === "up" ? "arrowUp" : delta.dir === "down" ? "arrowDown" : "minus") : KPI_ICON[kpi.key];
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-surface p-3 sm:p-4">
      <span className="text-caption text-text-muted">{kpi.label}</span>
      <strong className={cx("font-bold tracking-[-0.01em] text-text tabular-nums", big ? "text-[22px] leading-7 sm:text-[28px] sm:leading-[34px]" : "text-[22px] leading-7 sm:text-[26px] sm:leading-8")}>
        {kpiValue(kpi)}
      </strong>
      {line && (
        <span className="flex items-start gap-1 text-caption text-text-secondary">
          {icon && <Icon name={icon} size={12} className="mt-0.5 shrink-0" />}
          <span>{line}</span>
        </span>
      )}
      {delta && kpi.note && <span className="text-caption text-text-muted">{kpi.note}</span>}
    </div>
  );
}

export function KpiGrid({ children, loading, count = 4 }: { children?: React.ReactNode; loading?: boolean; count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fit,minmax(170px,1fr))] sm:gap-3" aria-busy={loading || undefined}>
      {loading
        ? Array.from({ length: count }, (_, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4">
              <Skeleton width="50%" height={12} />
              <Skeleton width="70%" height={28} />
              <Skeleton width="60%" height={12} />
            </div>
          ))
        : children}
    </div>
  );
}

/** A simple tile for values that aren't API KPIs (Content tab). */
export function StatBox({ label, value, note }: { label: string; value: string; note?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-surface p-3 sm:px-4 sm:py-3.5">
      <span className="text-caption text-text-muted">{label}</span>
      <strong className="text-[22px] leading-7 font-bold text-text tabular-nums sm:text-[26px] sm:leading-8">{value}</strong>
      {note && <span className="text-caption text-text-secondary">{note}</span>}
    </div>
  );
}

/* ── Frames ───────────────────────────────────────────────────────────── */

/** A video frame at `t` (owner-only endpoint, fetched with the bearer header). Falls back to `fallback`. */
export function FrameThumb({ slug, t, ver, fallback, width = 96, height = 54, alt }: {
  slug: string; t: number; ver?: number | null; fallback: React.ReactNode; width?: number; height?: number; alt: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    setUrl(null);
    void getFrameUrl(slug, t, ver).then((u) => {
      if (!u) return;
      if (live) { made = u; setUrl(u); } else URL.revokeObjectURL(u);
    });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [slug, t, ver]);
  return (
    <span className="relative grid shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-surface-inset font-mono text-micro text-text-muted" style={{ width, height }}>
      {url
        ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={url} alt={alt} className="size-full object-cover" />
        : fallback}
    </span>
  );
}

/* ── Insights ─────────────────────────────────────────────────────────── */

const SEVERITY_ICON: Record<Insight["severity"], string> = { info: "info", warning: "alert", success: "checkCircle" };

export function InsightList({ insights, onCta, frameFor, rewrite = (s) => s }: {
  insights: Insight[];
  onCta: (i: Insight) => void;
  /** Video: a thumbnail frame for a "2:14" thumb. */
  frameFor?: (t: number) => React.ReactNode;
  rewrite?: (s: string) => string;
}) {
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {insights.map((i) => {
        const t = i.thumb && /^\d{1,2}:\d{2}$/.test(i.thumb) ? i.thumb.split(":").reduce((a, x) => a * 60 + +x, 0) : null;
        const fallback = i.thumb ? <span className="px-1 text-center">{i.thumb}</span> : <Icon name={SEVERITY_ICON[i.severity]} size={18} />;
        return (
          <li key={i.key} className="flex flex-wrap items-center gap-3.5 border-t border-border py-2.5">
            {t != null && frameFor ? frameFor(t) : (
              <span className={cx("grid h-[50px] w-[88px] shrink-0 place-items-center rounded-md border border-border bg-surface-inset font-mono text-micro",
                i.severity === "warning" && !i.thumb ? "text-warning" : i.severity === "success" && !i.thumb ? "text-success" : "text-text-muted")}>
                {fallback}
              </span>
            )}
            <div className="min-w-0 flex-[1_1_300px]">
              <div className="text-body-strong text-text">{rewrite(i.title)}</div>
              <div className="text-[13px] leading-5 text-text-secondary">{rewrite(i.body)}</div>
            </div>
            {i.cta && <Button variant="ghost" size="sm" iconRight="arrowRight" onClick={() => onCta(i)}>{i.cta.label}</Button>}
          </li>
        );
      })}
    </ul>
  );
}

/* ── States ───────────────────────────────────────────────────────────── */

export function LoadError({ error, retry, what = "analytics" }: { error: unknown; retry: () => void; what?: string }) {
  if (isNotYours(error)) {
    return <EmptyState icon="lock" title="You can only see analytics for documents you own." description="Check the link, or open one of your own documents from your files." actions={<Button variant="secondary" href="/dashboard/analytics">All analytics</Button>} />;
  }
  if (isSignedOut(error)) {
    return <Alert tone="warning" title="You're signed out">Sign in again to see your analytics.</Alert>;
  }
  return (
    <Alert tone="danger" title={`Couldn't load ${what}`} actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={retry}>Retry</Button>}>
      Check your connection and try again.
    </Alert>
  );
}

export function PanelSkeleton({ height = 180, className }: { height?: number; className?: string }) {
  return (
    <div className={cx("flex flex-col gap-3 rounded-xl border border-border bg-surface p-5", className)} aria-hidden>
      <Skeleton width="40%" height={16} />
      <Skeleton variant="rect" height={height} />
    </div>
  );
}

export function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="m-0 text-caption text-text-muted">{children}</p>;
}

export function LiveBadge({ n, word, size }: { n: number; word: string; size?: "sm" | "md" }) {
  if (n <= 0) return null;
  return <Badge tone="success" live size={size}>{n} {word}</Badge>;
}

/* ── Page plumbing ────────────────────────────────────────────────────── */

/**
 * Signed-in gate for the analytics pages: sends a signed-out visitor to /login (back here after).
 * `ready` once a session is known (or fixture mode is on, in development).
 */
export function useAnalyticsGate(): { ready: boolean; fixture: boolean } {
  const { user, loading } = useAuth();
  const router = useRouter();
  const mounted = useMounted();
  const fixture = mounted && fixtureMode();
  useEffect(() => {
    if (!mounted || loading || user || fixture) return;
    router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }, [mounted, loading, user, fixture, router]);
  return { ready: mounted && (fixture || (!loading && !!user)), fixture };
}

/** Query params of the current URL, and a way to change some of them (replace, no scroll). */
export function useParams(): [URLSearchParams, (patch: Record<string, string | null>) => void] {
  const search = useLocationSearch();
  const router = useRouter();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const set = useCallback((patch: Record<string, string | null>) => {
    const p = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") p.delete(k);
      else p.set(k, v);
    }
    const qs = p.toString();
    router.replace(`${window.location.pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [router]);
  return [params, set];
}

export function RangePicker({ value, onChange }: { value: AnalyticsRange; onChange: (r: AnalyticsRange) => void }) {
  return <SegmentedControl size="sm" aria-label="Date range" value={value} onChange={onChange} options={RANGES.map((r) => ({ value: r.value, label: r.label }))} />;
}
