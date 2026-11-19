/**
 * A team's backlog page (backend services/team_backlog.py): reading the list Markdrop keeps on the page, and the
 * filter bar's model. Pure functions (node --test src/lib/backlog.test.mjs).
 *
 * The region: "## The team's backlog", one `:::details{summary="<Category> · N open" …}` per category, an item per
 * task line: `- [ ] Text — In progress · Acme · :person[Ada]{id="…"} · from [Call · Nov 3](/slug#b-…) · 3 calls ·
 * first seen Nov 3 {#b-…}`. The filter hides lines by block id (CSS, so the editor's DOM is never touched).
 */

export const START = "## The team's backlog";

/** Keep in step with CATEGORIES in services/team_backlog.py. */
export const CATEGORIES = [
  ["feature", "Feature request"],
  ["bug", "Bug"],
  ["improvement", "Improvement"],
  ["task", "Task"],
  ["follow_up", "Follow-up"],
  ["question", "Question"],
];
export const STATUSES = [
  ["open", "Open"],
  ["in_progress", "In progress"],
  ["done", "Done"],
];

const TASK = /^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\][ \t]+(.*?)[ \t]*\{#(b-[0-9A-Za-z_-]{1,40})[^}\n]*\}[ \t]*$/;
const HEAD = /^:::details(?:\[([^\]\n]*)\])?\{([^}\n]*)\}\s*$/;
const PERSON = /:person\[([^\]\n]*)\](?:\{([^}\n]*)\})?/;

const plain = (s) => s.replace(/:person\[([^\]\n]*)\](?:\{[^}\n]*\})?/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/\\(.)/g, "$1").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();

const labelKey = (label) => {
  const want = plain(label).toLowerCase();
  const hit = CATEGORIES.find(([k, v]) => v.toLowerCase() === want || k === want);
  return hit ? hit[0] : null;
};

const statusKey = (token) => {
  const want = plain(token).toLowerCase().replace("’", "'");
  if (want === "in progress") return "in_progress";
  if (want === "won't do") return "wont_do";
  if (want === "done") return "done";
  if (want === "open") return "open";
  return null;
};

/** Split on " · " outside […] and (…). */
export function splitMeta(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "[" || c === "(") depth++;
    else if ((c === "]" || c === ")") && depth > 0) depth--;
    if (depth === 0 && s.startsWith(" · ", i)) {
      out.push(cur);
      cur = "";
      i += 2;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** One item line's fields (`rest`: the text after the box, without the block id). */
export function parseItem(rest, done) {
  const cut = rest.indexOf(" — ");
  const textPart = cut >= 0 ? rest.slice(0, cut) : rest;
  const meta = cut >= 0 ? splitMeta(rest.slice(cut + 3)) : [];
  let status = done ? "done" : "open";
  const tokens = splitMeta(textPart);
  const words = [tokens[0] ?? ""];
  for (const t of tokens.slice(1)) {
    const st = statusKey(t);
    if (st) { if (!done) status = st; } else words.push(t);
  }
  let company = null;
  let owner = null;
  let from = null;
  let calls = 1;
  let firstSeen = null;
  for (const t of meta) {
    const st = statusKey(t);
    const pm = t.match(PERSON);
    const cm = t.match(/^(\d+) calls$/);
    if (st) { if (!done) status = st; }
    else if (pm) {
      const id = (pm[2] || "").match(/id="([^"]+)"/);
      owner = { id: id ? id[1] : plain(pm[1]), name: plain(pm[1]) };
    } else if (t.startsWith("from [")) {
      const m = t.match(/^from \[([^\]]*)\]\(([^)\s]+)\)/);
      if (m) from = { title: plain(m[1]), href: m[2] };
    } else if (cm) calls = Number(cm[1]);
    else if (t.startsWith("first seen ")) firstSeen = t.slice(11);
    else if (company === null) company = plain(t);
  }
  return { text: plain(words.join(" · ")), status, company, owner, from, calls, firstSeen };
}

/** The list on a backlog page: `{items: [{block, category, done, text, status, company, owner, from, calls,
 *  firstSeen}], present}` — `present`: the region is on the page. */
export function parseBacklog(content) {
  const lines = String(content || "").split("\n");
  const start = lines.findIndex((l) => l.trim() === START);
  if (start < 0) return { items: [], present: false };
  const items = [];
  let category = null;
  let fence = false;
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i];
    const s = raw.trim();
    if (/^(```|~~~)/.test(s)) { fence = !fence; continue; }
    if (fence) continue;
    if (/^#{1,2} /.test(s)) break;
    if (/^[*_]Markdrop keeps this list/.test(s)) break;
    const h = s.match(HEAD);
    if (h) {
      const sm = (h[2] || "").match(/summary="([^"]*)"/);
      category = labelKey(((sm ? sm[1] : h[1]) || "").split(" · ")[0]);
      continue;
    }
    if (s === ":::") { category = null; continue; }
    const m = raw.match(TASK);
    if (!m) continue;
    const done = m[1] !== " ";
    items.push({ block: m[3], category: category ?? "task", done, ...parseItem(m[2].trim(), done) });
  }
  return { items, present: true };
}

export const EMPTY_FILTER = { category: "", status: "", company: "", owner: "", search: "", hideDone: false };

/** The filter from a URL query (`?category=bug&status=open&company=Acme&owner=<id>&search=csv&hide_done=1`). */
export function filterFromQuery(search) {
  const q = new URLSearchParams(search || "");
  return {
    category: CATEGORIES.some(([k]) => k === q.get("category")) ? q.get("category") : "",
    status: STATUSES.some(([k]) => k === q.get("status")) ? q.get("status") : "",
    company: q.get("company") || "",
    owner: q.get("owner") || "",
    search: q.get("search") || "",
    hideDone: q.get("hide_done") === "1",
  };
}

/** `search` with the filter's keys set (others kept). */
export function queryWithFilter(search, f) {
  const q = new URLSearchParams(search || "");
  const set = (k, v) => (v ? q.set(k, v) : q.delete(k));
  set("category", f.category);
  set("status", f.status);
  set("company", f.company);
  set("owner", f.owner);
  set("search", f.search.trim());
  set("hide_done", f.hideDone ? "1" : "");
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const isActive = (f) => !!(f.category || f.status || f.company || f.owner || f.search.trim() || f.hideDone);

/** Does an item pass the filter (`ignore`: one key left out, for the counts next to that key's choices). */
export function matches(it, f, ignore = null) {
  if (ignore !== "category" && f.category && it.category !== f.category) return false;
  if (ignore !== "status" && f.status && it.status !== f.status) return false;
  if (ignore !== "company" && f.company && (it.company || "") !== f.company) return false;
  if (ignore !== "owner" && f.owner && (it.owner?.id || "") !== f.owner) return false;
  if (f.hideDone && it.status === "done") return false;
  const q = f.search.trim().toLowerCase();
  if (q && !`${it.text} ${it.company || ""} ${it.owner?.name || ""} ${it.from?.title || ""}`.toLowerCase().includes(q)) return false;
  return true;
}

/** Counts per category with the rest of the filter applied (the chips). */
export function categoryCounts(items, f) {
  const out = Object.fromEntries(CATEGORIES.map(([k]) => [k, 0]));
  for (const it of items) if (matches(it, f, "category")) out[it.category] = (out[it.category] ?? 0) + 1;
  return out;
}

/** The companies and owners on the list (for the menus), sorted. */
export function choices(items) {
  const companies = [...new Set(items.map((i) => i.company).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const owners = new Map();
  for (const i of items) if (i.owner) owners.set(i.owner.id, i.owner.name);
  return { companies, owners: [...owners].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)) };
}

const css = (s) => s.replace(/["\\]/g, "\\$&");

/** The stylesheet that hides what the filter leaves out: lines by block id (the reader puts it on the `li`, the
 *  editor on the line's paragraph), and a category whose items are all hidden. Empty when nothing is filtered. */
export function hideCss(items, f) {
  if (!isActive(f)) return "";
  const hidden = items.filter((i) => !matches(i, f));
  if (!hidden.length) return "";
  const rules = [];
  const sel = (b) => `li[data-bid="${css(b)}"], li:has(> p[data-bid="${css(b)}"])`;
  rules.push(`${hidden.map((i) => sel(i.block)).join(",\n")} { display: none !important; }`);
  const byCat = new Map();
  for (const i of items) byCat.set(i.category, [...(byCat.get(i.category) ?? []), i]);
  const gone = [];
  for (const [, its] of byCat) {
    if (its.every((i) => !matches(i, f))) {
      const b = css(its[0].block);
      gone.push(`details:has(li[data-bid="${b}"])`, `.dxe-details:has(p[data-bid="${b}"])`);
    }
  }
  if (gone.length) rules.push(`${gone.join(",\n")} { display: none !important; }`);
  return rules.join("\n");
}

const STATUS_LABEL = Object.fromEntries([...STATUSES, ["wont_do", "Won't do"]]);
const CAT_LABEL = Object.fromEntries(CATEGORIES);

/** The shown items as CSV (Category, Status, Item, Company, Owner, Calls, First seen, Source). */
export function toCsv(items, origin = "") {
  const q = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [["Category", "Status", "Item", "Company", "Owner", "Calls", "First seen", "Source"]];
  for (const i of items) {
    rows.push([CAT_LABEL[i.category] ?? i.category, STATUS_LABEL[i.status] ?? i.status, i.text, i.company ?? "", i.owner?.name ?? "",
      i.calls, i.firstSeen ?? "", i.from ? `${origin}${i.from.href}` : ""]);
  }
  return rows.map((r) => r.map(q).join(",")).join("\n") + "\n";
}

/** The shown items as plain text, grouped by category (Copy). */
export function toText(items) {
  const out = [];
  for (const [k, label] of CATEGORIES) {
    const its = items.filter((i) => i.category === k);
    if (!its.length) continue;
    out.push(`${label} (${its.length})`);
    for (const i of its) {
      const bits = [i.status !== "open" ? STATUS_LABEL[i.status] : null, i.company, i.owner ? `@${i.owner.name}` : null].filter(Boolean);
      out.push(`- [${i.status === "done" ? "x" : " "}] ${i.text}${bits.length ? ` (${bits.join(", ")})` : ""}`);
    }
    out.push("");
  }
  return out.join("\n").trim() + "\n";
}
