/**
 * The assistant's pure helpers (components/assistant; tested in assistantCore.test.mjs): which scopes it
 * offers where you are, the request's scope, period ranges, labels, starter questions, and the server's
 * answers and saved turns in the shared chat's shapes (components/chat).
 *
 * Scopes (backend services/assistant.py): doc (This doc) · meetings · folder (This folder) · workspace ·
 * everything. The Meetings scope narrows further with composer chips: one meeting, a series, a period.
 */

export const SCOPE_ICON = { doc: "doc", meetings: "mic", folder: "folder", workspace: "users", everything: "sparkle" };
export const SCOPE_LABEL = { doc: "This doc", meetings: "Meetings", folder: "This folder", workspace: "Workspace", everything: "Everything" };

/** The Meetings scope's periods (composer chip). */
export const PERIODS = [
  { value: "", label: "Any time" },
  { value: "week", label: "This week" },
  { value: "7d", label: "Last 7 days" },
  { value: "month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "90d", label: "Last 90 days" },
];

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** A period's dates ({since, until}, inclusive, local days), or {} for any time. */
export function periodRange(period, today = new Date()) {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  switch (period) {
    case "week": {
      const back = (t.getDay() + 6) % 7; // Monday
      return { since: iso(addDays(t, -back)), until: iso(t) };
    }
    case "7d": return { since: iso(addDays(t, -6)), until: iso(t) };
    case "month": return { since: iso(new Date(t.getFullYear(), t.getMonth(), 1)), until: iso(t) };
    case "last-month": {
      const first = new Date(t.getFullYear(), t.getMonth() - 1, 1);
      const last = new Date(t.getFullYear(), t.getMonth(), 0);
      return { since: iso(first), until: iso(last) };
    }
    case "90d": return { since: iso(addDays(t, -89)), until: iso(t) };
    default: return {};
  }
}

/** The scope chips to show: the server's list (only what you can open), in its order. */
export function scopeChips(ctx) {
  const list = (ctx && ctx.scopes) || [{ kind: "everything", label: "Everything", sub: null }];
  return list.map((s) => ({ kind: s.kind, label: SCOPE_LABEL[s.kind] || s.label, sub: s.sub || null, icon: SCOPE_ICON[s.kind] || "sparkle" }));
}

/** The scope to start with: what the person asked for when it's offered here, else the server's default. */
export function initialScope(ctx, wanted) {
  const kinds = scopeChips(ctx).map((s) => s.kind);
  if (wanted && kinds.includes(wanted)) return wanted;
  if (ctx && kinds.includes(ctx.default)) return ctx.default;
  return kinds[0] || "everything";
}

/**
 * The composer chips for the Meetings scope (ChatScopeOption[]): this meeting / all meetings, a series, a
 * period. Values live in the chat's `scope` record: {meeting: "this" | "", series, period}.
 */
export function meetingOptions(ctx) {
  const out = [];
  if (ctx && ctx.meeting) {
    out.push({ id: "meeting", label: "All meetings", icon: "mic", choices: [
      { value: "", label: "All meetings", icon: "mic" },
      { value: "this", label: `This meeting${ctx.meeting.title ? ` · ${ctx.meeting.title}` : ""}`, icon: "calendar" },
    ] });
  }
  const series = (ctx && ctx.series) || [];
  if (series.length) {
    out.push({ id: "series", label: "Any series", icon: "layers", choices: [
      { value: "", label: "Any series" }, ...series.map((s) => ({ value: s, label: s })),
    ] });
  }
  out.push({ id: "period", label: "Any time", icon: "calendar", choices: PERIODS.map((p) => ({ value: p.value, label: p.label })) });
  return out;
}

/** The request's scope (POST /api/v1/ask {scope}). `sub`: the Meetings chips' values. */
export function scopeBody(kind, ctx, sub = {}, today = new Date()) {
  const ws = ctx && ctx.workspace ? ctx.workspace.id : null;
  switch (kind) {
    case "doc": return ctx && ctx.page ? { kind: "doc", page: ctx.page.slug } : { kind: "everything" };
    case "folder": return ws && ctx.folder ? { kind: "folder", workspace: ws, folder: ctx.folder.id } : { kind: "everything" };
    case "workspace": return ws ? { kind: "workspace", workspace: ws } : { kind: "everything" };
    case "meetings": {
      if (!ws) return { kind: "everything" };
      if (sub.meeting === "this" && ctx.meeting) return { kind: "meetings", workspace: ws, meeting: ctx.meeting.id };
      return { kind: "meetings", workspace: ws, ...(sub.series ? { series: sub.series } : {}), ...periodRange(sub.period, today) };
    }
    default: return { kind: "everything" };
  }
}

/** Starter questions per scope (the empty chat). */
export function starters(kind, ctx, home = []) {
  const meetingTitle = ctx && ctx.meeting && ctx.meeting.title;
  switch (kind) {
    case "doc": return [
      { q: "Summarize this doc", icon: "lines" },
      { q: "What did we decide about this in meetings?", icon: "mic" },
      { q: "What's still open here?", icon: "flag" },
    ];
    case "meetings": return meetingTitle ? [
      { q: "What was decided?", icon: "checkCircle" },
      { q: "What are the action items, and who owns them?", icon: "checkSquare" },
      { q: "What's still open?", icon: "flag" },
    ] : [
      { q: "What did we decide this week?", icon: "checkCircle" },
      { q: "What's the latest on the release?", icon: "clock" },
      { q: "Which questions are still open?", icon: "flag" },
    ];
    case "folder": return [
      { q: "What's in this folder?", icon: "folder" },
      { q: "What changed here this week?", icon: "clock" },
    ];
    case "workspace": return [
      { q: "Catch me up on this week", icon: "clock" },
      { q: "What are my open action items?", icon: "checkSquare" },
    ];
    default: return home.length ? home : [
      { q: "Catch me up on this week", icon: "clock" },
      { q: "What are my open action items?", icon: "checkSquare" },
    ];
  }
}

const KIND_ICON = { page: "lines", doc: "doc", file: "layers", guide: "listTree", folder: "folder", workspace: "users", meeting: "mic" };

/** One answer's citation in the shared chat's shape. `link(c)` → {href, external} (lib/search hrefOf). */
export function toCitation(c, link) {
  const l = link(c);
  const moment = c.source_kind === "moment" || !!c.moment;
  const meeting = c.source_kind === "meeting" || (!!c.meeting_id && !moment);
  return {
    token: c.label,
    title: c.title || "Untitled",
    subtitle: c.subtitle || null,
    meta: c.moment || (c.source_kind === "this page" ? "This doc" : null),
    quote: c.quote || c.text || null,
    href: l.href,
    external: l.external,
    icon: moment ? "mic" : meeting ? "calendar" : KIND_ICON[c.kind] || "doc",
    action: moment ? "Jump to moment" : "Open",
  };
}

/** A search result / meeting the answer read, as a chat source. */
export function toSource(it, link) {
  const l = link(it);
  return { id: it.key || String(it.n), title: it.title || "Untitled", subtitle: it.subtitle || null, href: l.href, icon: KIND_ICON[it.kind] || "doc" };
}

const STAGES = {
  understanding: "Reading your question…",
  searching: { doc: "Looking in this doc and your meetings…", meetings: "Finding the meetings…", folder: "Searching this folder…", workspace: "Searching the workspace…", everything: "Searching everything you can open…" },
  answering: "Writing the answer…",
};

export function stageLabel(stage, kind) {
  const s = STAGES[stage];
  if (!s) return "Thinking…";
  return typeof s === "string" ? s : s[kind] || s.everything;
}

/** A saved conversation's turns (GET /api/v1/ask/threads/{id}) as chat turns. */
export function threadTurns(turns, link) {
  return (turns || []).map((t, i) => ({
    id: `s${i}`,
    question: t.question || "",
    answer: t.answer || "",
    state: t.withheld ? "withheld" : "done",
    scopeNote: t.scope && t.scope.label ? t.scope.label : null,
    citations: t.withheld ? [] : (t.citations || []).map((c) => toCitation(c, link)),
    sources: [],
  }));
}

/** ⌘J / Ctrl+J (not with Shift / Alt), and not when something already handled it (an editor's own ⌘J). */
export function isAssistantKey(e) {
  if (e.defaultPrevented || e.isComposing || e.altKey || e.shiftKey) return false;
  if (!(e.metaKey || e.ctrlKey) || (e.metaKey && e.ctrlKey)) return false;
  return (e.key || "").toLowerCase() === "j" || e.code === "KeyJ";
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t#]*(?:\{#[^}]*\})?\s*$/;
const plainHeading = (t) => (t || "").replace(/[*_`~[\]]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * A classic document's Markdown with `insert` as its own paragraph(s): at the end of the section headed
 * `heading` (before the next heading of the same or a higher level), or at the end when there's none.
 */
export function insertAfterSection(markdown, heading, insert) {
  const text = (insert || "").trim();
  if (!text) return markdown || "";
  const lines = (markdown || "").split("\n");
  const want = plainHeading(heading);
  let at = -1;
  let level = 0;
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = HEADING.exec(lines[i]);
    if (!h) continue;
    if (at >= 0 && h[1].length <= level) {
      return splice(lines, i, text);
    }
    if (at < 0 && want && plainHeading(h[2]) === want) {
      at = i;
      level = h[1].length;
    }
  }
  return splice(lines, lines.length, text);
}

function splice(lines, index, text) {
  const before = lines.slice(0, index);
  const after = lines.slice(index);
  while (before.length && before[before.length - 1].trim() === "") before.pop();
  const head = before.length ? [...before, "", text] : [text];
  return after.length ? [...head, "", ...after].join("\n") : `${head.join("\n")}\n`;
}

/** A textarea's value with `insert` at the caret, on its own paragraph: {value, caret}. */
export function insertAtCaret(value, caret, insert) {
  const text = (insert || "").trim();
  const v = value || "";
  const at = Math.max(0, Math.min(caret ?? v.length, v.length));
  const lineEnd = v.indexOf("\n", at);
  const cut = lineEnd < 0 ? v.length : lineEnd;
  const before = v.slice(0, cut).replace(/\s+$/, "");
  const after = v.slice(cut).replace(/^\s+/, "");
  const head = before ? `${before}\n\n${text}` : text;
  return { value: after ? `${head}\n\n${after}` : `${head}\n`, caret: head.length };
}
