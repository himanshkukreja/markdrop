/**
 * Ask's pure helpers (the Ask page components/ask/AskPage.tsx, the panel, the home; tested in askCore.test.mjs).
 *
 * An answer cites `[n]` (item n) or `[n-sK]` (line K of item n's meeting transcript). The server
 * keeps only labels it sent and the asker can still open; the UI numbers sources in the order the
 * answer first cites them, and nests a meeting's moments under it.
 */

const CITE = /\[(\d{1,2})(?:-s(\d{1,5}))?\]/g;

/** The answer as text and citation segments; labels outside `known` stay plain text. */
export function askSegments(answer, known) {
  const ok = new Set(known || []);
  const out = [];
  const s = answer || "";
  let at = 0;
  let m;
  CITE.lastIndex = 0;
  while ((m = CITE.exec(s))) {
    const label = m[0].slice(1, -1);
    if (!ok.has(label)) continue;
    if (m.index > at) out.push({ text: s.slice(at, m.index) });
    out.push({ cite: label, n: Number(m[1]) });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

/** Sources in first-cited order: [{n, shown, title, url, kind, slug, task, moments: [{label, moment, url}]}]. */
export function sourcesOf(answer, citations) {
  const byLabel = new Map();
  for (const c of citations || []) if (c && c.label) byLabel.set(String(c.label), c);
  const order = [];
  const byN = new Map();
  for (const seg of askSegments(answer, byLabel.keys())) {
    if (seg.cite === undefined) continue;
    const c = byLabel.get(seg.cite);
    let src = byN.get(seg.n);
    if (!src) {
      src = { n: seg.n, shown: order.length + 1, title: null, url: null, kind: null, slug: null, task: null, moments: [] };
      byN.set(seg.n, src);
      order.push(src);
    }
    if (seg.cite.includes("-s")) {
      if (!src.moments.some((x) => x.label === seg.cite)) src.moments.push({ label: seg.cite, moment: c.moment || null, url: c.url || null, slug: c.slug || null });
      if (!src.title) src.title = (c.title || "").split(" · ")[0] || null;
    } else {
      src.title = c.title || src.title;
      src.url = c.url || null;
      src.kind = c.kind || null;
      src.slug = c.slug || null;
      src.task = c.text || null;
    }
  }
  // A moment cited without its item: the item opens at its first moment.
  for (const src of order) if (!src.url && src.moments[0]) { src.url = src.moments[0].url; src.slug = src.moments[0].slug; src.kind = "page"; }
  return order;
}

/** The chip number a label shows (its source's position; a moment shows "2·1", its source and order). */
export function chipOf(sources, label) {
  const n = Number(String(label).split("-")[0]);
  const src = (sources || []).find((s) => s.n === n);
  if (!src) return String(n);
  if (!String(label).includes("-s")) return String(src.shown);
  const i = src.moments.findIndex((x) => x.label === label);
  return i >= 0 ? `${src.shown}·${i + 1}` : String(src.shown);
}

/** Blocks of an answer: paragraphs, and bullet lists (lines starting "- " / "* " / "1. "). */
export function blocksOf(text) {
  const out = [];
  for (const block of (text || "").split(/\n{2,}/)) {
    const lines = block.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
    if (!lines.length) continue;
    let para = [];
    let list = null;
    const flush = () => { if (para.length) { out.push({ type: "p", text: para.join(" ") }); para = []; } };
    for (const l of lines) {
      const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(l);
      if (m) {
        flush();
        if (!list) { list = { type: "ul", items: [] }; out.push(list); }
        list.items.push(m[1]);
      } else if (list && /^\s{2,}\S/.test(l)) {
        list.items[list.items.length - 1] += ` ${l.trim()}`;
      } else {
        list = null;
        para.push(l.trim());
      }
    }
    flush();
  }
  return out;
}

export const SUGGESTION_ICONS = { catch_up: "calendar", my_actions: "checkSquare", ask: "sparkle" };

export const STAGES = {
  understanding: "Understanding your question…",
  searching: "Looking through everything you can open…",
  answering: "Writing an answer…",
};

// ── The Ask page and live suggestions ─────────────────────────────────────────

const ID = /^[0-9a-f]{24}$/;

/** The Ask page's address: /ask, ?workspace=<id> (Ask <Workspace>) or ?scope=mine, ?c=<conversation>, ?q=<ask this now>. */
export function askHref({ workspace = null, mine = false, thread = null, q = null } = {}) {
  const p = new URLSearchParams();
  if (workspace && ID.test(workspace)) p.set("workspace", workspace);
  else if (mine) p.set("scope", "mine");
  if (thread && ID.test(thread)) p.set("c", thread);
  if (q && q.trim()) p.set("q", q.trim().slice(0, 500));
  const qs = p.toString();
  return `/ask${qs ? `?${qs}` : ""}`;
}

/** The Ask page's URL read back: {workspace, mine, thread, q} (anything malformed is dropped). */
export function readAskParams(search) {
  const p = new URLSearchParams(search || "");
  const ws = p.get("workspace");
  const c = p.get("c") || p.get("ask");
  const q = (p.get("q") || "").trim().slice(0, 500);
  return { workspace: ws && ID.test(ws) ? ws : null, mine: p.get("scope") === "mine", thread: c && ID.test(c) ? c : null, q: q || null };
}

const PERSONAL_ICON = { my_actions: "checkSquare", catch_up: "clock", ask: "mic" };

/**
 * GET /ask/suggestions as the chat's starters: the team's (each with its topic as a small label), then the
 * viewer's own, at most `max` (team first, but at least one of your own when there's room).
 */
export function suggestionsOf(sug, max = 8) {
  if (!sug) return [];
  const team = (sug.team || []).map((t) => ({ q: t.question, label: t.topic || null, icon: "sparkle" }));
  const mine = (sug.personal || []).map((p) => ({ q: p.question, icon: p.icon || PERSONAL_ICON[p.intent] || "sparkle" }));
  const roomForMine = Math.min(mine.length, team.length ? Math.max(1, max - team.length) : max);
  const out = [...team.slice(0, max - roomForMine), ...mine.slice(0, roomForMine)];
  const seen = new Set();
  return out.filter((x) => (seen.has(x.q.toLowerCase()) ? false : (seen.add(x.q.toLowerCase()), true)));
}

/** A few live chips for the home's Ask bar: the team's first (topic: question), then yours. */
export function homeChips(sug, max = 3) {
  if (!sug) return [];
  const team = (sug.team || []).slice(0, max).map((t) => ({ label: t.topic ? `${t.topic}: ${t.question}` : t.question, question: t.question, team: true }));
  const mine = (sug.personal || []).filter((p) => p.intent === "ask").map((p) => ({ label: p.label, question: p.question, team: false }));
  return [...team, ...mine].slice(0, max);
}

/** "Updated 2 h ago." under a workspace's suggestions ("" without a built list). */
export function updatedLine(sug, now = Date.now()) {
  if (!sug || !sug.updated_at || !(sug.team || []).length) return "";
  const t = Date.parse(sug.updated_at);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  const ago = s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
  return `Updated ${ago}.`;
}
