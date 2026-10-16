/**
 * Admin Journeys client: people, timelines and session recordings, read from PostHog through our
 * own API (backend routers/admin_journeys.py). The PostHog personal key never reaches the browser.
 */
const API_BASE = process.env.NEXT_PUBLIC_API_URL || "https://api.markdrop.in";

export interface JourneySummary { people: number; identified: number; sessions: number; pageviews: number }

export interface JourneyPerson {
  id: string;
  email: string;
  name: string;
  first_seen: string;
  last_seen: string;
  events: number;
  pageviews: number;
  sessions: number;
  country: string | null;
  city: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
  first_referrer: string | null;
  first_utm_source: string | null;
  last_path: string | null;
}

export interface JourneyPersonDetail {
  id: string;
  created_at: string;
  properties: Record<string, unknown>;
  account: { id: string; email: string; name: string | null; created_at: string } | null;
}

export interface JourneyEvent {
  uuid: string;
  event: string;
  timestamp: string;
  props: Record<string, string | number | boolean | null | undefined>;
  custom: Record<string, unknown>;
  element: { tag: string | null; text: string | null; href: string | null } | null;
}

export interface JourneyDoc { slug: string; title: string | null; kind: string; encrypted: boolean }

export interface JourneyRecording {
  id: string;
  start_time: string;
  end_time: string;
  duration: number | null;
  active_seconds: number | null;
  click_count: number | null;
  keypress_count: number | null;
  start_url: string | null;
  ongoing: boolean | null;
  person: { id: string | null; email: string | null; name: string | null } | null;
}

async function get<T>(token: string, path: string, params?: Record<string, string | number | boolean | null | undefined>): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  const res = await fetch(`${API_BASE}/api/v1/admin/journeys${path}${s ? `?${s}` : ""}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) {
    let detail = "Request failed";
    try { detail = (await res.json()).detail ?? detail; } catch { /* not JSON */ }
    throw new Error(detail);
  }
  return res.json();
}

export const journeys = {
  status: (t: string) => get<{ configured: boolean; ui_host: string }>(t, "/status"),
  summary: (t: string, days: number) => get<JourneySummary>(t, "/summary", { days }),
  people: (t: string, o: { days: number; q?: string; identified?: boolean; before?: string | null }) =>
    get<{ people: JourneyPerson[]; has_more: boolean }>(t, "/people", { days: o.days, q: o.q, identified: o.identified || undefined, before: o.before, limit: 50 }),
  person: (t: string, id: string) => get<JourneyPersonDetail>(t, `/people/${id}`),
  timeline: (t: string, id: string, before?: string | null) =>
    get<{ events: JourneyEvent[]; docs: Record<string, JourneyDoc>; has_more: boolean }>(t, `/people/${id}/timeline`, { before, limit: 300 }),
  recordings: (t: string, person?: string | null, offset = 0) =>
    get<{ recordings: JourneyRecording[]; has_more: boolean }>(t, "/recordings", { person, offset, limit: 20 }),
  snapshots: (t: string, id: string) => get<{ events: unknown[] }>(t, `/recordings/${id}/snapshots`),
};
