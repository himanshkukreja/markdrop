/**
 * Global search's pure helpers (no imports, so `node --test` loads this file as is):
 * the query's shape, highlight segments from the server's mark ranges, an AI answer cut into text
 * and citation chips, recent searches, grouping labels and short relative times.
 *
 * The server (services/search.py) decides what matches and what the caller may open; nothing here
 * filters for privacy.
 */

const QUESTION_START = /^(who|what|when|where|why|how|which|whose|whom|is|are|was|were|do|does|did|can|could|should|would|will|has|have|had|explain|summari[sz]e|compare|tell me|show me|find me|list|give me|any|anything|everything|docs? (about|on|for|that)|something (about|on|that)|the (doc|page|file|one) (about|on|with|where|that))\b/i;

/** A question or a description: AI search runs on its own for these (owner decision, 2026-11-04).
 *  Mirrors services/search_text.looks_like_question. */
export function looksLikeQuestion(q) {
  const s = (q || "").trim();
  if (s.length < 8) return false;
  if (s.endsWith("?")) return true;
  const words = s.split(/\s+/);
  if (words.length >= 3 && QUESTION_START.test(s)) return true;
  return words.length >= 7;
}

/** `text` cut at the server's `[start, end)` ranges: [{text, mark}] (overlaps merged, out-of-range dropped). */
export function highlight(text, marks) {
  const t = text || "";
  const ranges = (Array.isArray(marks) ? marks : [])
    .filter((m) => Array.isArray(m) && Number.isInteger(m[0]) && Number.isInteger(m[1]) && m[0] < m[1] && m[0] >= 0)
    .map((m) => [m[0], Math.min(m[1], t.length)])
    .filter((m) => m[0] < t.length)
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out = [];
  let at = 0;
  for (const [a, b] of merged) {
    if (a > at) out.push({ text: t.slice(at, a), mark: false });
    out.push({ text: t.slice(a, b), mark: true });
    at = b;
  }
  if (at < t.length) out.push({ text: t.slice(at), mark: false });
  return out.length ? out : [{ text: t, mark: false }];
}

/** An AI answer as text runs and citation chips: "… day one [2]." → [{text}, {cite: 2}, {text: "."}].
 *  Only numbers in `known` become chips (the rest stay text). */
export function citeSegments(answer, known) {
  const ok = new Set(known || []);
  const out = [];
  const re = /\[(\d{1,3})\]/g;
  let at = 0;
  let m;
  const s = answer || "";
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    if (!ok.has(n)) continue;
    if (m.index > at) out.push({ text: s.slice(at, m.index) });
    out.push({ cite: n });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

export const RECENT_KEY = "md_recent_searches";
export const RECENT_MAX = 8;

/** The recent-search list with `q` first (case-insensitive dedupe, trimmed, capped). */
export function pushRecent(list, q) {
  const s = (q || "").trim().slice(0, 120);
  const prev = Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  if (s.length < 2) return prev.slice(0, RECENT_MAX);
  const key = s.toLowerCase();
  return [s, ...prev.filter((x) => x.toLowerCase() !== key)].slice(0, RECENT_MAX);
}

export const GROUP_LABELS = {
  page: "Pages", doc: "Documents", file: "Files", folder: "Folders", workspace: "Workspaces", guide: "Guides", trash: "In Trash",
};

export const KIND_LABELS = {
  page: "Page", doc: "Document", file: "File", folder: "Folder", workspace: "Workspace", guide: "Guide page",
};

/** "just now", "5m", "3h", "2d", "Mar 4", "Mar 4, 2025". */
export function shortAgo(iso, now = Date.now()) {
  if (!iso) return "";
  const t = Date.parse(typeof iso === "string" && !/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? `${iso}Z` : iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  const d = new Date(t);
  const sameYear = d.getUTCFullYear() === new Date(now).getUTCFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}

/** Where an item lives, for its row: "Acme › Engineering › Runbooks", "Help center", "My files". */
export function whereOf(item) {
  if (!item) return "";
  if (item.kind === "workspace") return "Workspace";
  if (item.kind === "guide") return [item.guide?.name, item.path].filter(Boolean).join(" · ");
  const parts = [];
  if (item.workspace?.name) parts.push(item.workspace.name);
  // Teams: the team(s) it belongs to, after the workspace ("Acme › Sales").
  if (Array.isArray(item.teams) && item.teams.length) parts.push(item.teams.map((t) => t.name).join(", "));
  const path = item.folder?.path;
  if (Array.isArray(path) && path.length) parts.push(...path);
  if (!parts.length) parts.push(item.owner?.is_you ? "My files" : "Shared with me");
  return parts.join(" › ");
}
