/**
 * The pure half of the Fix list (FixListScreen.tsx): words, icons and tones per problem type,
 * filtering, the line diff a drafted fix is shown as, chart points, and the sample list a guide
 * without readers sees. No imports, so node's type stripping can test it (fixesModel.test.mjs).
 */

export type FixType = "drop" | "search" | "ask" | "not_helpful" | "video" | "pdf" | "broken" | "stale" | "heavy" | "agent_unanswered" | "agent_unfriendly";
export type FixStatus = "open" | "in_progress" | "fixed" | "dismissed";
export type FixLevel = "high" | "medium" | "low";
export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export const FIX_TYPES: FixType[] = ["drop", "search", "ask", "not_helpful", "video", "pdf", "broken", "agent_unanswered", "agent_unfriendly", "stale", "heavy"];

/** Per type: the filter's label, the row's icon, what its reader count counts, and what a draft does. */
export const TYPE_META: Record<FixType, { label: string; icon: string; unit: [string, string]; draft: string; watches: string }> = {
  drop: { label: "Readers leave here", icon: "arrowDown", unit: ["reader left here", "readers left here"],
    draft: "Rewrite the section", watches: "Where readers stop reading a page, against the page’s own curve." },
  search: { label: "Searches with no results", icon: "search", unit: ["search found nothing", "searches found nothing"],
    draft: "Write an answer", watches: "What readers search for and don’t find, grouped by meaning." },
  ask: { label: "Ask AI couldn’t answer", icon: "sparkle", unit: ["unanswered question", "unanswered questions"],
    draft: "Write an answer", watches: "Questions Ask AI couldn’t answer from your docs, clustered." },
  not_helpful: { label: "Marked not helpful", icon: "flag", unit: ["reader affected", "readers affected"],
    draft: "Rewrite with the feedback", watches: "Pages readers say didn’t help, with their comments." },
  video: { label: "Video drop-off", icon: "film", unit: ["viewer lost", "viewers lost"],
    draft: "Add a written summary", watches: "The moment a video loses most of its viewers." },
  pdf: { label: "PDF drop-off", icon: "doc", unit: ["reader stopped here", "readers stopped here"],
    draft: "Suggest what to change", watches: "The page of an embedded PDF where most readers stop." },
  broken: { label: "Broken links", icon: "link", unit: ["reader hit it", "readers hit it"],
    draft: "Fix the link", watches: "Links to pages that don’t exist, and the 404s readers hit." },
  stale: { label: "Stale pages", icon: "clock", unit: ["reader", "readers"],
    draft: "List what to check", watches: "Heavily read pages nobody has updated in months." },
  heavy: { label: "Long, heavy pages", icon: "layers", unit: ["reader", "readers"],
    draft: "Plan a split", watches: "Very long or media-heavy pages that are slow to read." },
  agent_unanswered: { label: "Agents find nothing", icon: "terminal", unit: ["agent search", "agent searches"],
    draft: "Write an answer", watches: "What AI assistants search your docs for (MCP) and don’t find." },
  agent_unfriendly: { label: "Hard for agents", icon: "server", unit: ["agent read", "agent reads"],
    draft: "Make it agent-friendly", watches: "Pages agents read that have no headings, are mostly images, or are hidden from llms.txt." },
};

export type Confidence = "high" | "medium" | "low";
export const CONFIDENCE_META: Record<Confidence, { label: string; hint: string }> = {
  high: { label: "Confident", hint: "Plenty of readers behind this: four times the minimum or more." },
  medium: { label: "Likely", hint: "Enough readers to flag it, and twice the minimum." },
  low: { label: "Early signal", hint: "Just past the minimum number of readers. Worth a look, may change." },
};

/** "12 of 25 reads", for a "needs more readers" row. */
export function pendingWords(p: { type: FixType; have: number; need: number }): string {
  const noun = p.type === "video" ? ["play", "plays"] : p.type === "pdf" ? ["reader", "readers"] : p.type === "not_helpful" ? ["vote", "votes"] : ["read", "reads"];
  return `${fmt(p.have)} of ${fmt(p.need)} ${p.need === 1 ? noun[0] : noun[1]}`;
}

export function pendingPct(p: { have: number; need: number }): number {
  return p.need > 0 ? Math.max(4, Math.min(100, Math.round((p.have / p.need) * 100))) : 0;
}

/** Agent families as a share of all agent reads ("Claude 42%"). */
export function familyShares(families: { name: string; n: number }[]): { name: string; n: number; pct: number }[] {
  const total = families.reduce((a, f) => a + f.n, 0);
  return families.map((f) => ({ ...f, pct: total ? Math.round((f.n / total) * 100) : 0 }));
}

export const LEVEL_META: Record<FixLevel, { label: string; tone: Tone }> = {
  high: { label: "High impact", tone: "danger" },
  medium: { label: "Medium", tone: "warning" },
  low: { label: "Low", tone: "neutral" },
};

export const STATUS_META: Record<FixStatus, { label: string; tone: Tone; icon: string }> = {
  open: { label: "Open", tone: "neutral", icon: "alertCircle" },
  in_progress: { label: "In progress", tone: "info", icon: "edit" },
  fixed: { label: "Fixed", tone: "success", icon: "checkCircle" },
  dismissed: { label: "Dismissed", tone: "neutral", icon: "x" },
};

export const DISMISS_REASONS: { value: "not_a_problem" | "wont_fix" | "duplicate" | "other"; label: string; hint: string }[] = [
  { value: "not_a_problem", label: "Not a problem", hint: "Readers are meant to stop here, or this is expected." },
  { value: "wont_fix", label: "Won’t fix", hint: "Known, and not worth changing now." },
  { value: "duplicate", label: "Duplicate", hint: "Another item covers the same problem." },
  { value: "other", label: "Something else", hint: "Say why in the note." },
];

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

/** "45 readers left here", "1 search found nothing". */
export function readersWords(type: FixType, n: number): string {
  const r = Math.max(0, Math.round(n));
  const [one, many] = TYPE_META[type].unit;
  return `${fmt(r)} ${r === 1 ? one : many}`;
}

/** 42 → "0:42", 3725 → "1:02:05". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/** An impact bar's width against the list's biggest (never under 6% so it still shows). */
export function impactWidth(impact: number, max: number): string {
  if (!(max > 0) || !(impact > 0)) return "6%";
  return `${Math.max(6, Math.min(100, Math.round((impact / max) * 100)))}%`;
}

export interface FilterQuery { type?: FixType | null; path?: string | null; status?: "active" | FixStatus | "all" }

export function matches(item: { type: FixType; path: string | null; status: FixStatus }, q: FilterQuery): boolean {
  const st = q.status ?? "active";
  if (st === "active" && item.status !== "open" && item.status !== "in_progress") return false;
  if (st !== "active" && st !== "all" && item.status !== st) return false;
  if (q.type && item.type !== q.type) return false;
  if (q.path && item.path !== q.path) return false;
  return true;
}

/** "3 things to fix", "1 thing to fix", "Nothing to fix". */
export function badgeWords(open: number): string {
  if (!open) return "Nothing to fix";
  return `${fmt(open)} ${open === 1 ? "thing" : "things"} to fix`;
}

export interface DiffLine { op: " " | "+" | "-"; text: string }

/**
 * A line diff (longest common subsequence) of a drafted fix: what goes, what comes. Long inputs
 * (over 600 lines a side) fall back to "all of it goes, all of it comes".
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  if (a.length > 600 || b.length > 600) return [...a.map((text) => ({ op: "-" as const, text })), ...b.map((text) => ({ op: "+" as const, text }))];
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: " ", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", text: a[i++] });
    else out.push({ op: "+", text: b[j++] });
  }
  while (i < n) out.push({ op: "-", text: a[i++] });
  while (j < m) out.push({ op: "+", text: b[j++] });
  return out;
}

export function diffCounts(lines: DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.op === "+").length, removed: lines.filter((l) => l.op === "-").length };
}

/** A video's retention curve (40 slices, % of plays) → [{x: seconds, y: %}] for the chart. */
export function retentionPoints(curve: number[], length: number): { x: number; y: number }[] {
  const n = curve.length || 1;
  return curve.map((y, i) => ({ x: Math.round(((i + 0.5) / n) * length), y }));
}

/** The editor address that opens the page with the drafted fix offered as a suggestion. */
export function editorHref(base: string, pageId: string, fixId: string): string {
  return `${base}?page=${encodeURIComponent(pageId)}&fix=${encodeURIComponent(fixId)}`;
}

/** What "Draft a fix" will do for an item, for its button. */
export function draftLabel(type: FixType): string {
  return TYPE_META[type].draft;
}

/** Whether drafting this one spends an AI use (a link fix, or a hidden page's advice, doesn't). */
export function draftUsesAi(type: FixType, reason?: string | null): boolean {
  return type !== "broken" && !(type === "agent_unfriendly" && reason === "hidden");
}

/* ── The sample list (a guide with no readers yet) ────────────────────── */

const DAY = 86_400_000;

/** Fictional Acme items: what the Fix list looks like once readers arrive. Dates relative to `now`. */
export function demoItems(now: number = Date.now()) {
  const ago = (d: number) => new Date(now - d * DAY).toISOString();
  const base = {
    status: "open" as FixStatus, severity: 0.6, recency: 1, reason: null, note: null, reopened: 0, fixed_by: null, fixed_build: null,
    quiet: false, has_draft: false, applied: null, status_at: null, page_id: null, confidence: "high" as Confidence,
  };
  const curve = [
    { i: -1, id: null, title: "Introduction", reached: 412, left: 21, reached_pct: 100, left_pct: 5 },
    { i: 0, id: "install-the-cli", title: "Install the CLI", reached: 391, left: 25, reached_pct: 95, left_pct: 6 },
    { i: 1, id: "sign-in", title: "Sign in", reached: 366, left: 156, reached_pct: 89, left_pct: 38 },
    { i: 2, id: "connect-a-source", title: "Connect a source", reached: 210, left: 29, reached_pct: 51, left_pct: 7 },
    { i: 3, id: "build-your-first-dashboard", title: "Build your first dashboard", reached: 181, left: 31, reached_pct: 44, left_pct: 8 },
    { i: 4, id: null, title: "End of page", reached: 150, left: 0, reached_pct: 36, left_pct: 0 },
  ];
  const tour = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 88, 87, 86, 61, 47, 45, 44, 43, 42, 42, 41, 40, 40, 39, 38, 38, 37, 37, 36, 36, 35, 35, 34, 30, 26, 22, 18];
  return [
    { ...base, id: "demo-drop", type: "drop" as FixType, key: "drop:/getting-started/quickstart#sign-in", level: "high" as FixLevel,
      title: "Readers leave at “Sign in”", summary: "38% of readers stop here on “Quickstart”; on the rest of the page it’s about 6% per section.",
      path: "/getting-started/quickstart", page_title: "Quickstart", section: "sign-in", section_title: "Sign in", readers: 156, impact: 93.6,
      detected_at: ago(3), last_seen_at: ago(0),
      evidence: { measured: 412, left: 156, left_pct: 38, typical_pct: 6, curve, seconds: 74 } },
    { ...base, id: "demo-ask", type: "ask" as FixType, key: "ask:do you support sso with okta", level: "high" as FixLevel, severity: 0.8,
      title: "Ask AI couldn’t answer “Do you support SSO with Okta?”", summary: "Asked 31 times without an answer, in 5 wordings.",
      path: null, page_title: null, section: null, section_title: null, readers: 31, impact: 24.1, detected_at: ago(9), last_seen_at: ago(1),
      evidence: { questions: 31, samples: [{ text: "Do you support SSO with Okta?", n: 14 }, { text: "How do I set up SAML with Okta", n: 7 },
        { text: "Okta single sign-on", n: 5 }, { text: "Can we log in with Okta?", n: 3 }, { text: "SSO Okta setup", n: 2 }], pages: [] } },
    { ...base, id: "demo-search", type: "search" as FixType, key: "search:csv export", level: "medium" as FixLevel, severity: 0.7,
      title: "People search for “csv export” and find nothing", summary: "27 searches found no results (3 wordings).",
      path: null, page_title: null, section: null, section_title: null, readers: 27, impact: 18.4, detected_at: ago(12), last_seen_at: ago(2),
      evidence: { searches: 27, wordings: 3, samples: [{ text: "csv export", n: 17 }, { text: "export to csv", n: 7 }, { text: "download csv", n: 3 }] } },
    { ...base, id: "demo-video", type: "video" as FixType, key: "video:product-tour", level: "medium" as FixLevel, severity: 0.5,
      title: "“Product tour” loses most viewers at 0:42", summary: "25% of viewers stop around 0:42 of 1:40 on “Introduction”.",
      path: "/getting-started/introduction", page_title: "Introduction", section: null, section_title: null, readers: 38, impact: 17.1,
      detected_at: ago(6), last_seen_at: ago(0),
      evidence: { video: "product-tour", video_title: "Product tour", plays: 152, length: 100, at: 42.5, fall_pct: 25, typical_pct: 2, curve: tour } },
    { ...base, id: "demo-helpful", type: "not_helpful" as FixType, key: "helpful:/guides/connect-postgres", level: "medium" as FixLevel, severity: 0.75,
      title: "“Connect Postgres” marked not helpful", summary: "7 of 16 readers said it didn’t help (56% helpful); 3 left a comment.",
      path: "/guides/connect-postgres", page_title: "Connect Postgres", section: null, section_title: null, readers: 21, impact: 15.8,
      detected_at: ago(5), last_seen_at: ago(1),
      evidence: { yes: 9, no: 7, helpful_pct: 56, comments: [
        { id: null, text: "Which IP addresses do we allow? The warning says fixed addresses but doesn’t list them.", ts: ago(1) },
        { id: null, text: "Does this work with a read replica?", ts: ago(4) },
        { id: null, text: "The SSL mode step is missing for RDS.", ts: ago(6) }] } },
    { ...base, id: "demo-broken", type: "broken" as FixType, key: "broken:/guides/alerts", level: "low" as FixLevel, severity: 1,
      title: "Broken link to /guides/alerts", summary: "9 readers hit a page that doesn’t exist on “Build a dashboard”.",
      path: "/guides/build-a-dashboard", page_title: "Build a dashboard", section: null, section_title: null, readers: 9, impact: 8.2,
      detected_at: ago(2), last_seen_at: ago(0),
      evidence: { target: "/guides/alerts", hits: 9, suggested: "/guides/alert-rules",
        pages: [{ path: "/guides/build-a-dashboard", title: "Build a dashboard", link: true, hits: 9 }] } },
    { ...base, id: "demo-stale", type: "stale" as FixType, key: "stale:/reference/api-keys", level: "low" as FixLevel, severity: 0.3,
      title: "“API keys” hasn’t been updated in 8 months", summary: "Last edited 8 months ago, and 31 readers opened it in the last 30 days.",
      path: "/reference/api-keys", page_title: "API keys", section: null, section_title: null, readers: 31, impact: 9.3,
      detected_at: ago(20), last_seen_at: ago(0), evidence: { updated_at: ago(250), age_days: 250, readers: 31 } },
    { ...base, id: "demo-agents", type: "agent_unanswered" as FixType, key: "agent_unanswered:terraform provider", level: "medium" as FixLevel,
      severity: 0.6, confidence: "medium" as Confidence,
      title: "Agents search for “terraform provider” and nothing answers it",
      summary: "AI assistants searched your docs for this 19 times through the docs MCP server and found nothing.",
      path: null, page_title: null, section: null, section_title: null, readers: 19, impact: 11.1, recency: 0.97, detected_at: ago(4), last_seen_at: ago(1),
      evidence: { searches: 19, wordings: 3, samples: [{ text: "terraform provider", n: 11 }, { text: "acme terraform", n: 5 }, { text: "terraform module for acme alerts", n: 3 }] } },
    { ...base, id: "demo-pdf", type: "pdf" as FixType, key: "pdf:q3-board-deck", level: "low" as FixLevel, severity: 0.5, confidence: "low" as Confidence,
      title: "Readers stop at page 3 of “Pricing and plans”", summary: "41% of readers go no further than page 3 of 9; about 7% stop at a typical page.",
      path: "/help/faq", page_title: "FAQ", section: null, section_title: null, readers: 14, impact: 7, detected_at: ago(2), last_seen_at: ago(0),
      evidence: { embed: "pricing-pdf", name: "Pricing and plans", pages_total: 9, page: 3, readers_pdf: 34, left_pct: 41, typical_pct: 7,
        curve: [100, 94, 88, 47, 43, 40, 37, 35, 33].map((r, i) => ({ page: i + 1, reached_pct: r, left_pct: [6, 6, 41, 4, 3, 3, 2, 2, 0][i] })) } },
  ];
}

/** The sample's "needs more readers" rows and agent traffic (fictional Acme). */
export function demoExtras() {
  return {
    pending: [
      { type: "drop" as FixType, path: "/guides/invite-your-team", title: "Invite your team", have: 18, need: 25 },
      { type: "video" as FixType, path: null, title: "Alert rules in 90 seconds", have: 5, need: 8 },
      { type: "not_helpful" as FixType, path: "/reference/cli", title: "CLI reference", have: 2, need: 3 },
    ],
    agents: {
      total: 2140, readers: 1386,
      families: [{ name: "ChatGPT", n: 812 }, { name: "Claude", n: 655 }, { name: "Perplexity", n: 301 }, { name: "Other tool", n: 214 }, { name: "Gemini", n: 158 }],
      via: { page: 1022, markdown: 604, llms: 318, mcp: 196 },
      pages: [{ path: "/reference/api-keys", title: "API keys", n: 388 }, { path: "/reference/cli", title: "CLI reference", n: 342 }, { path: "/getting-started/quickstart", title: "Quickstart", n: 297 }],
    },
  };
}
