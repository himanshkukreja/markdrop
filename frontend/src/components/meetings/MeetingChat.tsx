"use client";

/**
 * Asking meetings: one thread of questions and streamed answers whose citations are chips that open
 * the moment they cite ("Ada Lovelace, 12:34" → the transcript line, "Meeting notes" → the page).
 *
 *  - mode "one": Ask this meeting (multi-turn: the last 6 turns go with each question).
 *  - mode "all": Ask across meetings (each question stands alone; the meetings it used are listed).
 *
 * Shares Ask this page's look (components/pages/ai/ask.css): the same thread, composer and notices.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon, copyText, useToast } from "@/components/ui";
import {
  askMeeting, askMeetings, fmtMeetingDate,
  type MeetingAskEvent, type MeetingCitation, type RankedMeeting,
} from "@/lib/meetings";
import "@/components/pages/ai/ask.css";
import "./meetings.css";

interface Turn {
  id: number;
  q: string;
  a: string;
  state: "streaming" | "done" | "stopped" | "limit" | "error";
  note?: string;
  citations?: MeetingCitation[];
  ranked?: RankedMeeting[];
  stage?: "searching" | "answering";
}

export interface MeetingChatProps {
  mode: "one" | "all";
  meetingId?: string;
  workspaceId?: string;
  suggestions: Array<{ q: string; icon: string }>;
  emptyTitle: string;
  emptySub: ReactNode;
  placeholder: string;
  /** Rendered above the thread (e.g. the summary's progress). */
  banner?: ReactNode;
  /** A citation was opened (the panel closes on phones). */
  onNavigate?: () => void;
  autoFocus?: boolean;
  /** "panel": fills a pa-ask panel (body + composer); "inline": a card on a page. */
  layout?: "panel" | "inline";
}

const FAILED = "Something went wrong while answering. Try again.";
const memory = new Map<string, Turn[]>();
let seq = 0;

export function MeetingChat({ mode, meetingId, workspaceId, suggestions, emptyTitle, emptySub, placeholder, banner, onNavigate, autoFocus, layout = "panel" }: MeetingChatProps) {
  const key = mode === "one" ? `m:${meetingId}` : `w:${workspaceId}`;
  const toast = useToast();
  const [turns, setTurnsState] = useState<Turn[]>(() => memory.get(key) ?? []);
  const setTurns = useCallback((fn: (t: Turn[]) => Turn[]) => setTurnsState((prev) => {
    const next = fn(prev);
    memory.set(key, next);
    return next;
  }), [key]);
  const [q, setQ] = useState("");
  const ctrl = useRef<AbortController | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const streaming = turns.some((t) => t.state === "streaming");

  useEffect(() => {
    ctrl.current?.abort();
    setTurnsState(memory.get(key) ?? []);
  }, [key]);
  useEffect(() => () => ctrl.current?.abort(), []);
  useEffect(() => {
    if (autoFocus) window.setTimeout(() => input.current?.focus({ preventScroll: true }), 60);
  }, [autoFocus]);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && stick.current && layout === "panel") el.scrollTop = el.scrollHeight;
  }, [turns, layout]);

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || streaming) return;
    const history = mode === "one"
      ? turns.filter((t) => t.state === "done" && t.a).slice(-6).map((t) => ({ question: t.q, answer: t.a }))
      : undefined;
    const id = ++seq;
    setTurns((t) => (mode === "all" ? [...t.slice(-4), { id, q: text, a: "", state: "streaming" }] : [...t, { id, q: text, a: "", state: "streaming" }]));
    setQ("");
    if (input.current) input.current.style.height = "";
    stick.current = true;
    const c = new AbortController();
    ctrl.current = c;
    const patch = (fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));
    let ended = false;
    const onEvent = (e: MeetingAskEvent) => {
      if (e.type === "status") patch((t) => ({ ...t, stage: e.stage }));
      else if (e.type === "results") patch((t) => ({ ...t, ranked: e.items }));
      else if (e.type === "delta") patch((t) => ({ ...t, a: t.a + e.text }));
      else if (e.type === "done") {
        ended = true;
        patch((t) => {
          const a = (e.answer || t.a || "").trim();
          return { ...t, a, citations: e.citations || [], ranked: e.ranked ?? t.ranked, state: a ? "done" : "error", note: a ? undefined : FAILED };
        });
      } else if (e.type === "limit") {
        ended = true;
        patch((t) => ({ ...t, state: "limit", note: e.message || "AI limit reached. Try again later." }));
      } else if (e.type === "error") {
        ended = true;
        patch((t) => ({ ...t, state: "error", note: e.detail || FAILED }));
      }
    };
    try {
      if (mode === "one" && meetingId) await askMeeting(meetingId, { question: text, history }, onEvent, c.signal);
      else if (workspaceId) await askMeetings({ workspace: workspaceId, question: text }, onEvent, c.signal);
      if (!ended) patch((t) => (t.state === "streaming" ? { ...t, state: c.signal.aborted || t.a ? "stopped" : "error", note: c.signal.aborted ? undefined : t.a ? "The answer stopped early." : FAILED } : t));
    } finally {
      if (ctrl.current === c) ctrl.current = null;
    }
  };

  const stop = () => ctrl.current?.abort();
  const clear = () => {
    ctrl.current?.abort();
    setTurns(() => []);
    input.current?.focus({ preventScroll: true });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void ask(q);
    }
  };
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 148)}px`;
  };

  const thread = turns.length === 0 ? (
    <div className="pa-empty mt-empty">
      <span className="pa-empty__glyph" aria-hidden><Icon name={mode === "one" ? "mic" : "sparkle"} /></span>
      <p className="pa-empty__title">{emptyTitle}</p>
      <p className="pa-empty__sub">{emptySub}</p>
      <div className="pa-suggest" role="group" aria-label="Suggested questions">
        {suggestions.map((s, i) => (
          <button key={s.q} type="button" className="pa-suggest__item" style={{ animationDelay: `${40 + i * 40}ms` }} onClick={() => void ask(s.q)}>
            <Icon name={s.icon} className="pa-suggest__icon" />
            <span>{s.q}</span>
            <Icon name="arrowRight" className="pa-suggest__go" />
          </button>
        ))}
      </div>
    </div>
  ) : (
    <ol className="pa-thread" aria-live="polite" aria-busy={streaming || undefined}>
      {turns.map((t) => (
        <TurnView key={t.id} turn={t} mode={mode} onNavigate={onNavigate}
          onRetry={(turn) => { setTurns((ts) => ts.filter((x) => x.id !== turn.id)); window.setTimeout(() => void ask(turn.q), 0); }}
          onCopy={(a) => void copyText(a).then((ok) => (ok ? toast.success("Answer copied") : toast.error("Couldn't copy")))} />
      ))}
    </ol>
  );

  const composer = (
    <form className="pa-ask__composer" onSubmit={(e) => { e.preventDefault(); void ask(q); }}>
      <div className="pa-field">
        <textarea
          ref={input}
          className="pa-field__input"
          rows={1}
          value={q}
          maxLength={600}
          placeholder={turns.length && mode === "one" ? "Ask a follow-up…" : placeholder}
          aria-label="Your question"
          enterKeyHint="send"
          onChange={(e) => { setQ(e.target.value); grow(e.target); }}
          onKeyDown={onKey}
        />
        {streaming ? (
          <button type="button" className="pa-field__btn pa-field__btn--stop" onClick={stop} aria-label="Stop answering" title="Stop">
            <Icon name="square" />
          </button>
        ) : (
          <button type="submit" className="pa-field__btn" disabled={!q.trim()} aria-label="Ask" title="Ask (Enter)">
            <Icon name="arrowUp" />
          </button>
        )}
      </div>
      <p className="pa-ask__foot">
        {mode === "one" ? "Answers use only this meeting, in English. AI can be wrong." : "Answers use only meetings you can open, in English. AI can be wrong."}
        {turns.length > 0 && <> · <button type="button" className="mt-linkbtn" onClick={clear}>Clear</button></>}
      </p>
    </form>
  );

  if (layout === "inline") {
    return (
      <div className="mt-chat mt-chat--inline">
        {composer}
        {banner}
        {turns.length > 0 && <div ref={body} className="mt-chat__thread ph-no-capture">{thread}</div>}
        {turns.length === 0 && (
          <div className="pa-suggest mt-chat__chips" role="group" aria-label="Suggested questions">
            {suggestions.map((s) => (
              <button key={s.q} type="button" className="mt-chip" onClick={() => void ask(s.q)}>
                <Icon name={s.icon} className="mt-chip__icon" />
                <span>{s.q}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <>
      <div ref={body} className="pa-ask__body ph-no-capture" onScroll={() => {
        const el = body.current;
        if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}>
        {banner}
        {thread}
      </div>
      {composer}
    </>
  );
}

const TurnView = memo(function TurnView({ turn, mode, onRetry, onCopy, onNavigate }: {
  turn: Turn;
  mode: "one" | "all";
  onRetry: (t: Turn) => void;
  onCopy: (answer: string) => void;
  onNavigate?: () => void;
}) {
  const live = turn.state === "streaming";
  return (
    <li className="pa-turn">
      <p className="pa-q ph-mask">{turn.q}</p>
      <div className="pa-a">
        {live && !turn.a && (
          <p className="pa-thinking" role="status">
            <span className="pa-dots" aria-hidden><i /><i /><i /></span>
            {mode === "all" ? (turn.stage === "answering" ? "Reading the meetings…" : "Finding the meetings…") : "Reading the meeting…"}
          </p>
        )}
        {turn.a && <CitedAnswer md={turn.a} citations={turn.citations} streaming={live} onNavigate={onNavigate} />}
        {turn.state === "stopped" && <p className="pa-a__meta">{turn.note ?? "Stopped."}</p>}
        {(turn.state === "limit" || turn.state === "error") && (
          <div className={`pa-notice${turn.state === "limit" ? " pa-notice--limit" : ""}`} role="alert">
            <Icon name={turn.state === "limit" ? "clock" : "alertCircle"} className="pa-notice__icon" />
            <span>{turn.note}</span>
            {turn.state === "error" && <button type="button" className="pa-notice__retry" onClick={() => onRetry(turn)}>Try again</button>}
          </div>
        )}
        {mode === "all" && turn.state === "done" && (turn.ranked?.length ?? 0) > 0 && (
          <div className="pa-sources">
            <span className="pa-sources__label">Meetings</span>
            {turn.ranked!.map((r) => (
              <a key={r.id} className="pa-chip" href={`/${r.slug}`} onClick={onNavigate}>
                <Icon name="mic" className="pa-chip__icon" />
                <span>{r.title || "Meeting"}{r.date ? ` · ${fmtMeetingDate(r.date)}` : ""}</span>
              </a>
            ))}
          </div>
        )}
        {turn.state === "done" && (
          <div className="pa-a__tools">
            <button type="button" className="pa-tool" onClick={() => onCopy(plain(turn.a, turn.citations))} aria-label="Copy answer" title="Copy answer">
              <Icon name="copy" />
            </button>
          </div>
        )}
      </div>
    </li>
  );
});

const CITE = /\[((?:M\d{1,2}(?:-[sn]\d{1,5})?)|(?:[sn]\d{1,5}))\]/g;

/** The answer with its citations as Markdown links to "#cite-<label>", drawn as chips. */
function linkCitations(md: string): string {
  return md.replace(CITE, (_m, label: string) => `[${label}](#cite-${label})`);
}

function plain(md: string, cites?: MeetingCitation[]): string {
  const by = new Map((cites ?? []).map((c) => [c.label, c.text]));
  return md.replace(CITE, (_m, label: string) => (by.has(label) ? `[${by.get(label)}]` : ""));
}

export const CitedAnswer = memo(function CitedAnswer({ md, citations, streaming, onNavigate }: {
  md: string;
  citations?: MeetingCitation[];
  streaming: boolean;
  onNavigate?: () => void;
}) {
  const by = useMemo(() => new Map((citations ?? []).map((c) => [c.label, c])), [citations]);
  const components = useMemo<Components>(() => ({
    a: ({ href, children }) => {
      if (href && href.startsWith("#cite-")) {
        const c = by.get(href.slice(6));
        if (!c) return streaming ? <span className="mt-cite mt-cite--pending" aria-hidden>·</span> : null;
        return (
          <a href={c.href} className="mt-cite" data-kind={c.kind} title={c.kind === "segment" ? `Open the transcript at ${c.text}` : `Open ${c.text}`}
            onClick={onNavigate}>
            <Icon name={c.kind === "segment" ? "clock" : "doc"} className="mt-cite__icon" />
            <span>{c.text}</span>
          </a>
        );
      }
      if (href && /^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>;
      if (href && href.startsWith("/") && !href.startsWith("//")) return <a href={href}>{children}</a>;
      return <>{children}</>;
    },
    img: () => null,
    h1: ({ children }) => <p className="pa-md__h">{children}</p>,
    h2: ({ children }) => <p className="pa-md__h">{children}</p>,
    h3: ({ children }) => <p className="pa-md__h">{children}</p>,
  }), [by, streaming, onNavigate]);
  return (
    <div className="pa-md ph-no-capture" data-streaming={streaming ? "" : undefined}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>{linkCitations(md)}</Markdown>
    </div>
  );
});

export default MeetingChat;
