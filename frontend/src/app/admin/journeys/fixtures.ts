/**
 * Development-only fixtures for admin Journeys (`/admin?tab=journeys&preview=1`, `&setup=1` for
 * the setup card). Deterministic (a seeded LCG), dense enough to exercise every state: identified
 * and anonymous people, rage and dead clicks, errors, live and expiring recordings, documents
 * that resolve and ones that don't, and a live site for the Live section (`/admin?tab=live&preview=1`,
 * `&stale=1` for the stale notice) with growing sessions and recordings. api.ts imports this module only behind
 * `process.env.NODE_ENV === "development"`, so production builds never contain it.
 */
import type {
  DocRef, Kind, LiveFeedRes, LiveRes, LiveSession, PageDetailRes, PageRef, PathsRes, PeopleRes, PersonRes, PersonRow, PhStatus, Recording,
  RecordingsRes, SnapshotsRes, StreamEvent, TimelineEvent,
} from "./api";

if (process.env.NODE_ENV !== "development") throw new Error("Journeys fixtures are development-only");

type Params = Record<string, string | number | boolean | null | undefined>;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const NOW = Date.now();
const MIN = 60_000;
const uuid = (r: () => number) =>
  "xxxxxxxx-xxxx-7xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(r() * 16).toString(16));

const DOCS: DocRef[] = [
  { ref: "a1b2c3d4e5f60718", slug: "tokenBkt", title: "Rate limiting with token buckets", kind: "document", encrypted: false },
  { ref: "b2c3d4e5f6071829", slug: "rel24", title: "Release notes 2.4", kind: "document", encrypted: false },
  { ref: "c3d4e5f60718293a", slug: "q3road", title: "Q3 roadmap", kind: "artifact", encrypted: false },
  { ref: "d4e5f60718293a4b", slug: "onboard", title: "Onboarding checklist", kind: "document", encrypted: false },
  { ref: "e5f60718293a4b5c", slug: "Xk9secret", title: "Encrypted document", kind: "document", encrypted: true },
  { ref: "f60718293a4b5c6d", slug: null, title: "Unknown document", kind: "document", encrypted: false },
];

const APP: Record<string, string> = {
  "/": "Home", "/new": "Editor", "/upload": "Upload a file", "/builder": "README builder", "/dashboard": "Dashboard",
  "/share": "Share files", "/privacy": "Privacy", "/login": "Sign in",
};

const app = (path: string): PageRef => ({ key: path, path, title: APP[path] ?? null, doc: null });
const docPage = (d: DocRef): PageRef => ({ key: `doc:${d.ref}`, path: "/[slug]", title: d.title, doc: d });
const pageOf = (key: string): PageRef => {
  if (key.startsWith("doc:")) {
    const d = DOCS.find((x) => x.ref === key.slice(4));
    return d ? docPage(d) : { key, path: "/[slug]", title: "Unknown document", doc: { ref: key.slice(4), slug: null, title: "Unknown document", kind: "document", encrypted: false } };
  }
  return app(key);
};

const NAMES: [string | null, string | null][] = [
  ["Asha Menon", "asha@example.com"], [null, null], ["Daniel Okafor", "daniel@example.com"], [null, null], [null, null],
  ["Lena Fischer", "lena@example.com"], [null, null], ["Wei Tan", "wei@example.com"], [null, null], [null, null],
  ["Sam Carter", "sam@example.com"], [null, null], ["Priya Raman", "priya@example.com"], [null, null],
];
const PLACES: [string, string][] = [["Bengaluru", "IN"], ["Austin", "US"], ["London", "GB"], ["Berlin", "DE"], ["Toronto", "CA"], ["Singapore", "SG"]];
const DEVICES = ["Desktop", "Mobile", "Desktop", "Tablet", "Desktop"];
const BROWSERS = ["Chrome", "Safari", "Firefox", "Edge", "Samsung Internet"];
const OSES = ["Mac OS X", "iOS", "Windows", "Android", "Linux"];
const REFS = ["linkedin.com", "google.com", "$direct", "news.ycombinator.com", "t.co", "chatgpt.com", "bing.com"];

type Ev = TimelineEvent;
type Built = { row: PersonRow; events: Ev[]; recordings: Recording[] };

function ev(r: () => number, t: number, event: string, kind: Kind, label: string, page: PageRef | null, session: string, detail: string | null = null): Ev {
  return { id: uuid(r), t: new Date(t).toISOString(), event, kind, label, detail, page, session };
}

function sessionScript(r: () => number, start: number, sid: string, last: boolean, identified: boolean): Ev[] {
  const out: Ev[] = [];
  let t = start;
  const step = () => (t += (1 + r() * 2.2) * MIN);
  const reader = r() < 0.4;
  if (reader) {
    const d = DOCS[Math.floor(r() * 5)]!;
    out.push(ev(r, t, "$pageview", "pageview", `Opened ${d.kind === "artifact" ? "file " : ""}“${d.title}”`, docPage(d), sid, d.kind === "artifact" ? "file" : null));
    for (const pct of [25, 50, 75, 100]) {
      if (r() < 0.25) break;
      step();
      out.push(ev(r, t, "read_progress", "read", `Read ${pct}% of “${d.title}”`, docPage(d), sid, `${Math.round(20 + r() * 90)}s engaged · ~4 min read`));
    }
    step();
    out.push(ev(r, t, "$autocapture", "click", "Clicked “Make your own”", docPage(d), sid, `→ /new · ${d.title}`));
    step();
  }
  out.push(ev(r, t, "$pageview", "pageview", "Viewed “Home”", app("/"), sid, "/"));
  step();
  out.push(ev(r, t, "landing_cta", "cta", "Clicked a call to action", app("/"), sid, "start_writing · in hero"));
  step();
  out.push(ev(r, t, "$pageview", "pageview", "Viewed “Editor”", app("/new"), sid, "/new"));
  step();
  out.push(ev(r, t, "$autocapture", "form", "Changed an input", app("/new"), sid, "Editor"));
  if (r() < 0.4) {
    step();
    out.push(ev(r, t, "$rageclick", "rage", "Rage-clicked “Publish”", app("/new"), sid, "Editor"));
  }
  if (r() < 0.75) {
    step();
    out.push(ev(r, t, "$autocapture", "click", "Clicked “Publish”", app("/new"), sid, "Editor"));
    out.push(ev(r, t + 900, "doc_published", "publish", "Published a document", app("/new"), sid, r() < 0.3 ? "link · password" : "public"));
    const d = DOCS[3]!;
    step();
    out.push(ev(r, t, "$pageview", "pageview", `Opened “${d.title}”`, docPage(d), sid));
    if (r() < 0.6) {
      step();
      out.push(ev(r, t, "doc_copy_link", "share", `Copied the link to “${d.title}”`, docPage(d), sid));
    }
    if (r() < 0.2) {
      step();
      out.push(ev(r, t, "doc_export_pdf", "export", `Exported “${d.title}” as PDF`, docPage(d), sid));
    }
  }
  if (r() < 0.15) {
    step();
    out.push(ev(r, t, "$exception", "error", "Hit a JS error", app("/new"), sid, "TypeError: Cannot read properties of undefined (reading 'blocks')"));
  }
  if (last && identified) {
    step();
    out.push(ev(r, t, "logged_in", "signin", "Signed in", app("/login"), sid, "Sign in"));
    step();
    out.push(ev(r, t, "$pageview", "pageview", "Viewed “Dashboard”", app("/dashboard"), sid, "/dashboard"));
  }
  return out;
}

let cache: Built[] | null = null;

function people(): Built[] {
  if (cache) return cache;
  const r = rng(42);
  cache = NAMES.map(([name, email], i) => {
    const id = uuid(r);
    const distinct = email ? `6ace70${String(i).padStart(2, "0")}fa2b9e0471f17fe${i.toString(16)}`.slice(0, 24) : uuid(r);
    const [city, country] = PLACES[i % PLACES.length]!;
    const lastSeen = NOW - (i * i * 37 + 4) * MIN;
    const nSessions = 2 + Math.floor(r() * 4);
    const events: Ev[] = [];
    const recordings: Recording[] = [];
    for (let s = 0; s < nSessions; s++) {
      const sid = uuid(r);
      const start = lastSeen - s * (6 + r() * 30) * 60 * MIN - 25 * MIN;
      const evs = sessionScript(r, start, sid, s === 0, !!email);
      events.push(...evs.reverse());
      if (s < nSessions - 1) {
        const span = (new Date(evs[0]!.t).getTime() - new Date(evs[evs.length - 1]!.t).getTime()) / 1000 + 40;
        const trail: PageRef[] = [];
        for (const e of [...evs].reverse()) if (e.kind === "pageview" && e.page && trail[trail.length - 1]?.key !== e.page.key) trail.push(e.page);
        recordings.push({
          id: sid,
          start: new Date(start).toISOString(),
          end: new Date(start + span * 1000).toISOString(),
          duration: Math.round(span),
          active: Math.round(span * 0.62),
          clicks: evs.filter((e) => e.kind === "click").length + 2,
          keys: 30 + Math.floor(r() * 200),
          errors: s === 2 ? 2 : evs.some((e) => e.kind === "error") ? 1 : 0,
          start_page: trail.find((p) => !p.doc) ?? app("/"),
          person_id: id,
          who: email ?? `anon ${distinct.slice(-6)}`,
          identified: !!email,
          ongoing: i === 0 && s === 0 && NOW - start < 40 * MIN,
          viewed: s > 1,
          pages: trail.slice(0, 6),
          more_pages: Math.max(0, trail.length - 6),
          pageviews: trail.length,
          rage: evs.filter((e) => e.kind === "rage").length,
          dead: s === 3 ? 2 : 0,
          expires_soon: i > 10 && s > 0,
          app_url: `https://us.posthog.com/project/0/replay/${sid}`,
        });
      }
    }
    events.sort((a, b) => (a.t < b.t ? 1 : -1));
    const pv = events.filter((e) => e.kind === "pageview");
    const counts = new Map<string, number>();
    for (const e of pv) counts.set(e.page!.key, (counts.get(e.page!.key) ?? 0) + 1);
    const row: PersonRow = {
      id,
      distinct_id: distinct,
      email,
      name,
      identified: !!email,
      first_seen: events[events.length - 1]!.t,
      last_seen: events[0]!.t,
      sessions: nSessions,
      pageviews: pv.length,
      events: events.length,
      country,
      city,
      device: DEVICES[i % DEVICES.length]!,
      browser: BROWSERS[i % BROWSERS.length]!,
      os: OSES[i % OSES.length]!,
      referrer: REFS[i % REFS.length] === "$direct" ? "direct" : REFS[i % REFS.length]!,
      top_pages: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => pageOf(k)),
    };
    return { row, events, recordings };
  });
  return cache;
}

const STATUS: PhStatus = { configured: true, region: "us", ui_host: "https://us.posthog.com", project_id: "0", include_local: false, missing: [] };

function live(): LiveRes {
  const ps = people();
  const events: StreamEvent[] = ps.slice(0, 6).flatMap((p) =>
    p.events.slice(0, 7).map((e) => ({
      ...e,
      person_id: p.row.id,
      who: p.row.email ?? `anon ${(p.row.distinct_id ?? p.row.id).slice(-6)}`,
      identified: p.row.identified,
      country: p.row.country,
      city: p.row.city,
      device: p.row.device,
    })),
  );
  events.sort((a, b) => (a.t < b.t ? 1 : -1));
  return { configured: true, live: 3, pages: [{ page: app("/new"), n: 2 }, { page: docPage(DOCS[0]!), n: 1 }], events: events.slice(0, 60) };
}

function paths(days: number): PathsRes {
  const r = rng(7 + days);
  const sessions: string[][] = [];
  const reached: number[] = [];
  const n = Math.round(260 * Math.min(1, days / 7) + 40);
  for (let i = 0; i < n; i++) {
    const x = r();
    const entry = x < 0.42 ? "/" : x < 0.62 ? `doc:${DOCS[0]!.ref}` : x < 0.78 ? "/new" : x < 0.9 ? `doc:${DOCS[1]!.ref}` : "/upload";
    const seq = [entry];
    let step = entry === "/new" || entry === "/upload" ? 1 : 0;
    if (r() < 0.6) seq.push(r() < 0.7 ? "/new" : "/builder"), (step = Math.max(step, 1));
    if (step >= 1 && r() < 0.45) seq.push(`doc:${DOCS[3]!.ref}`), (step = 2);
    if (step >= 2 && r() < 0.5) step = 3;
    if (step >= 3 && r() < 0.35) seq.push("/dashboard"), (step = 4);
    sessions.push(seq);
    reached.push(step);
  }
  const people = Math.round(n * 0.73);
  const count = (f: (s: string[]) => string) => {
    const m = new Map<string, number>();
    for (const s of sessions) m.set(f(s), (m.get(f(s)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const views = new Map<string, number>();
  for (const s of sessions) for (const k of s) views.set(k, (views.get(k) ?? 0) + 1);
  const multi = new Map<string, number>();
  for (const s of sessions) if (s.length > 1) multi.set(s.slice(0, 4).join("\u0000"), (multi.get(s.slice(0, 4).join("\u0000")) ?? 0) + 1);
  const labels = ["Landed", "Opened a creator", "Published", "Shared a link", "Signed in"];
  const keys = ["land", "creator", "publish", "share", "signin"];
  return {
    configured: true,
    days,
    sessions: n,
    people,
    truncated: false,
    entries: count((s) => s[0]!).slice(0, 12).map(([k, v]) => ({ page: pageOf(k), n: v })),
    exits: count((s) => s[s.length - 1]!).slice(0, 8).map(([k, v]) => ({ page: pageOf(k), n: v })),
    paths: [...multi.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => ({ steps: k.split("\u0000").map(pageOf), n: v })),
    funnel: keys.map((key, i) => ({ key, label: labels[i]!, n: Math.round((reached.filter((x) => x >= i).length / n) * people) })),
    pages: [...views.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => ({ page: pageOf(k), views: v, visitors: Math.round(v * 0.7) })),
  };
}

function page(key: string, days: number): PageDetailRes {
  const p = pageOf(key);
  const isDoc = !!p.doc;
  const names = isDoc
    ? ["Make your own", "Copy link", "Export PDF", "Contents", "Open in Google Docs"]
    : key === "/new"
      ? ["Publish", "Markdown", "Preview", "Settings", "Encrypt", "Expires in", "Password", "Upload instead"]
      : ["Start writing", "Upload a file", "Sign in", "README builder", "Share files", "Pricing", "Privacy choices"];
  const top = 140 * Math.min(1, days / 7) + 20;
  return {
    configured: true,
    page: p,
    days,
    clicks: names.map((text, i) => ({
      text,
      tag: i % 3 === 1 ? "a" : "button",
      n: Math.round(top / (i + 1.2)),
      rage: text === "Publish" ? 4 : 0,
      dead: text === "Preview" ? 2 : 0,
    })),
    depth: isDoc ? [25, 50, 75, 100].map((pct, i) => ({ pct, readers: Math.round(84 * 0.68 ** i) })) : null,
    heatmap_url: isDoc ? null : `https://us.posthog.com/project/0/heatmaps?pageURL=${encodeURIComponent(`https://www.markdrop.in${key}`)}`,
    toolbar_url: "https://us.posthog.com/project/0/toolbar",
    site_url: isDoc ? null : `https://www.markdrop.in${key}`,
  };
}

/** A tiny synthetic rrweb recording: a page with a heading and a button, and a moving pointer. */
function snapshots(id: string): SnapshotsRes {
  if (id.endsWith("0")) return { configured: true, id, found: false, events: [], app_url: "https://us.posthog.com" };
  const t0 = NOW - 120_000;
  let nid = 1;
  const el = (tagName: string, attributes: Record<string, string>, childNodes: unknown[]) => ({ type: 2, tagName, attributes, childNodes, id: nid++ });
  const text = (textContent: string) => ({ type: 3, textContent, id: nid++ });
  const doc = {
    type: 0,
    id: nid++,
    childNodes: [
      el("html", {}, [
        el("head", {}, [el("style", {}, [text("body{margin:0;font:16px system-ui;background:#0f1115;color:#e8eaf0}main{padding:48px}button{margin-top:24px;padding:12px 20px;border-radius:8px;border:0;background:#5b8def;color:#fff;font-weight:600}")])]),
        el("body", {}, [el("main", {}, [el("h1", {}, [text("Write it once. Share it anywhere.")]), el("p", {}, [text("Preview replay (development fixture).")]), el("button", {}, [text("Start writing")])])]),
      ]),
    ],
  };
  const events: unknown[] = [
    { type: 4, timestamp: t0, data: { href: "https://www.markdrop.in/", width: 1280, height: 720 } },
    { type: 2, timestamp: t0 + 10, data: { node: doc, initialOffset: { top: 0, left: 0 } } },
  ];
  for (let i = 1; i <= 40; i++) {
    events.push({ type: 3, timestamp: t0 + i * 800, data: { source: 1, positions: [{ x: 80 + i * 14, y: 120 + Math.round(Math.sin(i / 3) * 60) + i * 3, id: 1, timeOffset: 0 }] } });
  }
  return { configured: true, id, found: true, events, app_url: `https://us.posthog.com/project/0/replay/${id}` };
}


// ── Live section (`/admin?tab=live&preview=1`) ───────────────────────────────
//
// A small simulated site: six sessions active over the last half hour, two of them "right now",
// with new events every few seconds (each poll sees what happened since the last), and two
// ongoing recordings whose snapshots grow on every live poll.

type LiveSim = { sessions: LiveSession[]; events: StreamEvent[]; next: number; r: () => number };
let sim: LiveSim | null = null;

const LIVE_SCRIPT: { event: string; kind: Kind; label: string; page: string; detail?: string }[] = [
  { event: "$pageview", kind: "pageview", label: "Viewed “Home”", page: "/" },
  { event: "landing_cta", kind: "cta", label: "Clicked a call to action", page: "/", detail: "start_writing · in hero" },
  { event: "$pageview", kind: "pageview", label: "Viewed “Editor”", page: "/new" },
  { event: "$autocapture", kind: "form", label: "Changed an input", page: "/new", detail: "Editor" },
  { event: "$autocapture", kind: "click", label: "Clicked “Preview”", page: "/new", detail: "Editor" },
  { event: "$rageclick", kind: "rage", label: "Rage-clicked “Publish”", page: "/new", detail: "Editor" },
  { event: "doc_published", kind: "publish", label: "Published a document", page: "/new", detail: "public" },
  { event: `$pageview`, kind: "pageview", label: `Opened “${DOCS[0]!.title}”`, page: `doc:${DOCS[0]!.ref}` },
  { event: "read_progress", kind: "read", label: `Read 50% of “${DOCS[0]!.title}”`, page: `doc:${DOCS[0]!.ref}`, detail: "48s engaged · ~4 min read" },
  { event: "doc_copy_link", kind: "share", label: `Copied the link to “${DOCS[0]!.title}”`, page: `doc:${DOCS[0]!.ref}` },
  { event: "$exception", kind: "error", label: "Hit a JS error", page: "/upload", detail: "TypeError: Failed to fetch" },
  { event: "$pageview", kind: "pageview", label: "Viewed “Upload a file”", page: "/upload" },
];

function liveSim(): LiveSim {
  if (sim) return sim;
  const r = rng(99);
  const now = Date.now();
  const ps = people();
  const sessions: LiveSession[] = ps.slice(0, 6).map((p, i) => {
    const sid = uuid(r);
    const last = now - [8, 35, 70, 4 * 60, 11 * 60, 26 * 60][i]! * 1000;
    const started = last - (3 + i * 4) * MIN;
    return {
      id: sid,
      person_id: p.row.id,
      distinct_id: p.row.distinct_id,
      who: p.row.email ?? `anon ${(p.row.distinct_id ?? p.row.id).slice(-6)}`,
      identified: p.row.identified,
      email: p.row.email,
      name: p.row.name,
      country: p.row.country,
      city: p.row.city,
      device: p.row.device,
      browser: p.row.browser,
      started: new Date(started).toISOString(),
      started_before_window: i === 5,
      last_seen: new Date(last).toISOString(),
      events: 6 + i * 3,
      events_now: i < 2 ? 3 + i : 0,
      pageviews: 2 + (i % 3),
      page: pageOf(LIVE_SCRIPT[(i * 3) % LIVE_SCRIPT.length]!.page),
      last: { id: uuid(r), t: new Date(last).toISOString(), event: "$pageview", kind: "pageview", label: "Viewed “Home”", detail: null, page: app("/") },
      recording: i < 2 || i === 3
        ? { id: sid, ongoing: i < 2, start: new Date(started).toISOString(), end: null, duration: Math.round((last - started) / 1000), app_url: `https://us.posthog.com/project/0/replay/${sid}` }
        : null,
    };
  });
  const events: StreamEvent[] = [];
  sim = { sessions, events, next: 0, r };
  // Backfill: a few events per session before now.
  sessions.forEach((s, i) => {
    for (let k = 0; k < 4; k++) addLiveEvent(sim!, i, new Date(s.last_seen).getTime() - (3 - k) * 50_000);
  });
  return sim;
}

function addLiveEvent(s: LiveSim, i: number, t: number) {
  const sess = s.sessions[i]!;
  const step = LIVE_SCRIPT[s.next++ % LIVE_SCRIPT.length]!;
  const page = pageOf(step.page);
  const e: StreamEvent = {
    id: uuid(s.r), t: new Date(t).toISOString(), event: step.event, kind: step.kind, label: step.label, detail: step.detail ?? null,
    page, session: sess.id, person_id: sess.person_id, who: sess.who, identified: sess.identified,
    country: sess.country, city: sess.city, device: sess.device,
  };
  s.events.unshift(e);
  if (t >= new Date(sess.last_seen).getTime()) {
    sess.last_seen = e.t;
    sess.last = { id: e.id, t: e.t, event: e.event, kind: e.kind, label: e.label, detail: e.detail, page };
    if (e.kind === "pageview") sess.page = page;
    if (sess.recording) sess.recording.duration = Math.round((t - new Date(sess.started!).getTime()) / 1000);
  }
  sess.events += 1;
}

function liveFeed(since: string | null): LiveFeedRes {
  const s = liveSim();
  const now = Date.now();
  // Since the last poll: one or two of the "now" sessions did something.
  const lastT = s.events[0] ? new Date(s.events[0].t).getTime() : now - 30_000;
  for (let t = lastT + 3_000 + s.r() * 4_000; t < now - 1_000; t += 3_000 + s.r() * 6_000) addLiveEvent(s, s.r() < 0.6 ? 0 : 1, t);
  s.events.splice(200);
  s.sessions.sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
  const nowCut = now - 5 * MIN;
  const on = s.sessions.filter((x) => new Date(x.last_seen).getTime() >= nowCut);
  const pages = new Map<string, { page: PageRef; n: number }>();
  for (const x of on) if (x.page) pages.set(x.page.key, { page: x.page, n: (pages.get(x.page.key)?.n ?? 0) + 1 });
  const cut = since ? new Date(since).getTime() - 180_000 : 0;
  return {
    configured: true,
    as_of: new Date(now).toISOString(),
    window_min: 30,
    now_min: 5,
    counts: {
      visitors_now: on.length,
      sessions: s.sessions.length,
      events_now: s.events.filter((e) => new Date(e.t).getTime() >= nowCut).length,
      pageviews: s.sessions.reduce((a, x) => a + x.pageviews, 0),
      capped: false,
    },
    sessions: s.sessions.map((x) => ({ ...x, last: { ...x.last }, recording: x.recording && { ...x.recording } })),
    pages: [...pages.values()].sort((a, b) => b.n - a.n),
    events: (since ? s.events.filter((e) => new Date(e.t).getTime() > cut) : s.events.slice(0, 60)).map((e) => ({ ...e })),
    cursor: s.events[0]?.t ?? since,
    recordings_error: null,
    // `&stale=1`: as if PostHog were rate-limiting us and this were the last good answer.
    stale: new URLSearchParams(window.location.search).get("stale") === "1"
      ? { age_s: 240, as_of: new Date(now - 240_000).toISOString(), reason: "rate_limited", message: "PostHog is rate-limiting us", retry_in: 45 }
      : null,
  };
}

/** A recording that keeps growing: each `after` poll returns pointer moves up to ~20 s ago. */
const liveRecs = new Map<string, { t0: number; edge: number; key: number }>();
function liveSnapshots(id: string, after: number | null): SnapshotsRes {
  let st = liveRecs.get(id);
  const now = Date.now();
  if (!st || after === null) {
    const base = snapshots(id);
    const t0 = now - 120_000;
    const events = base.events as { type: number; timestamp: number; data: unknown }[];
    const shift = t0 - events[0]!.timestamp;
    for (const e of events) e.timestamp += shift;
    st = { t0, edge: events[events.length - 1]!.timestamp, key: 4 };
    liveRecs.set(id, st);
    return { ...base, events, last_key: st.key, live_edge: new Date(st.edge).toISOString() };
  }
  const events: unknown[] = [];
  const until = now - 20_000;
  for (let t = st.edge + 400; t < until; t += 400) {
    const i = (t - st.t0) / 400;
    events.push({ type: 3, timestamp: t, data: { source: 1, positions: [{ x: 200 + Math.round(Math.cos(i / 5) * 160), y: 260 + Math.round(Math.sin(i / 4) * 120), id: 1, timeOffset: 0 }] } });
  }
  if (events.length) {
    st.edge = (events[events.length - 1] as { timestamp: number }).timestamp;
    st.key += 1;
  }
  return { configured: true, id, found: true, events, last_key: st.key, live_edge: new Date(st.edge).toISOString(), app_url: `https://us.posthog.com/project/0/replay/${id}` };
}

export async function resolveFixture(path: string, params: Params): Promise<unknown> {
  await new Promise((res) => setTimeout(res, 120));
  const days = Number(params.days ?? 30) || 30;
  const q = new URLSearchParams(window.location.search);
  if (path === "/status") return q.get("setup") === "1" ? { ...STATUS, configured: false, project_id: null, missing: ["MARKDROP_POSTHOG_PROJECT_ID", "MARKDROP_POSTHOG_PERSONAL_API_KEY"] } : STATUS;
  if (path === "/live") return live();
  if (path === "/live/feed") return liveFeed(params.since ? String(params.since) : null);
  if (path === "/people") {
    const term = String(params.q ?? "").toLowerCase();
    const kind = String(params.kind ?? "all");
    const rows = people()
      .map((p) => p.row)
      .filter((p) => (kind === "identified" ? p.identified : kind === "anonymous" ? !p.identified : true))
      .filter((p) => !term || [p.email, p.name, p.distinct_id, p.id, p.city, p.country].some((v) => v?.toLowerCase().includes(term)));
    return { configured: true, people: rows, days, capped: false } satisfies PeopleRes;
  }
  if (path === "/person") {
    const id = String(params.id ?? "");
    const p = people().find((x) => x.row.id === id || x.row.distinct_id === id);
    if (!p) return undefined;
    const cutoff = NOW - days * 86_400_000;
    return {
      configured: true,
      person: {
        id: p.row.id, distinct_id: p.row.distinct_id, email: p.row.email, name: p.row.name, identified: p.row.identified,
        created_at: p.row.first_seen, country: p.row.country, city: p.row.city, device: p.row.device, browser: p.row.browser, os: p.row.os,
        referrer: p.row.referrer, app_url: "https://us.posthog.com", account: p.row.identified ? { id: p.row.distinct_id!, email: p.row.email!, name: p.row.name, created_at: p.row.first_seen, documents: 7 } : null,
      },
      events: p.events.filter((e) => new Date(e.t).getTime() > cutoff),
      recordings: q.get("scope") === "1" ? [] : p.recordings,
      recordings_error: q.get("scope") === "1" ? { error: "The personal API key is missing the “session_recording:read” scope.", scope: "session_recording:read" } : null,
      days,
      truncated: false,
    } satisfies PersonRes;
  }
  // `&scope=1`: recordings fail as if the key lacked session_recording:read (the 424 card).
  if (q.get("scope") === "1" && (path === "/recordings" || path.endsWith("/snapshots"))) {
    const { JourneysError } = await import("./api");
    throw new JourneysError(424, "The personal API key is missing the “session_recording:read” scope. Add it in PostHog → Account settings → Personal API keys → edit.", "session_recording:read");
  }
  if (path === "/recordings") {
    let all = people().slice(0, 9).flatMap((p) => p.recordings.slice(0, 2));
    if (params.person) all = all.filter((r) => r.person_id === params.person);
    if (params.path) all = all.filter((r) => r.pages.some((pg) => pg.key === params.path));
    all.sort((a, b) => (a.start < b.start ? 1 : -1));
    return { configured: true, recordings: all, has_next: false, filter_page: params.path ? pageOf(String(params.path)) : null } satisfies RecordingsRes;
  }
  if (path.startsWith("/recordings/") && path.endsWith("/snapshots")) {
    const id = path.split("/")[2]!;
    const ongoing = sim?.sessions.some((x) => x.recording?.id === id && x.recording.ongoing);
    if (ongoing) return liveSnapshots(id, params.after === undefined || params.after === null ? null : Number(params.after));
    return snapshots(id);
  }
  if (path === "/paths") return paths(days);
  if (path === "/page") return page(String(params.path ?? "/"), days);
  return undefined;
}
