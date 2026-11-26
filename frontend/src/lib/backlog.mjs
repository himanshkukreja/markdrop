/**
 * A team's backlog page (backend services/team_backlog.py): reading the list Markdrop keeps on the page, and the
 * filter bar's model. Pure functions (node --test src/lib/backlog.test.mjs).
 *
 * The region: "## The team's backlog", one `:::details{summary="<Category> · N open" …}` per category, an item per
 * task line: `- [ ] Text — In progress · Acme · :person[Ada]{id="…"} · from [Call · Nov 3](/slug#b-…) · 3 calls ·
 * first seen Nov 3 {#b-…}` (" · **Urgent**", " · **High**" or " · Low" after the status; Medium isn't written).
 * A category's done items sit in a closed "Done · N" toggle inside it (the category's toggle then has four colons).
 * The filter hides lines by block id (CSS, so the editor's DOM is never touched); "Group by" other than Category is
 * drawn by the bar itself from these items (groupItems), the page underneath stays as it is.
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
/** Keep in step with PRIORITIES in services/team_backlog.py (most urgent first; Medium is the default). */
export const PRIORITIES = [
  ["urgent", "Urgent"],
  ["high", "High"],
  ["medium", "Medium"],
  ["low", "Low"],
];
export const DATE_RANGES = [
  ["", "Any time"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["90d", "Last 90 days"],
  ["month", "This month"],
  ["custom", "Custom range"],
];
export const GROUPS = [
  ["category", "Category"],
  ["priority", "Priority"],
  ["month", "Month"],
  ["company", "Company"],
  ["owner", "Owner"],
];
const PRIORITY_RANK = Object.fromEntries(PRIORITIES.map(([k], i) => [k, i]));

const TASK = /^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\][ \t]+(.*?)[ \t]*\{#(b-[0-9A-Za-z_-]{1,40})[^}\n]*\}[ \t]*$/;
const HEAD = /^(:{3,})details(?:\[([^\]\n]*)\])?\{([^}\n]*)\}\s*$/;
const PERSON = /:person\[([^\]\n]*)\](?:\{([^}\n]*)\})?/;

const plain = (s) => s.replace(/:person\[([^\]\n]*)\](?:\{[^}\n]*\})?/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/\\(.)/g, "$1").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();

const labelKey = (label) => {
  const want = plain(label).toLowerCase();
  const hit = CATEGORIES.find(([k, v]) => v.toLowerCase() === want || k === want);
  return hit ? hit[0] : null;
};

export const priorityKey = (token) => {
  const want = plain(token).toLowerCase();
  const hit = PRIORITIES.find(([k, v]) => v.toLowerCase() === want || k === want);
  return hit ? hit[0] : null;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** "Nov 17" (this year; a day more than a day ahead is last year's) or "Nov 17, 2025" → "2026-11-17"; null. */
export function parseDay(s, today = new Date()) {
  const m = String(s || "").trim().match(/^([A-Z][a-z]{2}) (\d{1,2})(?:, (\d{4}))?$/);
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1]);
  if (mon < 0) return null;
  let d = new Date(m[3] ? Number(m[3]) : today.getFullYear(), mon, Number(m[2]));
  if (!m[3] && d.getTime() > today.getTime() + 86400000) d = new Date(d.getFullYear() - 1, mon, Number(m[2]));
  return iso(d);
}

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
export function parseItem(rest, done, today = new Date()) {
  const cut = rest.indexOf(" — ");
  const textPart = cut >= 0 ? rest.slice(0, cut) : rest;
  const meta = cut >= 0 ? splitMeta(rest.slice(cut + 3)) : [];
  let status = done ? "done" : "open";
  let priority = "medium";
  const tokens = splitMeta(textPart);
  const words = [tokens[0] ?? ""];
  for (const t of tokens.slice(1)) {
    const st = statusKey(t);
    const pr = priorityKey(t);
    if (st) { if (!done) status = st; } else if (pr) priority = pr; else words.push(t);
  }
  let company = null;
  let owner = null;
  let from = null;
  let calls = 1;
  let firstSeen = null;
  for (const t of meta) {
    const st = statusKey(t);
    const pr = priorityKey(t);
    const pm = t.match(PERSON);
    const cm = t.match(/^(\d+) calls$/);
    if (st) { if (!done) status = st; }
    else if (pr) priority = pr;
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
  const lastSeen = from ? from.title.split(" · ").slice(-1)[0] : null;
  const firstDate = parseDay(firstSeen, today);
  const lastDate = parseDay(lastSeen, today) ?? firstDate;
  return { text: plain(words.join(" · ")), status, priority, company, owner, from, calls, firstSeen, firstDate, lastDate };
}

/** The list on a backlog page: `{items: [{block, category, done, text, status, company, owner, from, calls,
 *  firstSeen}], present}` — `present`: the region is on the page. */
export function parseBacklog(content, today = new Date()) {
  const lines = String(content || "").split("\n");
  const start = lines.findIndex((l) => l.trim() === START);
  if (start < 0) return { items: [], present: false };
  const items = [];
  const stack = []; // [colons, category key | null]: toggles nest (a category's "Done" group inside it)
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
      const sm = (h[3] || "").match(/summary="([^"]*)"/);
      stack.push([h[1].length, labelKey(((sm ? sm[1] : h[2]) || "").split(" · ")[0])]);
      continue;
    }
    const close = s.match(/^(:{3,})$/);
    if (close && stack.length) {
      const n = close[1].length;
      let top = stack.pop();
      while (stack.length && top[0] < n && stack[stack.length - 1][0] <= n) top = stack.pop();
      continue;
    }
    const m = raw.match(TASK);
    if (!m) continue;
    const done = m[1] !== " ";
    const category = [...stack].reverse().find(([, k]) => k)?.[1] ?? "task";
    items.push({ block: m[3], category, done, ...parseItem(m[2].trim(), done, today) });
  }
  return { items, present: true };
}

export const EMPTY_FILTER = {
  category: "", status: "", company: "", owner: "", search: "", hideDone: false,
  priority: [], since: "", from: "", to: "", dateBy: "first", group: "category", items: [],
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const list = (v) => String(v || "").split(",").map((x) => x.trim()).filter(Boolean);

/** The filter from a URL query (`?category=bug&status=open&company=Acme&owner=<id>&search=csv&hide_done=1&priority=urgent,high
 *  &since=30d|month|custom&from=2026-11-01&to=2026-11-15&date_by=last&group=priority&items=b-1,b-2`). */
export function filterFromQuery(search) {
  const q = new URLSearchParams(search || "");
  const since = DATE_RANGES.some(([k]) => k && k === q.get("since")) ? q.get("since") : "";
  return {
    category: CATEGORIES.some(([k]) => k === q.get("category")) ? q.get("category") : "",
    status: STATUSES.some(([k]) => k === q.get("status")) ? q.get("status") : "",
    company: q.get("company") || "",
    owner: q.get("owner") || "",
    search: q.get("search") || "",
    hideDone: q.get("hide_done") === "1",
    priority: PRIORITIES.map(([k]) => k).filter((k) => list(q.get("priority")).includes(k)),
    since,
    from: since === "custom" && DAY.test(q.get("from") || "") ? q.get("from") : "",
    to: since === "custom" && DAY.test(q.get("to") || "") ? q.get("to") : "",
    dateBy: q.get("date_by") === "last" ? "last" : "first",
    group: GROUPS.some(([k]) => k === q.get("group")) ? q.get("group") : "category",
    items: list(q.get("items")).filter((b) => /^b-[0-9A-Za-z_-]{1,40}$/.test(b)).slice(0, 100),
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
  set("priority", (f.priority ?? []).join(","));
  set("since", f.since ?? "");
  set("from", f.since === "custom" ? f.from ?? "" : "");
  set("to", f.since === "custom" ? f.to ?? "" : "");
  set("date_by", f.since && f.dateBy === "last" ? "last" : "");
  set("group", f.group && f.group !== "category" ? f.group : "");
  set("items", (f.items ?? []).join(","));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const isActive = (f) => !!(f.category || f.status || f.company || f.owner || f.search.trim() || f.hideDone
  || f.priority?.length || f.since || f.items?.length);

/** The date filter as an inclusive [from, to] of ISO days (either may be null), for `today`. */
export function dateRange(f, today = new Date()) {
  const back = (n) => iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n));
  if (f.since === "7d") return [back(7), null];
  if (f.since === "30d") return [back(30), null];
  if (f.since === "90d") return [back(90), null];
  if (f.since === "month") return [iso(new Date(today.getFullYear(), today.getMonth(), 1)), null];
  if (f.since === "custom") return [f.from || null, f.to || null];
  return [null, null];
}

/** Does an item pass the filter (`ignore`: one key left out, for the counts next to that key's choices). */
export function matches(it, f, ignore = null, today = new Date()) {
  if (ignore !== "category" && f.category && it.category !== f.category) return false;
  if (ignore !== "priority" && f.priority?.length && !f.priority.includes(it.priority ?? "medium")) return false;
  if (f.items?.length && !f.items.includes(it.block)) return false;
  if (f.since) {
    const [lo, hi] = dateRange(f, today);
    const day = f.dateBy === "last" ? it.lastDate : it.firstDate;
    if ((lo || hi) && !day) return false;
    if (lo && day < lo) return false;
    if (hi && day > hi) return false;
  }
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

/** Counts per priority with the rest of the filter applied (the priority chips). */
export function priorityCounts(items, f) {
  const out = Object.fromEntries(PRIORITIES.map(([k]) => [k, 0]));
  for (const it of items) if (matches(it, f, "priority")) out[it.priority ?? "medium"] = (out[it.priority ?? "medium"] ?? 0) + 1;
  return out;
}

const byPriorityThenNewest = (a, b) => (a.status === "done") - (b.status === "done")
  || PRIORITY_RANK[a.priority ?? "medium"] - PRIORITY_RANK[b.priority ?? "medium"]
  || String(b.lastDate ?? "").localeCompare(String(a.lastDate ?? ""));

/** The items in groups for "Group by" (`by`: category · priority · month · company · owner): `[{key, label, items}]`
 *  in a useful order (categories and priorities in theirs, months newest first, companies and owners A–Z with
 *  "No company" / "No owner" last); in each group open before done, most urgent first, then newest. */
export function groupItems(items, by = "category", dateBy = "first") {
  const groups = new Map();
  const put = (key, label, it) => {
    if (!groups.has(key)) groups.set(key, { key, label, items: [] });
    groups.get(key).items.push(it);
  };
  for (const it of items) {
    if (by === "priority") put(it.priority ?? "medium", PRIORITIES.find(([k]) => k === (it.priority ?? "medium"))[1], it);
    else if (by === "month") {
      const d = dateBy === "last" ? it.lastDate : it.firstDate;
      put(d ? d.slice(0, 7) : "", d ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : "No date", it);
    } else if (by === "company") put(it.company ? `c:${it.company}` : "~", it.company || "No company", it);
    else if (by === "owner") put(it.owner ? `o:${it.owner.id}` : "~", it.owner?.name || "No owner", it);
    else put(it.category, CATEGORIES.find(([k]) => k === it.category)?.[1] ?? it.category, it);
  }
  const out = [...groups.values()];
  const order = by === "priority" ? PRIORITIES.map(([k]) => k) : by === "category" ? CATEGORIES.map(([k]) => k) : null;
  if (order) out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  else if (by === "month") out.sort((a, b) => (a.key === "") - (b.key === "") || b.key.localeCompare(a.key));
  else out.sort((a, b) => (a.key === "~") - (b.key === "~") || a.label.localeCompare(b.label));
  for (const g of out) g.items.sort(byPriorityThenNewest);
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
  const sel = (b) => `li[data-bid="${css(b)}"], li:has(> p[data-bid="${css(b)}"]), li:has(> .dxe-li > p[data-bid="${css(b)}"])`;
  rules.push(`${hidden.map((i) => sel(i.block)).join(",\n")} { display: none !important; }`);
  const byCat = new Map();
  for (const i of items) byCat.set(i.category, [...(byCat.get(i.category) ?? []), i]);
  const gone = [];
  for (const [, its] of byCat) {
    if (its.every((i) => !matches(i, f))) {
      const b = css(its[0].block);
      gone.push(`details:has(li[data-bid="${b}"])`, `.dxe-details:has(p[data-bid="${b}"])`);
      continue;
    }
    // The category's "Done" group, when none of its items show: the innermost toggle holding its first one.
    const done = its.filter((i) => i.done);
    if (done.length && done.every((i) => !matches(i, f))) {
      const b = css(done[0].block);
      gone.push(`details:has(li[data-bid="${b}"]):not(:has(details li[data-bid="${b}"]))`,
        `.dxe-details:has(p[data-bid="${b}"]):not(:has(.dxe-details p[data-bid="${b}"]))`);
    }
  }
  if (gone.length) rules.push(`${gone.join(",\n")} { display: none !important; }`);
  return rules.join("\n");
}

const STATUS_LABEL = Object.fromEntries([...STATUSES, ["wont_do", "Won't do"]]);
const CAT_LABEL = Object.fromEntries(CATEGORIES);
export const PRIORITY_LABEL = Object.fromEntries(PRIORITIES);

/** The shown items as CSV (Category, Status, Item, Company, Owner, Calls, First seen, Source). */
export function toCsv(items, origin = "") {
  const q = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [["Category", "Priority", "Status", "Item", "Company", "Owner", "Calls", "First seen", "Last mentioned", "Source"]];
  for (const i of items) {
    rows.push([CAT_LABEL[i.category] ?? i.category, PRIORITY_LABEL[i.priority ?? "medium"], STATUS_LABEL[i.status] ?? i.status, i.text,
      i.company ?? "", i.owner?.name ?? "", i.calls, i.firstDate ?? i.firstSeen ?? "", i.lastDate ?? "", i.from ? `${origin}${i.from.href}` : ""]);
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
      const bits = [(i.priority ?? "medium") !== "medium" && i.status !== "done" ? PRIORITY_LABEL[i.priority] : null,
        i.status !== "open" ? STATUS_LABEL[i.status] : null, i.company, i.owner ? `@${i.owner.name}` : null].filter(Boolean);
      out.push(`- [${i.status === "done" ? "x" : " "}] ${i.text}${bits.length ? ` (${bits.join(", ")})` : ""}`);
    }
    out.push("");
  }
  return out.join("\n").trim() + "\n";
}
