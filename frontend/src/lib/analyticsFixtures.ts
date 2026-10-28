/**
 * Development-only sample data for the analytics pages (`?fixture=1`), shaped exactly like the API
 * (build spec §3) and matching the approved design boards. Loaded on demand by lib/analytics.ts and
 * never in production. Slugs: product-demo (video), getting-started (markdown), seed-deck (PDF),
 * podcast-ep-12 (audio), brand-kit (image), fresh-doc (no engagement data yet), not-mine (403).
 */
import {
  AnalyticsError, fnv1a32Utf8,
  type AnalyticsDoc, type AnalyticsRange, type AudienceAnalytics, type ContentAnalytics, type HomeAnalytics, type Insight,
  type Kpi, type LiveAnalytics, type MediaAnalytics, type Overview, type PagesAnalytics, type VersionsAnalytics,
} from "./analytics";

const DAY = 86400000;
const today = () => new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime();
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();

const DEMO_VIEWS = [38, 41, 35, 44, 52, 47, 39, 36, 58, 61, 55, 49, 63, 70, 66, 58, 51, 72, 80, 77, 96, 214, 168, 121, 104, 98, 90, 86, 93, 88];

function days(range: AnalyticsRange, base: number[]) {
  const n = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : 120;
  const end = today();
  return Array.from({ length: n }, (_, i) => {
    const v = base[(base.length - n + i + base.length * 4) % base.length]!;
    const views = Math.max(0, Math.round(v * (i < n - 30 ? 0.6 : 1)));
    return { date: iso(end - (n - 1 - i) * DAY), views, people: Math.round(views * 0.79) };
  });
}

const GUIDE_MD = `# Getting started with Acme

## Overview
Acme gives you one API for everything.

## Install the SDK
\`\`\`bash
npm install @acme/sdk
\`\`\`

## Authenticate
\`\`\`js
const acme = new Acme({ apiKey: process.env.ACME_KEY })
\`\`\`

### Create an API key
Open [the dashboard](https://dashboard.acme.com/keys).

## Your first request
\`\`\`bash
curl -H "Authorization: Bearer …" https://api.acme.com/v1/ping
\`\`\`

## Pricing and limits
See [pricing](https://acme.com/pricing).

## Webhooks
Webhooks are signed.

## Troubleshooting
Check [status](https://status.acme.com).
`;

export function fixtureMarkdown(slug: string): string | null {
  return slug === "getting-started" || slug === "fresh-doc" ? GUIDE_MD : null;
}

const DOCS: Record<string, AnalyticsDoc> = {
  "product-demo": { slug: "product-demo", title: "Product demo — full cut", kind: "video", renderer: "video", mime: "video/mp4", duration_s: 352, file_version: 4, workspace: { id: "ws1", name: "Acme" }, address: "docs.acme.com/guides/product-demo", created_at: iso(today() - 60 * DAY) },
  "getting-started": { slug: "getting-started", title: "Getting started with Acme", kind: "doc", file_version: 1, workspace: { id: "ws1", name: "Acme" }, address: "docs.acme.com/guides/getting-started", created_at: iso(today() - 90 * DAY) },
  "seed-deck": { slug: "seed-deck", title: "Seed deck — October.pdf", kind: "pdf", renderer: "pdf", mime: "application/pdf", npages: 12, file_version: 1, address: "markdrop.in/seed-deck", created_at: iso(today() - 40 * DAY) },
  "podcast-ep-12": { slug: "podcast-ep-12", title: "Podcast, episode 12", kind: "audio", renderer: "audio", mime: "audio/mpeg", duration_s: 1860, file_version: 1, address: "markdrop.in/podcast-ep-12", created_at: iso(today() - 20 * DAY) },
  "brand-kit": { slug: "brand-kit", title: "Brand kit", kind: "other", renderer: "image", mime: "image/png", file_version: 2, address: "markdrop.in/brand-kit", created_at: iso(today() - 70 * DAY) },
  "fresh-doc": { slug: "fresh-doc", title: "Q4 roadmap (draft)", kind: "doc", file_version: 1, address: "markdrop.in/fresh-doc", created_at: iso(today() - 5 * DAY) },
};

const k = (key: string, label: string, value: number, unit: Kpi["unit"], note?: string, prev?: number): Kpi => ({ key, label, value, unit, note, prev });

function kpisFor(slug: string, range: AnalyticsRange): Kpi[] {
  const prev = (v: number) => (range === "all" ? undefined : v);
  switch (DOCS[slug]?.kind) {
    case "video":
      return [
        k("views", "Views", 2418, "count", undefined, prev(2159)),
        k("people", "Unique viewers", 1906, "count", "412 came back"),
        k("watch_time", "Watch time", 312, "hours", "9.8 min per viewer"),
        k("avg_watched", "Average watched", 64, "percent", "38% finished"),
        k("played", "Pressed play", 81, "percent", "of people who opened it"),
      ];
    case "audio":
      return [
        k("views", "Plays", 640, "count", undefined, prev(512)),
        k("people", "Unique listeners", 502, "count", "88 came back"),
        k("watch_time", "Listen time", 96, "hours", "11 min per listener"),
        k("avg_watched", "Average listened", 41, "percent", "17% finished"),
        k("played", "Pressed play", 92, "percent", "of people who opened it"),
      ];
    case "pdf":
      return [
        k("views", "Views", 214, "count", undefined, prev(190)),
        k("people", "Unique viewers", 188, "count", "26 came back"),
        k("reached_end", "Reached the end", 34, "percent", "got to page 12"),
        k("read_time", "Time spent reading", 190, "seconds", "typical reader"),
        k("pages_npages", "Pages", 12, "count", "7 reached by most"),
      ];
    case "other":
      return [
        k("views", "Views", 333, "count", undefined, prev(351)),
        k("people", "Unique viewers", 281, "count"),
        k("time", "Time spent", 24, "seconds", "typical viewer"),
        k("returning", "Came back", 52, "count", "18% of viewers"),
      ];
    default:
      if (slug === "fresh-doc") {
        return [
          k("views", "Views", 41, "count", undefined, prev(12)),
          k("people", "Readers", 33, "count"),
          k("read_all", "Read it all", 0, "percent"),
          k("read_time", "Time spent reading", 0, "seconds"),
          k("copies_clicks", "Copies and clicks", 0, "count"),
        ];
      }
      return [
        k("views", "Views", 1611, "count", undefined, prev(1402)),
        k("people", "Readers", 1284, "count", "186 came back"),
        k("read_all", "Read it all", 41, "percent", "reached the last section"),
        k("read_time", "Time spent reading", 220, "seconds", "typical reader, active time only"),
        k("copies_clicks", "Copies and clicks", 962, "count", "code copied 724 · links 238"),
      ];
  }
}

function insightsFor(slug: string): Insight[] {
  switch (DOCS[slug]?.kind) {
    case "video":
      return [
        { key: "drop", severity: "warning", thumb: "2:14", title: "Most viewers leave at 2:14, the pricing slide", body: "18% of the people still watching stop here. It is the biggest drop in the video.", cta: { label: "See the moment", tab: "video" } },
        { key: "version", severity: "success", thumb: "v3 → v4", title: "Cutting the intro worked", body: "Since version 4, 81% are still watching at 0:30, up from 62% in version 3.", cta: { label: "Compare versions", tab: "versions" } },
        { key: "qoe", severity: "warning", thumb: "QoE", title: "1 in 4 phone viewers waited over 5 seconds to start", body: "Mostly on mobile networks in India and Brazil. A lighter copy would start faster.", cta: { label: "See playback quality", tab: "video" } },
      ];
    case "doc":
      return slug === "fresh-doc" ? [] : [
        { key: "section_drop", severity: "warning", title: "Readers leave at user-content-pricing-and-limits", body: "Reach falls from 71% to 43% at this section.", cta: { label: "See sections", tab: "content" } },
        { key: "channel", severity: "info", title: "Slack readers read twice as far", body: "Slack sends 34% of your readers, and 72% of them read it all.", cta: { label: "See audience", tab: "audience" } },
      ];
    case "pdf":
      return [{ key: "page_drop", severity: "warning", thumb: "p. 8", title: "Page 7 loses readers", body: "22% of the people still reading stop after page 7.", cta: { label: "See pages", tab: "pages" } }];
    default:
      return [];
  }
}

function overview(slug: string, range: AnalyticsRange): Overview {
  const d = DOCS[slug]!;
  const fresh = slug === "fresh-doc";
  const base = fresh ? [0, 0, 0, 1, 2, 3, 2, 4, 5, 6, 5, 6, 6, 7] : DEMO_VIEWS;
  const daily = days(range, base).map((x) => (d.kind === "pdf" ? { ...x, views: Math.round(x.views / 10), people: Math.round(x.people / 10) } : x));
  return {
    doc: d,
    range,
    has_engagement: !fresh,
    tracking_since: fresh ? iso(today() - 1 * DAY) : iso(today() - 120 * DAY),
    live: d.kind === "video" ? 3 : d.kind === "doc" && !fresh ? 5 : d.kind === "pdf" ? 1 : 0,
    kpis: kpisFor(slug, range),
    daily,
    versions_marks: d.kind === "video" ? [{ date: iso(today() - 7 * DAY), version: 4 }] : d.kind === "other" ? [{ date: iso(today() - 12 * DAY), version: 2 }] : [],
    sources: [
      { channel: "Slack", views: 812 }, { channel: "Direct", views: 604 }, { channel: "LinkedIn", views: 418 },
      { channel: "Email", views: 301 }, { channel: "Search", views: 183 },
    ],
    insights: insightsFor(slug),
  };
}

function retention(t: number) {
  let r = 1 - 0.19 * Math.min(1, t / 30) - 0.0008 * t;
  if (t > 134) r -= 0.13;
  if (t > 220 && t < 236) r += 0.05 * Math.sin(((t - 220) / 16) * Math.PI);
  if (t > 300) r -= 0.08 * ((t - 300) / 52);
  return Math.max(0.36, r);
}

function media(slug: string): MediaAnalytics {
  const audio = DOCS[slug]?.kind === "audio";
  const dur = audio ? 1860 : 352;
  const step = Math.max(1, dur / 600);
  const pts: { t: number; pct: number }[] = [];
  for (let t = 0; t <= dur; t += step) pts.push({ t: Math.round(t), pct: Math.round(retention((t / dur) * 352) * 1000) / 10 });
  const heat = Array.from({ length: 60 }, (_, i) => (i >= 36 && i <= 40 ? 0.95 : i >= 4 && i <= 6 ? 0 : i === 22 ? 0.75 : 0.35));
  return {
    ver: audio ? 1 : 4,
    dur,
    sessions: audio ? 590 : 1958,
    viewers: audio ? 502 : 1906,
    retention: pts,
    rewatch: heat,
    moments: audio ? [
      { t: 30, kind: "hold", pct: 88, title: "88% still here at 0:30", body: "A strong opening." },
      { t: 700, kind: "drop", delta: -9, title: "Biggest drop: 11:40 (−9%)", body: "Where the interview starts." },
    ] : [
      { t: 30, kind: "hold", pct: 81, title: "81% still here at 0:30", body: "A strong opening. Typical for your videos is 70%." },
      { t: 134, kind: "drop", delta: -13, title: "Biggest drop: 2:14 (−13%)", body: "The pricing slide. Try moving it later." },
      { t: 220, kind: "rewatch", title: "Rewatched: 3:36–3:52", body: "Watched 2.3× on average. The setup demo." },
    ],
    speeds: [{ rate: "1", pct: 61 }, { rate: "1.25", pct: 14 }, { rate: "1.5", pct: 19 }, { rate: "2", pct: 6 }],
    fullscreen_pct: 22,
    muted_pct: 9,
    pip_pct: 4,
    qoe: audio ? null : {
      startup_p50_ms: 1200, startup_p95_ms: 4800, stalled_pct: 9, failed_pct: 0.6, failed_n: 11,
      failed_by: [{ reason: "expired", n: 8 }, { reason: "network", n: 3 }],
      phone_slow_pct: 24, phone_slow_by: [{ country: "IN", pct: 31 }, { country: "BR", pct: 28 }],
      bitrate_kbps: 12000,
      suggestion: "This file streams at 12 Mbps. Viewers on slower connections wait or stall. Upload a 1080p copy at about 5 Mbps as version 5, and compare.",
    },
    versions: audio ? [] : [
      { version: 4, created_at: iso(today() - 7 * DAY), sessions: 812 },
      { version: 3, created_at: iso(today() - 30 * DAY), sessions: 940 },
      { version: 2, created_at: iso(today() - 45 * DAY), sessions: 160 },
      { version: 1, created_at: iso(today() - 60 * DAY), sessions: 46 },
    ],
  };
}

function content(): ContentAnalytics {
  const blocks = ["npm install @acme/sdk", "const acme = new Acme({ apiKey: process.env.ACME_KEY })", 'curl -H "Authorization: Bearer …" https://api.acme.com/v1/ping'];
  const id = (s: string) => `user-content-${s}`;
  return {
    sessions: 1284,
    read_all_pct: 41,
    median_active_s: 220,
    sections: [
      { id: id("overview"), reached_pct: 100, median_s: 22 },
      { id: id("install-the-sdk"), reached_pct: 92, median_s: 48 },
      { id: id("authenticate"), reached_pct: 84, median_s: 65 },
      { id: id("create-an-api-key"), reached_pct: 80, median_s: 31 },
      { id: id("your-first-request"), reached_pct: 71, median_s: 44 },
      { id: id("pricing-and-limits"), reached_pct: 43, median_s: 12 },
      { id: id("webhooks"), reached_pct: 41, median_s: 39 },
      { id: id("troubleshooting"), reached_pct: 38, median_s: 27 },
    ],
    copies: [
      { hash: fnv1a32Utf8(blocks[0]!), section: id("install-the-sdk"), n: 412 },
      { hash: fnv1a32Utf8(blocks[1]!), section: id("authenticate"), n: 198 },
      { hash: fnv1a32Utf8(blocks[2]!), section: id("your-first-request"), n: 114 },
      { hash: "deadbeef", section: id("webhooks"), n: 9 },
    ],
    links: [
      { href: "dashboard.acme.com/keys", section: id("create-an-api-key"), n: 131 },
      { href: "github.com/acme/sdk-js", section: id("install-the-sdk"), n: 58 },
      { href: "acme.com/pricing", section: id("pricing-and-limits"), n: 33 },
      { href: "status.acme.com", section: id("troubleshooting"), n: 16 },
    ],
    prints: 12,
  };
}

function pages(): PagesAnalytics {
  const reach = [100, 96, 92, 89, 86, 81, 78, 61, 52, 45, 39, 34];
  const secs = [9, 14, 21, 26, 48, 31, 40, 22, 18, 12, 10, 8];
  const back = [2, 3, 5, 6, 12, 9, 21, 4, 3, 2, 1, 6];
  return {
    sessions: 214,
    npages: 12,
    reach: reach.map((pct, i) => ({ page: i + 1, pct })),
    time: secs.map((median_s, i) => ({ page: i + 1, median_s })),
    back: back.map((pct, i) => ({ page: i + 1, pct })),
    biggest_drop: { after_page: 7, pct: 22 },
  };
}

function audience(slug: string): AudienceAnalytics {
  const d = DOCS[slug]!;
  return {
    new: 1494,
    returning: 412,
    returning_ratio_note: d.kind === "video" ? "Returning viewers watch 2.1× longer." : null,
    devices: [{ device: "Desktop", pct: 58, engaged_pct: 44 }, { device: "Mobile", pct: 37, engaged_pct: 22 }, { device: "Tablet", pct: 5, engaged_pct: 35 }],
    countries: [
      { country: "IN", people: 612, engaged_pct: 58 }, { country: "US", people: 488, engaged_pct: 71 },
      { country: "DE", people: 201, engaged_pct: 66 }, { country: "BR", people: 174, engaged_pct: 49 },
      { country: "Other", people: 431, engaged_pct: 63 },
    ],
    channels: [
      { channel: "Slack", views: 812, engaged_pct: 72 }, { channel: "Direct", views: 604, engaged_pct: 60 },
      { channel: "LinkedIn", views: 418, engaged_pct: 41 }, { channel: "Email", views: 301, engaged_pct: 78 },
      { channel: "Search", views: 183, engaged_pct: 55 },
    ],
    signals: [
      { platform: "Slack", n: 14, last: iso(today() - 4 * DAY) }, { platform: "LinkedIn", n: 6, last: iso(today() - 6 * DAY) },
      { platform: "WhatsApp", n: 4, last: iso(today() - 9 * DAY) }, { platform: "X", n: 2, last: iso(today() - 17 * DAY) },
    ],
    campaigns: [
      { source: "launch-email", medium: "newsletter", campaign: null, people: 284, engaged_pct: 44 },
      { source: "linkedin", medium: "organic", campaign: null, people: 171, engaged_pct: 22 },
      { source: "sales-followup", medium: "email", campaign: null, people: 96, engaged_pct: 61 },
    ],
    internal_hidden: d.workspace ? 37 : 0,
    workspace: d.workspace ?? null,
  };
}

function versions(slug: string): VersionsAnalytics {
  const f = (drop: number) => Array.from({ length: 31 }, (_, i) => {
    const t = i * 2;
    return { t, pct: Math.round((1 - drop * Math.min(1, t / 30) - 0.002 * Math.max(0, t - 30)) * 1000) / 10 };
  });
  if (DOCS[slug]?.kind === "other") {
    return { versions: [
      { version: 2, created_at: iso(today() - 12 * DAY), views: 141, sessions: 120, primary_metric: { label: "Typical time", value: 26 } },
      { version: 1, created_at: iso(today() - 70 * DAY), views: 192, sessions: 170, primary_metric: { label: "Typical time", value: 21 } },
    ] };
  }
  return { versions: [
    { version: 4, created_at: iso(today() - 7 * DAY), views: 1011, sessions: 812, primary_metric: { label: "Average watched", value: 64 }, first_minute: f(0.19) },
    { version: 3, created_at: iso(today() - 30 * DAY), views: 1164, sessions: 940, primary_metric: { label: "Average watched", value: 51 }, first_minute: f(0.38) },
    { version: 2, created_at: iso(today() - 45 * DAY), views: 196, sessions: 160, primary_metric: { label: "Average watched", value: 47 }, first_minute: f(0.41) },
    { version: 1, created_at: iso(today() - 60 * DAY), views: 47, sessions: 46, primary_metric: { label: "Average watched", value: 39 }, first_minute: null },
  ] };
}

function home(range: AnalyticsRange): HomeAnalytics {
  const prev = (v: number) => (range === "all" ? undefined : v);
  return {
    range,
    kpis: [
      { key: "views", label: "Views", value: 6912, unit: "count", prev: prev(5858), note: null },
      { key: "people", label: "People", value: 4780, unit: "count", note: "1,102 came back" },
      { key: "watch_time", label: "Watch time", value: 341, unit: "hours", note: "across 3 videos" },
      { key: "read_end", label: "Read to the end", value: 44, unit: "percent", note: "documents and PDFs" },
    ],
    live: { people: 8, links: 3 },
    links: [
      { slug: "product-demo", title: "Product demo — full cut", kind: "video", renderer: "video", views: 2418, spark: [3, 4, 4, 5, 6, 7, 6, 8, 9, 21, 16, 12, 10, 9], engage_label: "64% watched", last_view: ago(1), live: true },
      { slug: "getting-started", title: "Getting started with Acme", kind: "doc", views: 1284, spark: [6, 6, 7, 6, 7, 8, 8, 7, 9, 9, 10, 9, 10, 11], engage_label: "41% read it all", last_view: ago(0), live: true },
      { slug: "seed-deck", title: "Seed deck — October.pdf", kind: "pdf", renderer: "pdf", views: 214, spark: [1, 0, 2, 3, 5, 4, 6, 3, 2, 2, 1, 2, 1, 1], engage_label: "34% reached the end", last_view: ago(8), live: true },
      { slug: "brand-kit", title: "Brand kit", kind: "other", renderer: "image", views: 333, spark: [2, 3, 2, 2, 3, 2, 3, 3, 2, 3, 2, 2, 3, 2], engage_label: "24 s typical view", last_view: ago(120), live: false },
      { slug: "fresh-doc", title: "Q4 roadmap (draft)", kind: "doc", views: 41, spark: [0, 0, 1, 1, 2, 3, 2, 4, 5, 6, 5, 6, 6, 7], engage_label: null, last_view: ago(60 * 26), live: false },
      { slug: "podcast-ep-12", title: "Podcast, episode 12", kind: "audio", renderer: "audio", views: 640, spark: [8, 7, 6, 6, 5, 5, 4, 4, 3, 3, 3, 2, 2, 2], engage_label: "41% listened", last_view: ago(60 * 72), live: false },
    ],
    insights: [
      { key: "fade", slug: "podcast-ep-12", severity: "warning", title: "Podcast, episode 12 is fading", body: "Plays down 70% in two weeks, and only 29% listen past the first minute.", cta: { label: "See listening", tab: "listening" } },
      { key: "signals", slug: "getting-started", severity: "info", title: "Your guide is getting shared in Slack", body: "14 previews this week, up from 3. Slack readers read twice as far.", cta: { label: "See audience", tab: "audience" } },
      { key: "page", slug: "seed-deck", severity: "warning", title: "Seed deck: page 7 loses readers", body: "22% of investors still reading stop at page 7.", cta: { label: "See pages", tab: "pages" } },
      { key: "qoe", slug: "product-demo", severity: "warning", title: "Phones struggle with your videos", body: "1 in 4 phone viewers waited over 5 seconds to start.", cta: { label: "See playback quality", tab: "video" } },
    ],
  };
}

function live(): LiveAnalytics {
  return {
    people: 8,
    links: 3,
    docs: [
      { slug: "product-demo", title: "Product demo — full cut", kind: "video", n: 3, dur: 352, entries: [
        { pos: { s: 42 }, country: "DE", device: "Desktop" }, { pos: { s: 130 }, country: "IN", device: "Mobile" }, { pos: { s: 271 }, country: "US", device: "Desktop" },
      ] },
      { slug: "getting-started", title: "Getting started with Acme", kind: "doc", n: 4, entries: [
        { pos: { h: "user-content-authenticate" }, country: "US", device: "Desktop" }, { pos: { h: "user-content-authenticate" }, country: "GB", device: "Desktop" },
        { pos: { h: "user-content-authenticate" }, country: "IN", device: "Mobile" }, { pos: { h: "user-content-install-the-sdk" }, country: "DE", device: "Desktop" },
      ] },
      { slug: "seed-deck", title: "Seed deck — October.pdf", kind: "pdf", n: 1, entries: [{ pos: { p: 5 }, country: "US", device: "Tablet" }] },
    ],
    feed: [
      { at: ago(2), text: "Someone in Brazil finished Product demo — full cut", slug: "product-demo" },
      { at: ago(6), text: "Your link was previewed in Slack", slug: "getting-started" },
      { at: ago(11), text: "3 people opened Getting started with Acme from LinkedIn", slug: "getting-started" },
      { at: ago(18), text: "A video play failed to start: slow network in India", slug: "product-demo" },
      { at: ago(27), text: "Seed deck — October.pdf was read to the last page", slug: "seed-deck" },
    ],
  };
}

/** Answers one API path (with its query string) from the samples above. */
export function fixtureFor(path: string): unknown {
  const [p, qs = ""] = path.split("?");
  const params = new URLSearchParams(qs);
  const r = params.get("range");
  const range: AnalyticsRange = r === "7d" || r === "90d" || r === "all" ? r : "30d";
  if (p === "/me/analytics") return home(range);
  if (p === "/me/analytics/live") return live();
  const m = /^\/me\/documents\/([^/]+)\/analytics\/(\w+)$/.exec(p!);
  if (!m) throw new AnalyticsError("Not found", 404);
  const slug = decodeURIComponent(m[1]!);
  if (!DOCS[slug]) throw new AnalyticsError("Not found", slug === "not-mine" ? 403 : 404);
  switch (m[2]) {
    case "overview": return overview(slug, range);
    case "media": return media(slug);
    case "content": return content();
    case "pages": return pages();
    case "audience": return audience(slug);
    case "versions": return versions(slug);
    default: throw new AnalyticsError("Not found", 404);
  }
}
