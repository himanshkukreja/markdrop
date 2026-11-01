/**
 * The pure half of the studio's Changelog section (ChangelogScreen.tsx, EntryEditor.tsx): month
 * groups, filters, the checks the API makes (so a mistake shows as you type), and an entry in the
 * engine's hub shape for the preview. No imports, so node's type stripping can test it
 * (model.test.mjs).
 */

export type Kind = "new" | "improved" | "fixed";
export type Status = "published" | "changed" | "new";

export interface ModelEntry {
  id: string;
  slug: string;
  date: string;
  title: string;
  kind: Kind;
  area: string;
  products: string[];
  versions: Record<string, string>;
  summary: string;
  highlights: string[];
  status: Status;
  try?: { label: string; href: string } | null;
  docs?: string[];
  body?: string;
  has_body?: boolean;
  created_at?: string | null;
}

export const KIND_LABEL: Record<Kind, string> = { new: "New", improved: "Improved", fixed: "Fixed" };
/** The engine's kind glyphs (frontend/src/docs/client/Changelog.tsx KIND). */
export const KIND_ICON: Record<Kind, string> = { new: "sparkle", improved: "arrowUp", fixed: "bug" };
export const STATUS_LABEL: Record<Status, string> = { published: "Published", changed: "Changed since publish", new: "Not published yet" };

/** Limits the API applies (services/docs_site_changelog.py). */
export const LIMITS = { title: 120, summary: 280, area: 40, highlight: 200, highlights: 8, alt: 200, tryLabel: 40, slug: 80, body: 50_000 };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = MONTHS.map((m) => m.slice(0, 3));

function parts(iso: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** "2026-11-01" → "November 1, 2026" (as the engine writes dates; no time zone shifts). */
export function longDate(iso: string): string {
  const p = parts(iso);
  return p ? `${MONTHS[p[1] - 1]} ${p[2]}, ${p[0]}` : iso;
}
/** "Nov 1" */
export function shortDate(iso: string): string {
  const p = parts(iso);
  return p ? `${SHORT[p[1] - 1]} ${p[2]}` : iso;
}
/** "November 2026" */
export function monthLabel(iso: string): string {
  const p = parts(iso);
  return p ? `${MONTHS[p[1] - 1]} ${p[0]}` : iso;
}

/** Today in the browser's own calendar, as YYYY-MM-DD. */
export function todayIso(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Newest first: by date, then the most recently created. */
export function sortEntries<T extends Pick<ModelEntry, "date" | "created_at">>(entries: T[]): T[] {
  return [...entries].sort((a, b) => (a.date === b.date ? (b.created_at ?? "").localeCompare(a.created_at ?? "") : b.date.localeCompare(a.date)));
}

/** Entries by month, newest month first (each month newest first). */
export function monthGroups<T extends Pick<ModelEntry, "date" | "created_at">>(entries: T[]): Array<{ key: string; label: string; items: T[] }> {
  const out: Array<{ key: string; label: string; items: T[] }> = [];
  for (const e of sortEntries(entries)) {
    const key = e.date.slice(0, 7);
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(e);
    else out.push({ key, label: monthLabel(e.date), items: [e] });
  }
  return out;
}

export interface Filter {
  q: string;
  kind: "all" | Kind;
  /** "unpublished": new or changed since the last publish. */
  status: "all" | "unpublished";
}

export const NO_FILTER: Filter = { q: "", kind: "all", status: "all" };

export function filterEntries<T extends Pick<ModelEntry, "title" | "summary" | "area" | "slug" | "kind" | "status" | "highlights">>(entries: T[], f: Filter): T[] {
  const terms = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    if (f.kind !== "all" && e.kind !== f.kind) return false;
    if (f.status === "unpublished" && e.status === "published") return false;
    if (!terms.length) return true;
    const text = [e.title, e.summary, e.area, e.slug, ...(e.highlights ?? [])].join(" ").toLowerCase();
    return terms.every((t) => text.includes(t));
  });
}

/** "Dark mode, at last!" → "dark-mode-at-last" (the API's slugify: at most 60 characters). */
export function slugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,29}$/;

function realDate(iso: string): boolean {
  const p = parts(iso);
  if (!p || p[0] < 2000 || p[0] > 2100) return false;
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
}

export interface DraftFields {
  title: string;
  summary: string;
  date: string;
  slug: string;
  area: string;
  versions: Record<string, string>;
  highlights: string[];
  tryLabel: string;
  tryHref: string;
  alt: string;
  body: string;
}

/** Field → what's wrong with it (the API refuses the same). Empty: fine to save. */
export function entryProblems(d: DraftFields): Partial<Record<keyof DraftFields, string>> {
  const out: Partial<Record<keyof DraftFields, string>> = {};
  const one = (s: string) => s.replace(/\s+/g, " ").trim();
  if (!one(d.title)) out.title = "Add a title.";
  else if (one(d.title).length > LIMITS.title) out.title = `At most ${LIMITS.title} characters.`;
  if (!one(d.summary)) out.summary = "Add a one-line summary: feeds and link previews show it.";
  else if (one(d.summary).length > LIMITS.summary) out.summary = `At most ${LIMITS.summary} characters.`;
  if (!realDate(d.date)) out.date = "Pick a date between 2000 and 2100.";
  if (d.slug && !SLUG.test(d.slug)) out.slug = "Lowercase letters, numbers and hyphens.";
  if (one(d.area).length > LIMITS.area) out.area = `At most ${LIMITS.area} characters.`;
  const badVersion = Object.values(d.versions).find((v) => v.trim() && !VERSION.test(v.trim()));
  if (badVersion !== undefined) out.versions = `“${badVersion}” isn't a version: use something like 2.4 or v3.1.0-beta.`;
  if (d.highlights.filter((h) => h.trim()).length > LIMITS.highlights) out.highlights = `At most ${LIMITS.highlights} highlights.`;
  else if (d.highlights.some((h) => one(h).length > LIMITS.highlight)) out.highlights = `A highlight is at most ${LIMITS.highlight} characters.`;
  const href = d.tryHref.trim();
  const hrefShape = (href.startsWith("/") && !href.startsWith("//")) || href.startsWith("https://");
  if (href && (!hrefShape || /[\s<>"'`\\]/.test(href))) {
    out.tryHref = "An https:// address, or a page of this guide like /quickstart.";
  }
  if (one(d.tryLabel).length > LIMITS.tryLabel) out.tryLabel = `At most ${LIMITS.tryLabel} characters.`;
  if (one(d.alt).length > LIMITS.alt) out.alt = `At most ${LIMITS.alt} characters.`;
  if (d.body.length > LIMITS.body) out.body = `The details can be at most ${LIMITS.body.toLocaleString("en-US")} characters.`;
  return out;
}

/** The areas used so far, most used first (the editor offers them). */
export function knownAreas(entries: Array<Pick<ModelEntry, "area">>): string[] {
  const n = new Map<string, number>();
  for (const e of entries) if (e.area) n.set(e.area, (n.get(e.area) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([a]) => a);
}

export interface HubShape {
  id: string;
  date: string;
  dateLabel: string;
  shortDate: string;
  month: string;
  monthKey: string;
  title: string;
  kind: Kind;
  area: string;
  products: Array<{ id: string; label: string }>;
  versions: Array<{ product: string; label: string; version: string }>;
  summary: string;
  highlights: string[];
  docs: Array<{ path: string; title: string }>;
  try?: { label: string; href: string };
  text: string;
  hasBody: boolean;
}

/**
 * An entry as the engine's hub draws it (frontend/src/docs/changelog.tsx toHubEntry): products by
 * label, versions with their product, related pages by path and title (pages not in the guide left out).
 */
export function toHub(
  e: ModelEntry,
  products: Array<{ id: string; label: string }>,
  pages: Array<{ id: string; path: string; title: string }>,
): HubShape {
  const label = (id: string) => products.find((p) => p.id === id)?.label ?? id;
  const docs = (e.docs ?? []).map((id) => pages.find((p) => p.id === id)).filter((p): p is { id: string; path: string; title: string } => !!p);
  return {
    id: e.slug || e.id,
    date: e.date,
    dateLabel: longDate(e.date),
    shortDate: shortDate(e.date),
    month: monthLabel(e.date),
    monthKey: e.date.slice(0, 7),
    title: e.title || "Untitled",
    kind: e.kind,
    area: e.area || "General",
    products: e.products.map((id) => ({ id, label: label(id) })),
    versions: Object.entries(e.versions ?? {}).filter(([, v]) => v).map(([product, version]) => ({ product, label: label(product), version })),
    summary: e.summary,
    highlights: e.highlights ?? [],
    docs: docs.map((p) => ({ path: p.path, title: p.title })),
    try: e.try && e.try.href ? { label: e.try.label || "Try it", href: e.try.href } : undefined,
    text: [e.title, e.area, e.summary, ...(e.highlights ?? []), e.body ?? ""].join(" ").toLowerCase(),
    hasBody: !!(e.body ?? "").trim() || !!e.has_body,
  };
}

/** Sample entries for the empty state's preview (fictional: the Northwind app). */
export function sampleEntries(today: string): ModelEntry[] {
  const p = parts(today) ?? [2026, 11, 1];
  const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const back = (days: number) => {
    const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]) - days * 86_400_000);
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  };
  const base = { products: [], versions: {}, highlights: [], status: "new" as Status };
  return [
    { ...base, id: "s1", slug: "dark-mode", date: back(0), title: "Dark mode", kind: "new", area: "Appearance", summary: "Northwind follows your system's light or dark setting, or pick one in Settings.", highlights: ["Follows the system by default", "Charts and code blocks adapt too"] },
    { ...base, id: "s2", slug: "faster-exports", date: back(9), title: "Exports are three times faster", kind: "improved", area: "Exports", summary: "Large CSV exports finish in seconds and keep their column order." },
    { ...base, id: "s3", slug: "invite-links", date: back(37), title: "Invite links no longer expire early", kind: "fixed", area: "Teams", summary: "Links sent from the Members page now last the full seven days." },
  ];
}
