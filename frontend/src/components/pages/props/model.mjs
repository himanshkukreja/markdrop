/**
 * Typed page properties (backend services/page_db.py), the parts with no UI: the `props:` line in a
 * page's front matter, value checks, and a folder database's filter / sort / group.
 *
 *   ---
 *   props: {status: "In build", owner: "<user id>", target_date: "2026-11-20", related: ["prd-x"]}
 *   ---
 *
 * One line: a YAML flow mapping whose values are JSON, written exactly as the backend writes it
 * (`formatLine`), so a value set in the editor and one set by an AI app read the same. Every other
 * line of the front matter stays byte for byte. No YAML parser here (readers load this); a
 * hand-written block mapping (`props:` then indented lines) is read with `opts.parseYaml` when the
 * caller has one (the editor does), and a write puts it back on one line.
 */

export const TYPES = ["select", "multi_select", "person", "date", "text", "link", "number", "checkbox"];
export const TYPE_LABELS = {
  select: "Select", multi_select: "Multi-select", person: "Person", date: "Date",
  text: "Text", link: "Link", number: "Number", checkbox: "Checkbox",
};
export const COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
const CYCLE = ["blue", "green", "orange", "purple", "pink", "yellow", "red", "brown", "gray"];
export const FILTER_OPS = ["is", "is_not", "contains", "not_contains", "before", "after", "on_or_before", "on_or_after", "gt", "lt", "gte", "lte", "is_empty", "is_not_empty"];
export const SPECIAL = ["title", "updated_at", "created_at"];
export const MAX_PROPERTIES = 30;
export const MAX_OPTIONS = 50;
export const MAX_VIEWS = 20;
export const RESERVED = new Set(["icon", "cover", "cover_y", "full_width", "small_text", "font", "locked", "allow_export", "props", "title", "slug", "url", "template", "description", "updated_at", "created_at", "id", "editor", "parent", "owner_id"]);

const FRONT = /^(﻿?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;
const SLUG = /^[A-Za-z0-9_-]{3,64}$/;
const URL_RE = /^https?:\/\/[^\s<>"']{1,2000}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/* ── reading the line ─────────────────────────────────────────────────── */

/** A tiny reader for `{key: <json or plain>, …}` (what we write, and what people type by hand). */
function parseFlow(text) {
  let i = 0;
  const s = text;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const fail = () => { throw new Error("props"); };
  function str() {
    const q = s[i];
    if (q === "'") {
      let out = "";
      i++;
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") { out += "'"; i += 2; continue; }
        if (s[i] === "'") { i++; return out; }
        out += s[i++];
      }
      fail();
    }
    const start = i++;
    while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
    if (i >= s.length) fail();
    i++;
    return JSON.parse(s.slice(start, i));
  }
  function plain(stop) {
    const start = i;
    while (i < s.length && !stop.includes(s[i])) i++;
    const raw = s.slice(start, i).trim();
    if (raw === "") return null;
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (raw === "null" || raw === "~") return null;
    if (/^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(raw)) return Number(raw);
    return raw;
  }
  function value(stop) {
    ws();
    if (s[i] === '"' || s[i] === "'") return str();
    if (s[i] === "[") {
      i++;
      const out = [];
      ws();
      if (s[i] === "]") { i++; return out; }
      for (;;) {
        out.push(value(",]"));
        ws();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === "]") { i++; return out; }
        fail();
      }
    }
    if (s[i] === "{") fail();
    return plain(stop);
  }
  ws();
  if (s[i] !== "{") fail();
  i++;
  const out = {};
  ws();
  if (s[i] === "}") return out;
  for (;;) {
    ws();
    let key;
    if (s[i] === '"' || s[i] === "'") key = str();
    else {
      const start = i;
      while (i < s.length && s[i] !== ":" && s[i] !== "}" && s[i] !== ",") i++;
      key = s.slice(start, i).trim();
    }
    ws();
    if (s[i] !== ":") fail();
    i++;
    out[key] = value(",}");
    ws();
    if (s[i] === ",") { i++; continue; }
    if (s[i] === "}") return out;
    fail();
  }
}

/** [start, end) of the `props:` line and its indented continuation lines. */
function propsSpan(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (/^props[ \t]*:/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && /^(?:[ \t]+\S|[ \t]*-\s)/.test(lines[j])) j++;
      return [i, j];
    }
  }
  return null;
}

function clean(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v === "" ? undefined : v;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) {
    const out = v.map(clean).filter((x) => x !== undefined && typeof x !== "object");
    return out.length ? out : undefined;
  }
  return undefined;
}

/** The page's typed values, `{key: value}` ({} when none, or when the line can't be read). */
export function readValues(markdown, opts = {}) {
  const m = FRONT.exec(String(markdown ?? ""));
  if (!m) return {};
  const lines = m[2].split(/\r?\n/);
  const span = propsSpan(lines);
  if (!span) return {};
  const first = lines[span[0]].replace(/^props[ \t]*:[ \t]*/, "");
  let data = null;
  try {
    if (first.trim().startsWith("{") && span[1] - span[0] === 1) data = parseFlow(first.trim());
  } catch {
    data = null;
  }
  if (data === null && opts.parseYaml) {
    try {
      const y = opts.parseYaml(lines.slice(span[0], span[1]).join("\n"));
      data = y && typeof y === "object" ? y.props : null;
    } catch {
      data = null;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (k.length > 64) continue;
    const c = clean(v);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/* ── writing it ───────────────────────────────────────────────────────── */

/** JSON with Python's separators (", "), as the backend writes it. */
export function jsonPy(v) {
  if (Array.isArray(v)) return `[${v.map(jsonPy).join(", ")}]`;
  return JSON.stringify(v);
}

const formatKey = (k) => (BARE_KEY.test(k) && !/^(true|false|null|yes|no|on|off)$/i.test(k) ? k : JSON.stringify(k));

export function formatLine(values) {
  return `props: {${Object.entries(values).map(([k, v]) => `${formatKey(k)}: ${jsonPy(v)}`).join(", ")}}`;
}

const empty = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/**
 * The Markdown with `patch` applied to its `props:` line (null / "" / [] removes a key). The rest of
 * the front matter and the body are untouched; the line (and an emptied front matter) goes away when
 * nothing is left.
 */
export function writeValues(markdown, patch, opts = {}) {
  const src = String(markdown ?? "");
  const values = { ...readValues(src, opts) };
  for (const [k, v] of Object.entries(patch)) {
    if (empty(v)) delete values[k];
    else values[k] = v;
  }
  const line = Object.keys(values).length ? formatLine(values) : null;
  const m = FRONT.exec(src);
  if (!m) return line ? `---\n${line}\n---\n${src}` : src;
  const eol = /\r\n/.test(m[1]) ? "\r\n" : "\n";
  const lines = m[2] === "" ? [] : m[2].split(/\r?\n/);
  const span = propsSpan(lines);
  if (span) lines.splice(span[0], span[1] - span[0], ...(line ? [line] : []));
  else if (line) lines.push(line);
  const body = src.slice(m[0].length);
  if (!lines.some((l) => l.trim())) return body;
  return m[1] + lines.join(eol) + m[3] + body;
}

/* ── schema and values ────────────────────────────────────────────────── */

export function keyFromName(name, taken = new Set()) {
  let k = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!k || !/^[a-z]/.test(k)) k = `p_${k}`;
  k = k.slice(0, 40).replace(/_+$/, "") || "p";
  const base = k;
  let n = 2;
  while (taken.has(k) || RESERVED.has(k)) k = `${base.slice(0, 36)}_${n++}`;
  return k;
}

/** The colour a new option gets (the next in the cycle). */
export function nextColor(options) {
  return CYCLE[(options?.length ?? 0) % CYCLE.length];
}

export const findProp = (schema, ref) => schema.find((p) => p.key === ref) ?? schema.find((p) => p.name.toLowerCase() === String(ref).trim().toLowerCase()) ?? null;

/** An option's colour (or "default" for a value the schema doesn't list). */
export function optionColor(prop, name) {
  return prop?.options?.find((o) => o.name === name)?.color ?? "default";
}

export const isSlug = (v) => typeof v === "string" && SLUG.test(v);
export const isUrl = (v) => typeof v === "string" && URL_RE.test(v);
export const linkList = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]).filter((x) => typeof x === "string");

/** The error a value would get from the server, or null (people and slugs are the server's to check). */
export function checkValue(prop, v) {
  if (empty(v)) return null;
  switch (prop.type) {
    case "select":
      return prop.options?.some((o) => o.name === v) ? null : `“${v}” isn't one of ${prop.name}'s options`;
    case "multi_select":
      return (Array.isArray(v) ? v : [v]).every((x) => prop.options?.some((o) => o.name === x)) ? null : `Pick ${prop.name}'s own options`;
    case "date":
      return typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? null : "A date is YYYY-MM-DD";
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? null : "A number, please";
    case "checkbox":
      return typeof v === "boolean" ? null : "true or false";
    case "link":
      return linkList(v).every((x) => isUrl(x) || isSlug(x)) ? null : "An http(s) address or a page";
    case "person":
      return typeof v === "string" && /^[0-9a-f]{24}$/.test(v) ? null : "Pick a member";
    default:
      return typeof v === "string" && v.length <= 2000 ? null : "Text, at most 2,000 characters";
  }
}

/* ── filter / sort / group (the same rules as the backend's list_folder_pages) ── */

export const rowValue = (row, key) => (SPECIAL.includes(key) ? row[key] : row.values?.[key]);

function isEmptyFor(type, v) {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (type === "checkbox" && v !== true);
}

export function matches(row, rule, schema) {
  const prop = SPECIAL.includes(rule.key) ? null : findProp(schema, rule.key);
  const t = prop ? prop.type : "text";
  const v = rowValue(row, prop ? prop.key : rule.key);
  const op = rule.op || "is";
  const want = rule.value;
  const e = isEmptyFor(t, v);
  if (op === "is_empty") return e;
  if (op === "is_not_empty") return !e;
  // A rule still being written (no value yet) filters nothing out.
  if (t !== "checkbox" && (want === null || want === undefined || want === "")) return true;
  if (t === "checkbox") {
    const on = v === true;
    const w = typeof want === "boolean" ? want : ["true", "yes", "1"].includes(String(want).toLowerCase());
    return op === "is_not" ? on !== w : on === w;
  }
  if (t === "number" && ["gt", "lt", "gte", "lte", "is", "is_not"].includes(op)) {
    const w = Number(want);
    if (want === null || want === undefined || want === "" || Number.isNaN(w)) return false;
    if (typeof v !== "number") return op === "is_not";
    return { gt: v > w, lt: v < w, gte: v >= w, lte: v <= w, is: v === w, is_not: v !== w }[op];
  }
  if (t === "date" && ["before", "after", "on_or_before", "on_or_after"].includes(op)) {
    if (typeof v !== "string" || typeof want !== "string") return false;
    return { before: v < want, after: v > want, on_or_before: v <= want, on_or_after: v >= want }[op];
  }
  const w = want === null || want === undefined ? "" : String(want).toLowerCase();
  const vals = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
  const hay = vals.map((x) => String(x).toLowerCase());
  if (op === "is") return t === "multi_select" || t === "link" ? hay.includes(w) : hay.length > 0 && hay[0] === w;
  if (op === "is_not") return !hay.includes(w);
  if (op === "contains") return hay.some((h) => h.includes(w));
  if (op === "not_contains") return !hay.some((h) => h.includes(w));
  return false;
}

function cmpValue(prop, v, people) {
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return null;
  const t = prop ? prop.type : "text";
  if (t === "select" && prop) {
    const i = (prop.options ?? []).findIndex((o) => o.name === v);
    return i < 0 ? (prop.options ?? []).length : i;
  }
  if (t === "person") return String(people?.[v]?.name ?? v).toLowerCase();
  if (t === "number") return typeof v === "number" ? v : null;
  if (t === "checkbox") return v === true ? 1 : 0;
  if (Array.isArray(v)) return v.join(", ").toLowerCase();
  return String(v).toLowerCase();
}

/** Rows sorted by `sort` ([{key, dir}], first rule first); empty values last either way. */
export function sortRows(rows, sort, schema, people) {
  let out = [...rows];
  for (const rule of [...(sort ?? [])].reverse()) {
    const prop = SPECIAL.includes(rule.key) ? null : findProp(schema, rule.key);
    const k = prop ? prop.key : rule.key;
    const desc = rule.dir === "desc";
    const withV = out.map((r) => ({ r, v: cmpValue(prop, rowValue(r, k), people) }));
    const present = withV.filter((x) => x.v !== null);
    const missing = withV.filter((x) => x.v === null);
    present.sort((a, b) => {
      const c = a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
      return desc ? -c : c;
    });
    out = [...present, ...missing].map((x) => x.r);
  }
  return out;
}

export function applyView(rows, view, schema, people) {
  const filtered = (view?.filter ?? []).length ? rows.filter((r) => view.filter.every((f) => matches(r, f, schema))) : rows;
  return (view?.sort ?? []).length ? sortRows(filtered, view.sort, schema, people) : filtered;
}

/**
 * Rows in groups by `key`: a select's options in order (then values it doesn't list), then
 * "No <name>" for empty ones. Multi-select rows appear in each of their options' groups; people
 * and checkboxes group by value.
 */
export function groupRows(rows, key, schema, people) {
  const prop = findProp(schema, key);
  if (!prop) return [{ id: "__all", label: null, value: null, rows }];
  const groups = new Map();
  const add = (id, label, value, color, row) => {
    if (!groups.has(id)) groups.set(id, { id, label, value, color, rows: [] });
    if (row) groups.get(id).rows.push(row);
  };
  if (prop.type === "select" || prop.type === "multi_select") for (const o of prop.options ?? []) add(`o:${o.name}`, o.name, o.name, o.color, null);
  if (prop.type === "checkbox") {
    add("c:true", "Checked", true, null, null);
    add("c:false", "Unchecked", false, null, null);
  }
  const none = { id: "__none", label: `No ${prop.name}`, value: null, color: null, rows: [] };
  for (const r of rows) {
    const v = r.values?.[prop.key];
    if (prop.type === "checkbox") {
      add(v === true ? "c:true" : "c:false", v === true ? "Checked" : "Unchecked", v === true, null, r);
      continue;
    }
    const vals = Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v];
    if (!vals.length) {
      none.rows.push(r);
      continue;
    }
    for (const x of prop.type === "multi_select" ? vals : vals.slice(0, 1)) {
      const label = prop.type === "person" ? people?.[x]?.name ?? "Someone" : String(x);
      add(`o:${x}`, label, x, optionColor(prop, x), r);
    }
  }
  return [...groups.values(), ...(prop.type === "checkbox" ? [] : [none])];
}

/** Operators that make sense for a property type (the filter menu's list). */
export function opsFor(type) {
  switch (type) {
    case "number": return ["is", "is_not", "gt", "lt", "gte", "lte", "is_empty", "is_not_empty"];
    case "date": return ["is", "before", "after", "on_or_before", "on_or_after", "is_empty", "is_not_empty"];
    case "checkbox": return ["is"];
    case "select": case "person": return ["is", "is_not", "is_empty", "is_not_empty"];
    case "multi_select": case "link": return ["contains", "not_contains", "is_empty", "is_not_empty"];
    default: return ["contains", "not_contains", "is", "is_not", "is_empty", "is_not_empty"];
  }
}

export const OP_LABELS = {
  is: "is", is_not: "is not", contains: "contains", not_contains: "does not contain", before: "is before", after: "is after",
  on_or_before: "is on or before", on_or_after: "is on or after", gt: ">", lt: "<", gte: "≥", lte: "≤", is_empty: "is empty", is_not_empty: "is not empty",
};

/** A short id for a new saved view. */
export function newViewId() {
  return `v${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`;
}
