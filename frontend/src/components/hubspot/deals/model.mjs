/**
 * The Deals section's model (plain module, no React; tests: model.test.mjs). One or more HubSpot teams' boards
 * (a team's Deals, or Deals across all your teams) become rows, filters, board columns, the cards' one signal line,
 * the list's sort and the header's summary.
 *
 * Board columns are keyed by stage LABEL, so the same stage of two teams' pipelines is one column in the all-teams
 * view. Closed deals (behind "Show closed") are grouped as Closed won / Closed lost, whatever HubSpot calls the stage.
 */

export const QUIET_DAYS = 14;
/** Cards a column shows before "Show N more" (a column of LIMIT + 1 shows them all: never "Show 1 more"). */
export const CARD_LIMIT = 5;
export const NO_COMPANY = "No company";

/**
 * @param {Array<{ ws: string, wsName?: string | null, team?: string | null, board: any }>} entries
 * @returns {any[]} every deal, with the workspace it's in (ws, wsName) and its team's name (team)
 */
export function rowsOf(entries) {
  const out = [];
  for (const e of entries) {
    const team = e.board?.team?.name ?? e.team ?? null;
    for (const d of e.board?.deals ?? []) out.push({ ...d, ws: e.ws, wsName: e.wsName ?? null, team });
  }
  return out;
}

/** Pipeline labels, in board order (one entry per label across teams). */
export function pipelinesOf(entries) {
  const seen = new Set();
  for (const e of entries) {
    for (const p of e.board?.pipelines ?? []) if (p?.label) seen.add(p.label);
    for (const s of e.board?.stages ?? []) if (s?.pipeline) seen.add(s.pipeline);
  }
  return [...seen];
}

/** The stages of a pipeline (all when ""), in pipeline order, one per label: [{ label, closed }]. */
export function stagesOf(entries, pipeline = "") {
  const out = new Map();
  for (const e of entries) {
    for (const s of e.board?.stages ?? []) {
      if (!s?.label || (pipeline && s.pipeline && s.pipeline !== pipeline)) continue;
      if (!out.has(s.label)) out.set(s.label, { label: s.label, closed: !!s.closed });
    }
  }
  return [...out.values()];
}

/**
 * @param {any[]} rows
 * @param {{ team?: string, pipeline?: string, owner?: string, company?: string, quiet?: boolean, closed?: boolean }} f
 */
export function filterRows(rows, f) {
  return rows.filter((r) => (f.closed || !r.closed)
    && (!f.team || r.ws === f.team)
    && (!f.pipeline || !r.pipeline || r.pipeline === f.pipeline)
    && (!f.owner || r.owner === f.owner)
    && (!f.company || r.company?.name === f.company)
    && (!f.quiet || (r.quiet && !r.closed)));
}

const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b));
export const ownersOf = (rows) => uniq(rows.map((r) => r.owner));
export const companiesOf = (rows) => uniq(rows.map((r) => r.company?.name));

/** Biggest first, then A–Z. */
export const byAmount = (a, b) => (b.amount ?? -1) - (a.amount ?? -1) || String(a.name).localeCompare(String(b.name));

/**
 * The board's columns: each open stage (empty ones too: the board draws them as a thin strip), deals in a stage the
 * pipeline doesn't list ("Other stages"), then, with Show closed, Closed won and Closed lost.
 * @returns {Array<{ key: string, label: string, closed: boolean, other?: boolean, deals: any[] }>}
 */
export function columnsOf(stages, rows, showClosed) {
  const open = stages.filter((s) => !s.closed);
  const known = new Set(open.map((s) => s.label));
  const cols = open.map((s) => ({ key: `s:${s.label}`, label: s.label, closed: false, deals: rows.filter((r) => !r.closed && r.stage === s.label).sort(byAmount) }));
  const other = rows.filter((r) => !r.closed && (!r.stage || !known.has(r.stage))).sort(byAmount);
  if (other.length) cols.push({ key: "_other", label: "Other stages", closed: false, other: true, deals: other });
  if (showClosed) {
    const closed = rows.filter((r) => r.closed);
    cols.push({ key: "_won", label: "Closed won", closed: true, deals: closed.filter((r) => r.closed_label === "Closed won").sort(byAmount) });
    cols.push({ key: "_lost", label: "Closed lost", closed: true, deals: closed.filter((r) => r.closed_label === "Closed lost").sort(byAmount) });
    const rest = closed.filter((r) => r.closed_label !== "Closed won" && r.closed_label !== "Closed lost");
    if (rest.length) cols.push({ key: "_closed", label: "Closed", closed: true, deals: rest.sort(byAmount) });
  }
  return cols;
}

/** How many cards a column shows: all when expanded or when only one would be hidden, else LIMIT - 1. */
export function visibleCount(n, expanded = false, limit = CARD_LIMIT) {
  return expanded || n <= limit ? n : limit - 1;
}

/** "3 calls" / "1 call" / null (no calls: the signal line says it, once). */
export const callsLabel = (n) => (n ? `${n} ${n === 1 ? "call" : "calls"}` : null);

/**
 * A card's one status line, or null: "No calls yet" (no calls, open deal) or "Quiet N days" (calls, but none in
 * QUIET_DAYS). A closed deal has none.
 * @returns {{ kind: "none" | "quiet", label: string } | null}
 */
export function signalOf(d) {
  if (d.closed) return null;
  if (!d.calls) return { kind: "none", label: "No calls yet" };
  if (d.days_quiet != null && d.days_quiet >= QUIET_DAYS) return { kind: "quiet", label: `Quiet ${d.days_quiet} ${d.days_quiet === 1 ? "day" : "days"}` };
  return null;
}

const SORT = {
  name: (r) => String(r.name || "").toLowerCase(),
  company: (r) => (r.company?.name ? r.company.name.toLowerCase() : null),
  stage: (r) => (r.closed ? r.closed_label || "Closed" : r.stage || null),
  amount: (r) => r.amount ?? null,
  owner: (r) => (r.owner ? r.owner.toLowerCase() : null),
  close: (r) => r.close_date || null,
  last: (r) => r.last_call?.date || null,
  calls: (r) => r.calls ?? 0,
  team: (r) => (r.team || r.wsName || "").toLowerCase() || null,
};
export const SORT_KEYS = Object.keys(SORT);

/** The list's sort: by a column, ascending or descending; empty values always last. */
export function sortRows(rows, key = "amount", dir = "desc") {
  const get = SORT[key] ?? SORT.amount;
  const m = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a), y = get(b);
    if (x == null && y == null) return byAmount(a, b);
    if (x == null) return 1;
    if (y == null) return -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return c * m || byAmount(a, b);
  });
}

/**
 * The header's summary of open deals: { open, quiet, amount, currency, mixed } — amount in the most used currency
 * (mixed: other currencies left out).
 */
export function summaryOf(rows) {
  const open = rows.filter((r) => !r.closed);
  const by = new Map();
  for (const r of open) {
    if (r.amount == null) continue;
    const c = r.currency || "USD";
    const cur = by.get(c) ?? { n: 0, sum: 0 };
    by.set(c, { n: cur.n + 1, sum: cur.sum + r.amount });
  }
  let currency = null, amount = null;
  for (const [c, v] of by) if (!currency || v.n > by.get(currency).n) { currency = c; amount = v.sum; }
  return { open: open.length, quiet: open.filter((r) => r.quiet).length, amount, currency, mixed: by.size > 1 };
}

/** Group by company: [[company, deals]] A–Z, deals without one last. */
export function groupByCompany(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = r.company?.name || NO_COMPANY;
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return [...m.entries()].sort(([a], [b]) => (a === NO_COMPANY ? 1 : b === NO_COMPANY ? -1 : a.localeCompare(b)));
}

/** "54 min" / "1 h 05 min" for a call's length (null under a minute or unknown). */
export function minutes(s) {
  if (!s || s < 60) return null;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}
