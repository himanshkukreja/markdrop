/**
 * Meetings on the shared chat (components/chat): the transport for Ask this meeting / Ask across meetings,
 * how a meeting citation reads in the sources list (meeting, date, series, speaker · time, the line, "Jump to
 * the moment"), the scope chips (series, period), follow-ups, and the saved conversation (ask_threads).
 */
import { getAskThread } from "@/lib/ask";
import {
  askMeeting, askMeetings, fmtMeetingDate,
  type MeetingAskEvent, type MeetingCitation, type MeetingSeries, type RankedMeeting,
} from "@/lib/meetings";
import type { ChatCitation, ChatEvent, ChatScope, ChatScopeOption, ChatSource, ChatTransport, ChatTurn } from "@/components/chat";

/** The meeting tokens the answers cite: s12 (a line), n3 (the notes), M2 (a meeting), M2-s14 (its line). */
export const MEETING_CITE = /\[((?:M\d{1,2}(?:-[sn]\d{1,5})?)|(?:[sn]\d{1,5}))\]/g;

export interface MeetingInfo { title: string | null; date: string | null; series?: string | null }

const when = (date: string | null | undefined, series?: string | null, title?: string | null) =>
  [fmtMeetingDate(date), series && series !== title ? series : null].filter(Boolean).join(" · ") || null;

/** A meeting citation as the chat shows it. `ranked` (across) / `meeting` (one) fill in the meeting. */
export function toCitation(c: MeetingCitation, ctx: { meeting?: MeetingInfo | null; ranked?: RankedMeeting[] }): ChatCitation {
  const r = c.meeting_id ? ctx.ranked?.find((x) => x.id === c.meeting_id) : undefined;
  // Across meetings the server's text is "<meeting> · <speaker, 12:34>" or "<meeting> · <date>".
  const [head, tail] = c.text.includes(" · ") ? [c.text.slice(0, c.text.indexOf(" · ")), c.text.slice(c.text.indexOf(" · ") + 3)] : [null, c.text];
  const m: MeetingInfo | null = r ? { title: r.title, date: r.date, series: r.series } : ctx.meeting ?? (head ? { title: head, date: null } : null);
  const title = m?.title || head || "Meeting";
  if (c.kind === "segment") {
    const moment = c.speaker ? [c.speaker, c.at].filter(Boolean).join(" · ") : tail;
    return { token: c.label, title, subtitle: when(m?.date, m?.series, title), meta: moment, quote: c.quote ?? null,
      href: c.href, icon: "mic", action: "Jump to the moment" };
  }
  const notes = c.label.startsWith("n");
  return { token: c.label, title: notes ? `${title} · notes` : title,
    subtitle: when(m?.date, m?.series, title) ?? (head ? tail : null), quote: c.quote ?? null,
    href: c.href, icon: notes ? "lines" : "doc", action: notes ? "Open in the notes" : "Open the meeting" };
}

const rankedSource = (r: RankedMeeting): ChatSource => ({
  id: r.id, title: r.title || "Meeting", subtitle: when(r.date, r.series, r.title), href: `/${r.slug}`, icon: "mic",
});

/** Ask this meeting (`meetingId`) or across a workspace's meetings (`workspaceId`, scope {series, period}). */
export function meetingTransport(opts: { mode: "one"; meetingId: string; meeting: MeetingInfo | null }
  | { mode: "all"; workspaceId: string }): ChatTransport<ChatScope> {
  return async ({ question, history, scope, threadId, signal }, emit) => {
    let ranked: RankedMeeting[] = [];
    const onEvent = (e: MeetingAskEvent) => {
      if (e.type === "status") {
        emit({ type: "stage", label: opts.mode === "one" ? "Reading the meeting…"
          : e.stage === "searching" ? "Finding the meetings…" : ranked.length ? `Reading ${ranked.length} ${ranked.length === 1 ? "meeting" : "meetings"}…` : "Reading the meetings…" });
      } else if (e.type === "results") {
        ranked = e.items;
        emit({ type: "sources", items: e.items.map(rankedSource), note: scopeNote(e.scope) });
        if (e.items.length) emit({ type: "stage", label: `Reading ${e.items.length} ${e.items.length === 1 ? "meeting" : "meetings"}…` });
      } else if (e.type === "delta") emit({ type: "delta", text: e.text });
      else if (e.type === "done") {
        ranked = e.ranked ?? ranked;
        const ctx = opts.mode === "one" ? { meeting: opts.meeting } : { ranked };
        emit({ type: "done", answer: e.answer, citations: (e.citations || []).map((c) => toCitation(c, ctx)),
          sources: ranked.map(rankedSource), note: scopeNote(e.scope), threadId: e.thread_id ?? undefined });
      } else if (e.type === "limit") emit({ type: "limit", message: e.message || "The AI budget is used up for now. Try again later." });
      else if (e.type === "error") emit({ type: "error", message: e.detail });
    };
    if (opts.mode === "one") {
      await askMeeting(opts.meetingId, { question, history, thread_id: threadId }, onEvent, signal);
    } else {
      await askMeetings({ workspace: opts.workspaceId, question, history, thread_id: threadId, ...scopeParams(scope) }, onEvent, signal);
    }
  };
}

function scopeNote(s: { label: string; detected: boolean } | null | undefined): string | null {
  if (!s?.label) return null;
  return `${s.detected ? "From your question: " : "Only "}${s.label}`;
}

// ── Scope: series and period ─────────────────────────────────────────────────

export const PERIODS = [
  { value: "", label: "Any time" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
] as const;

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function periodRange(p: string, now = new Date()): { since?: string; until?: string } {
  if (p === "7" || p === "30") return { since: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - Number(p))), until: iso(now) };
  if (p === "this_month") return { since: iso(new Date(now.getFullYear(), now.getMonth(), 1)), until: iso(now) };
  if (p === "last_month") return { since: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), until: iso(new Date(now.getFullYear(), now.getMonth(), 0)) };
  return {};
}

export function scopeParams(scope: ChatScope): { series?: string; since?: string; until?: string } {
  return { ...(scope.series ? { series: scope.series } : {}), ...periodRange(scope.period ?? "") };
}

export function scopeOptions(series: MeetingSeries[]): ChatScopeOption[] {
  const out: ChatScopeOption[] = [];
  if (series.length) {
    out.push({ id: "series", label: "All meetings", icon: "mic",
      choices: [{ value: "", label: "All meetings" }, ...series.map((x) => ({ value: x.name, label: x.name, icon: "refresh" }))] });
  }
  out.push({ id: "period", label: "Any time", icon: "calendar", choices: PERIODS.map((p) => ({ value: p.value, label: p.label })) });
  return out;
}

// ── Starters and follow-ups ──────────────────────────────────────────────────

export const ONE_STARTERS = [
  { q: "What did we decide?", icon: "checkCircle" },
  { q: "What are the action items, and who owns them?", icon: "checkSquare" },
  { q: "What's still open?", icon: "flag" },
  { q: "Summarize it in three bullets", icon: "lines" },
];

export const ALL_STARTERS = [
  { q: "What did we decide this week?", icon: "checkCircle" },
  { q: "What are my open action items?", icon: "checkSquare" },
  { q: "What's blocking the release?", icon: "flag" },
  { q: "Catch me up on the last standup", icon: "history" },
];

export function followUpsFor(mode: "one" | "all", asked: string[]) {
  const seen = new Set(asked.map((q) => q.trim().toLowerCase()));
  return (turn: ChatTurn): string[] => {
    const meetings = new Set(turn.citations.map((c) => c.title.replace(/ · notes$/, "")));
    const one = meetings.size === 1 ? [...meetings][0] : null;
    const pool = mode === "one"
      ? ["Who owns the next steps?", "What's still open?", "What was said about the risks?", "Summarize it in three bullets"]
      : [one ? `What else was decided in ${one}?` : null, "Who owns the next steps?", "What's still open from this?", "When was this first discussed?"];
    return pool.filter((q): q is string => !!q && !seen.has(q.toLowerCase()) && q.toLowerCase() !== turn.question.trim().toLowerCase()).slice(0, 3);
  };
}

// ── The saved conversation ───────────────────────────────────────────────────

const THREAD_KEY = (user: string, key: string) => `md:mt-thread:${user}:${key}`;

export function savedThread(user: string | null | undefined, key: string): string | null {
  if (!user) return null;
  try { return window.localStorage.getItem(THREAD_KEY(user, key)); } catch { return null; }
}

export function saveThread(user: string | null | undefined, key: string, id: string | null) {
  if (!user) return;
  try {
    if (id) window.localStorage.setItem(THREAD_KEY(user, key), id);
    else window.localStorage.removeItem(THREAD_KEY(user, key));
  } catch { /* storage off */ }
}

/** A saved conversation's turns (a turn whose meeting closed comes back withheld). */
export async function loadMeetingThread(id: string, meeting: MeetingInfo | null): Promise<ChatTurn[]> {
  const t = await getAskThread(id);
  return t.turns.map((x, i) => ({
    id: `saved-${id}-${i}`,
    question: x.question,
    answer: x.answer || "",
    state: x.withheld ? "withheld" : "done",
    citations: ((x.citations || []) as unknown as MeetingCitation[]).map((c) => toCitation(c, { meeting })),
    sources: [],
  }));
}

export type { ChatEvent };
