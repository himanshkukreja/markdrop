"use client";

/**
 * Admin Journeys client: live visitors, people, timelines, replays, paths and pages, read from
 * PostHog through our own API (backend routers/admin_journeys.py). The PostHog personal key never
 * reaches the browser, and replays are fetched by our API (never PostHog share links).
 *
 * Every data endpoint answers `{configured: false, status}` with HTTP 200 while PostHog isn't set
 * up; failures come back as 502/504/429/424 `{detail, scope}`. Only our own 401 signs out.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isUnauthorized, useOnUnauthorized } from "../shared";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "https://api.markdrop.in";

// ── Types (backend services/journeys.py) ─────────────────────────────────────

export type Kind =
  | "pageview" | "click" | "form" | "rage" | "read" | "publish" | "share" | "export"
  | "connect" | "signin" | "cta" | "play" | "error" | "event";

export interface PhStatus {
  configured: boolean;
  region: "us" | "eu";
  ui_host: string;
  project_id: string | null;
  include_local: boolean;
  missing: string[];
  /** Open PostHog breakers: {query|rest: {cooldown_s, reason}}. */
  limits?: Record<string, { cooldown_s: number; reason: string }>;
}
export interface NotConfigured { configured: false; status: PhStatus }

/**
 * Part of an answer is the last good result standing in for a failed PostHog call (rate limit,
 * spent budget, capacity, timeout or 5xx): how old it is, why, and when the API asks PostHog again.
 */
export interface Stale {
  age_s: number;
  as_of: string;
  reason: "budget" | "rate_limited" | "capacity" | "slow" | "unavailable";
  message: string;
  retry_in: number | null;
}
/** Every data answer may carry `stale`. */
export interface MaybeStale { stale?: Stale | null }

/** A document, resolved from its opaque ref by our API. `slug` is null when it no longer exists. */
export interface DocRef { ref: string; slug: string | null; title: string; kind: string; encrypted: boolean; access?: string }
/** A page: an app route (`/new`) or a document (`doc:<ref>`). */
export interface PageRef { key: string; path: string; title: string | null; doc: DocRef | null }

export interface TimelineEvent {
  id: string;
  t: string;
  event: string;
  kind: Kind;
  label: string;
  detail: string | null;
  page: PageRef | null;
  session: string | null;
}
export interface StreamEvent extends TimelineEvent {
  person_id: string | null;
  who: string;
  identified: boolean;
  country: string | null;
  city: string | null;
  device: string | null;
}
export interface LiveRes extends MaybeStale { configured: true; live: number; pages: { page: PageRef; n: number }[]; events: StreamEvent[] }

export interface PersonRow {
  id: string;
  distinct_id: string | null;
  email: string | null;
  name: string | null;
  identified: boolean;
  first_seen: string | null;
  last_seen: string;
  sessions: number;
  pageviews: number;
  events: number;
  country: string | null;
  city: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  referrer: string | null;
  top_pages: PageRef[];
}
export interface PeopleRes extends MaybeStale { configured: true; people: PersonRow[]; days: number; capped: boolean }

export interface Recording {
  id: string;
  start: string;
  end: string | null;
  duration: number;
  active: number;
  clicks: number;
  keys: number;
  errors: number;
  start_page: PageRef | null;
  person_id: string | null;
  who: string;
  identified: boolean;
  ongoing: boolean;
  viewed: boolean;
  pages: PageRef[];
  more_pages: number;
  pageviews: number;
  rage: number;
  dead: number;
  expires_soon: boolean;
  app_url: string;
}
export interface RecordingsRes extends MaybeStale { configured: true; recordings: Recording[]; has_next: boolean; filter_page: PageRef | null }

export interface Account { id: string; email: string; name: string | null; created_at: string | null; documents: number }
export interface PersonInfo {
  id: string;
  distinct_id: string | null;
  email: string | null;
  name: string | null;
  identified: boolean;
  created_at: string | null;
  country: string | null;
  city: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  referrer: string | null;
  app_url: string;
  account: Account | null;
}
export interface PersonRes extends MaybeStale {
  configured: true;
  person: PersonInfo;
  events: TimelineEvent[];
  recordings: Recording[];
  recordings_error: { error: string; scope: string | null } | null;
  days: number;
  truncated: boolean;
}

export interface FunnelStep { key: string; label: string; n: number }
export interface PathsRes extends MaybeStale {
  configured: true;
  days: number;
  sessions: number;
  people: number;
  truncated: boolean;
  entries: { page: PageRef; n: number }[];
  exits: { page: PageRef; n: number }[];
  paths: { steps: PageRef[]; n: number }[];
  funnel: FunnelStep[];
  pages: { page: PageRef; views: number; visitors: number }[];
}

export interface PageDetailRes extends MaybeStale {
  configured: true;
  page: PageRef;
  days: number;
  clicks: { text: string; tag: string | null; n: number; rage: number; dead: number }[];
  depth: { pct: number; readers: number }[] | null;
  heatmap_url: string | null;
  toolbar_url: string;
  site_url: string | null;
}

export interface SnapshotsRes {
  configured: true;
  id: string;
  found: boolean;
  events: unknown[];
  app_url: string;
  /** The newest blob key included: pass it back as `?after=` to fetch only newer events. */
  last_key?: number | null;
  /** End time of the newest blob (an ongoing recording's live edge). */
  live_edge?: string | null;
}

// ── Live (GET /live/feed) ────────────────────────────────────────────────────

export interface LiveRecording { id: string; ongoing: boolean; start: string | null; end: string | null; duration: number; app_url: string }
export interface LiveSession {
  id: string;
  person_id: string | null;
  distinct_id: string | null;
  who: string;
  identified: boolean;
  email: string | null;
  name: string | null;
  country: string | null;
  city: string | null;
  device: string | null;
  browser: string | null;
  started: string | null;
  /** The session began before the 30-minute window (and has no recording to date it). */
  started_before_window: boolean;
  last_seen: string;
  events: number;
  events_now: number;
  pageviews: number;
  page: PageRef | null;
  last: { id: string | null; t: string; event: string; kind: Kind; label: string; detail: string | null; page: PageRef | null };
  recording: LiveRecording | null;
}
export interface LiveFeedRes extends MaybeStale {
  configured: true;
  as_of: string;
  window_min: number;
  now_min: number;
  counts: { visitors_now: number; sessions: number; events_now: number; pageviews: number; capped: boolean };
  sessions: LiveSession[];
  pages: { page: PageRef; n: number }[];
  /** Newest first; with `since`, only what is new (plus a few minutes of overlap: dedupe by id). */
  events: StreamEvent[];
  cursor: string | null;
  recordings_error: { error: string; scope: string | null } | null;
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** A failed Journeys request. `scope` names a missing PostHog personal-API-key scope (424). */
export class JourneysError extends Error {
  status: number;
  scope: string | null;
  /** Seconds until the API asks PostHog again (its breaker is open), when known. */
  retryIn: number | null;
  /** Why PostHog failed: rate_limited, budget, capacity, slow, unavailable, live_viewers… */
  reason: string | null;
  constructor(status: number, message: string, scope: string | null = null, retryIn: number | null = null, reason: string | null = null) {
    super(message);
    this.status = status;
    this.scope = scope;
    this.retryIn = retryIn;
    this.reason = reason;
  }
}

// ── Transport ────────────────────────────────────────────────────────────────

type Params = Record<string, string | number | boolean | null | undefined>;

/** Dev-only fixtures (`?preview=1`): the branch is compiled out of production builds. */
function previewOn(): boolean {
  if (process.env.NODE_ENV !== "development" || typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search).get("preview");
    if (q === "1") sessionStorage.setItem("md_journeys_preview", "1");
    if (q === "0") sessionStorage.removeItem("md_journeys_preview");
    return sessionStorage.getItem("md_journeys_preview") === "1";
  } catch {
    return false;
  }
}

export function isPreview(): boolean {
  return previewOn();
}

export async function jget<T>(token: string, path: string, params?: Params): Promise<T> {
  if (process.env.NODE_ENV === "development" && previewOn()) {
    const { resolveFixture } = await import("./fixtures");
    const hit = await resolveFixture(path, params ?? {});
    if (hit !== undefined) return hit as T;
  }
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/admin/journeys${path}${s ? `?${s}` : ""}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    throw new JourneysError(0, "Can't reach the Markdrop API. Check your connection and retry.");
  }
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    let scope: string | null = null;
    let retryIn: number | null = Number(res.headers.get("retry-after")) || null;
    let reason: string | null = null;
    try {
      const body = await res.json();
      if (typeof body.detail === "string") detail = body.detail;
      if (typeof body.scope === "string") scope = body.scope;
      if (typeof body.retry_in === "number") retryIn = body.retry_in;
      if (typeof body.reason === "string") reason = body.reason;
    } catch {
      /* not JSON */
    }
    throw new JourneysError(res.status, detail, scope, retryIn, reason);
  }
  return res.json();
}

// ── Polling ──────────────────────────────────────────────────────────────────

/** Poll back-off after failed or stale answers: the base interval, then 30 s, then 60 s. */
export const BACKOFF_MS = [30_000, 60_000] as const;

/**
 * The wait before the next poll: `baseMs` while answers are fresh, then 30 s and 60 s after one
 * and two failed (or stale) answers in a row. A known PostHog cooldown stretches it (≤ 2 min).
 */
export function nextDelay(baseMs: number, fails: number, retryInS?: number | null): number {
  let ms = fails <= 0 ? baseMs : Math.max(baseMs, BACKOFF_MS[Math.min(fails, BACKOFF_MS.length) - 1]!);
  if (fails > 0 && retryInS) ms = Math.max(ms, Math.min(retryInS * 1000, 120_000));
  return ms;
}

/** The stale note of an answer, if any. */
export function staleOf(d: unknown): Stale | null {
  return d && typeof d === "object" && "stale" in d ? ((d as MaybeStale).stale ?? null) : null;
}

// ── Data hook ────────────────────────────────────────────────────────────────

export interface Loaded<T> {
  data: T | undefined;
  error: JourneysError | null;
  loading: boolean;
  refresh: () => void;
  /** When the current answer arrived (ms since epoch). */
  updatedAt: number | null;
  /** The answer's stale note (PostHog failed; the last good result is shown). */
  stale: Stale | null;
}

/**
 * GET a Journeys endpoint. Keeps the last answer while refetching (no flash on a filter change
 * or a poll) and through a failed refresh, signs out on our 401, and with `refreshMs` polls while
 * the tab is visible: one request at a time, backing off to 30 s and 60 s after failed or stale
 * answers, and catching up at once when the tab comes back. `path` null skips the request.
 */
export function useJourneys<T>(
  token: string, path: string | null, params?: Params, opts?: { refreshMs?: number; paused?: boolean },
): Loaded<T> {
  const onUnauthorized = useOnUnauthorized();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<JourneysError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const [settled, setSettled] = useState(0);
  const key = path === null ? null : `${path}?${JSON.stringify(params ?? {})}`;
  const lastKey = useRef<string | null>(null);
  const fails = useRef(0);
  const retryIn = useRef<number | null>(null);
  const refreshMs = opts?.refreshMs;
  const paused = !!opts?.paused;

  useEffect(() => {
    if (key === null || path === null) return;
    let off = false;
    // A new query (not a poll or a retry) drops data that answered a different question only
    // when the shape differs; same-endpoint answers stay on screen until the new one lands.
    if (lastKey.current && lastKey.current.split("?")[0] !== path) setData(undefined);
    if (lastKey.current !== key) {
      setError(null);
      fails.current = 0;
    }
    lastKey.current = key;
    setLoading(true);
    jget<T>(token, path, params)
      .then((d) => {
        if (off) return;
        setData(d);
        setError(null);
        setUpdatedAt(Date.now());
        const st = staleOf(d);
        fails.current = st ? fails.current + 1 : 0;
        retryIn.current = st?.retry_in ?? null;
      })
      .catch((e) => {
        if (off) return;
        if (isUnauthorized(e)) {
          onUnauthorized();
          return;
        }
        const err = e instanceof JourneysError ? e : new JourneysError(0, e instanceof Error ? e.message : "Something went wrong");
        setError(err);
        fails.current += 1;
        retryIn.current = err.retryIn;
      })
      .finally(() => {
        if (off) return;
        setLoading(false);
        setSettled((n) => n + 1);
      });
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures path and params
  }, [token, key, nonce, onUnauthorized]);

  // The next poll is scheduled when the previous answer settles, so requests never overlap.
  useEffect(() => {
    if (!refreshMs || key === null || paused || settled === 0) return;
    let due = false;
    const t = setTimeout(() => {
      if (document.visibilityState === "visible") setNonce((n) => n + 1);
      else due = true;
    }, nextDelay(refreshMs, fails.current, retryIn.current));
    const onVis = () => {
      if (document.visibilityState === "visible" && due) {
        due = false;
        setNonce((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearTimeout(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refreshMs, key, paused, settled]);

  const refresh = useCallback(() => {
    fails.current = 0;
    setNonce((n) => n + 1);
  }, []);
  return { data, error, loading, refresh, updatedAt, stale: staleOf(data) };
}

/** True when an answer is the not-configured shape. */
export function notConfigured(d: unknown): d is NotConfigured {
  return !!d && typeof d === "object" && (d as { configured?: unknown }).configured === false;
}
