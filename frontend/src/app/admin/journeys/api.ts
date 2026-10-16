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
}
export interface NotConfigured { configured: false; status: PhStatus }

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
export interface LiveRes { configured: true; live: number; pages: { page: PageRef; n: number }[]; events: StreamEvent[] }

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
export interface PeopleRes { configured: true; people: PersonRow[]; days: number; capped: boolean }

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
export interface RecordingsRes { configured: true; recordings: Recording[]; has_next: boolean; filter_page: PageRef | null }

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
export interface PersonRes {
  configured: true;
  person: PersonInfo;
  events: TimelineEvent[];
  recordings: Recording[];
  recordings_error: { error: string; scope: string | null } | null;
  days: number;
  truncated: boolean;
}

export interface FunnelStep { key: string; label: string; n: number }
export interface PathsRes {
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

export interface PageDetailRes {
  configured: true;
  page: PageRef;
  days: number;
  clicks: { text: string; tag: string | null; n: number; rage: number; dead: number }[];
  depth: { pct: number; readers: number }[] | null;
  heatmap_url: string | null;
  toolbar_url: string;
  site_url: string | null;
}

export interface SnapshotsRes { configured: true; id: string; found: boolean; events: unknown[]; app_url: string }

// ── Errors ───────────────────────────────────────────────────────────────────

/** A failed Journeys request. `scope` names a missing PostHog personal-API-key scope (424). */
export class JourneysError extends Error {
  status: number;
  scope: string | null;
  constructor(status: number, message: string, scope: string | null = null) {
    super(message);
    this.status = status;
    this.scope = scope;
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
    try {
      const body = await res.json();
      if (typeof body.detail === "string") detail = body.detail;
      if (typeof body.scope === "string") scope = body.scope;
    } catch {
      /* not JSON */
    }
    throw new JourneysError(res.status, detail, scope);
  }
  return res.json();
}

// ── Data hook ────────────────────────────────────────────────────────────────

export interface Loaded<T> {
  data: T | undefined;
  error: JourneysError | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * GET a Journeys endpoint. Keeps the last answer while refetching (no flash on a filter change
 * or a poll), polls every `refreshMs` only while the tab is visible, and signs out on our 401.
 * `path` null skips the request.
 */
export function useJourneys<T>(token: string, path: string | null, params?: Params, opts?: { refreshMs?: number }): Loaded<T> {
  const onUnauthorized = useOnUnauthorized();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<JourneysError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [nonce, setNonce] = useState(0);
  const key = path === null ? null : `${path}?${JSON.stringify(params ?? {})}`;
  const lastKey = useRef<string | null>(null);
  const refreshMs = opts?.refreshMs;

  useEffect(() => {
    if (key === null || path === null) return;
    let off = false;
    // A new query (not a poll or a retry) drops data that answered a different question only
    // when the shape differs; same-endpoint answers stay on screen until the new one lands.
    if (lastKey.current && lastKey.current.split("?")[0] !== path) setData(undefined);
    if (lastKey.current !== key) setError(null);
    lastKey.current = key;
    setLoading(true);
    jget<T>(token, path, params)
      .then((d) => {
        if (off) return;
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (off) return;
        if (isUnauthorized(e)) onUnauthorized();
        else setError(e instanceof JourneysError ? e : new JourneysError(0, e instanceof Error ? e.message : "Something went wrong"));
      })
      .finally(() => !off && setLoading(false));
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures path and params
  }, [token, key, nonce, onUnauthorized]);

  useEffect(() => {
    if (!refreshMs || key === null) return;
    const tick = () => {
      if (document.visibilityState === "visible") setNonce((n) => n + 1);
    };
    const id = setInterval(tick, refreshMs);
    const onVis = () => {
      if (document.visibilityState === "visible") setNonce((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refreshMs, key]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, refresh };
}

/** True when an answer is the not-configured shape. */
export function notConfigured(d: unknown): d is NotConfigured {
  return !!d && typeof d === "object" && (d as { configured?: unknown }).configured === false;
}
