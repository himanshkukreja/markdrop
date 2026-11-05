"use client";

/**
 * Ask this page (SPEC.md feature 6): a side panel on desktop (380 px, non-modal, so the page
 * stays scrollable beside it) and a bottom sheet on phones. Loaded by AskLauncher on first use.
 *
 *  - Questions stream their answers in as Markdown (GFM, no raw HTML, no images).
 *  - Section links `[text](#heading-id)` scroll to the heading and flash it (revealSection); on a
 *    phone the sheet gets out of the way first. The sections an answer used are listed under it.
 *  - Multi-turn: the last 6 complete turns go with each question. The conversation lasts as long
 *    as the page is open (closing the panel keeps it; Clear starts again).
 *  - Stop, Clear, starter questions, and a calm message per refusal (lib/pages-ai/ask-core).
 *  - "+ Meetings" (a page in a workspace, on by default): the question goes to Ask Markdrop with
 *    the page (POST /api/v1/ask {page, intent: "page"}): this page, then the decisions, action items
 *    and moments recorded in the workspace's meetings, then its documents, with numbered citations
 *    that open the meeting (or the transcript moment). Questions about when / why something was
 *    decided always ask the meetings (.work/meeting-memory/SPEC.md).
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon, IconButton, copyText, useToast } from "@/components/ui";
import { PHONE_QUERY, useMediaQuery } from "@/components/kit/publish-utils";
import { PageAiError, streamAsk } from "@/lib/pages-ai/ask";
import { askMarkdrop, type AskCitation } from "@/lib/ask";
import { citedMarkdown, isMemoryQuestion, type CitedSource } from "../memory/memoryCore.mjs";
import { historyFor, limitMessage, sectionId, sectionsUsed, type AskTurn } from "@/lib/pages-ai/ask-core";
import { revealSection } from "./revealSection";
import "./ask.css";

export interface AskPanelProps {
  open: boolean;
  onClose: () => void;
  slug: string;
  title: string | null;
  /** The page is in a workspace: "+ Meetings" is offered (and on). */
  workspace?: boolean;
}

interface Turn extends AskTurn {
  /** Asked with the workspace's meetings (Ask Markdrop, intent "page"). */
  meetings?: boolean;
  citations?: AskCitation[];
  threadId?: string | null;
  stage?: string | null;
  id: number;
  /** What to tell the reader instead of (or after) an answer. */
  note?: string;
  /** The page was long: the answer used the parts nearest the question. */
  trimmed?: boolean;
}

const SUGGESTIONS = [
  { q: "Summarize this page", icon: "lines" },
  { q: "What are the key decisions?", icon: "checkCircle" },
  { q: "What's still open?", icon: "flag" },
];
const FAILED = "Something went wrong while answering. Try again.";
const CUT = "The answer stopped early. Ask again to get the rest.";

// The conversation per page, for as long as the tab is on it (the panel can close and reopen).
const memory = new Map<string, Turn[]>();
let seq = 0;
const SIDE_EVENT = "md:sidepanel";
const MEETINGS_PREF = "md_ask_meetings";
const MEETING_SUGGESTION = { q: "What did we decide about this in meetings?", icon: "mic" };
const STAGE_TEXT: Record<string, string> = { understanding: "Reading the question…", searching: "Searching this page and your meetings…", answering: "Writing the answer…" };

function readMeetingsPref(): boolean {
  try {
    return localStorage.getItem(MEETINGS_PREF) !== "0";
  } catch {
    return true;
  }
}

export function AskPanel({ open, onClose, slug, title, workspace = false }: AskPanelProps) {
  const phone = useMediaQuery(PHONE_QUERY);
  const toast = useToast();
  const [turns, setTurnsState] = useState<Turn[]>(() => memory.get(slug) ?? []);
  const setTurns = useCallback(
    (fn: (t: Turn[]) => Turn[]) =>
      setTurnsState((prev) => {
        const next = fn(prev);
        memory.set(slug, next);
        return next;
      }),
    [slug],
  );
  const [q, setQ] = useState("");
  const [withMeetings, setWithMeetings] = useState(readMeetingsPref);
  const toggleMeetings = () => setWithMeetings((v) => {
    try {
      localStorage.setItem(MEETINGS_PREF, v ? "0" : "1");
    } catch { /* this visit only */ }
    return !v;
  });
  const ctrl = useRef<AbortController | null>(null);
  const panel = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const streaming = turns.some((t) => t.state === "streaming");

  // A new page: its own conversation.
  useEffect(() => {
    ctrl.current?.abort();
    setTurnsState(memory.get(slug) ?? []);
  }, [slug]);
  useEffect(() => () => ctrl.current?.abort(), []);

  // One side panel at a time (From meetings closes when this opens, and the other way round).
  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent(SIDE_EVENT, { detail: "ask" }));
    const other = (e: Event) => {
      if ((e as CustomEvent).detail !== "ask") onClose();
    };
    window.addEventListener(SIDE_EVENT, other);
    return () => window.removeEventListener(SIDE_EVENT, other);
  }, [open, onClose]);

  // Opening focuses the question (not on a phone, where the keyboard would cover the starters).
  useEffect(() => {
    if (!open) return;
    stick.current = true;
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
    if (!phone) window.setTimeout(() => input.current?.focus({ preventScroll: true }), 60);
  }, [open, phone]);

  // A phone's keyboard: the sheet rides above it.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!phone || !open || !vv) return;
    const fit = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      panel.current?.style.setProperty("--pa-kb", `${Math.round(kb)}px`);
    };
    fit();
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    return () => {
      vv.removeEventListener("resize", fit);
      vv.removeEventListener("scroll", fit);
    };
  }, [phone, open]);

  // Follow the answer as it streams, unless the reader scrolled up to read.
  useLayoutEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns]);
  const onScroll = () => {
    const el = body.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const askMeetings = async (text: string) => {
    const id = ++seq;
    const threadId = [...turns].reverse().find((t) => t.meetings && t.state === "done")?.threadId ?? null;
    setTurns((t) => [...t, { id, q: text, a: "", state: "streaming", meetings: true }]);
    setQ("");
    if (input.current) input.current.style.height = "";
    stick.current = true;
    const c = new AbortController();
    ctrl.current = c;
    const patch = (fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));
    let ended = false;
    await askMarkdrop({ question: text, thread_id: threadId, intent: "page", page: slug }, (e) => {
      if (e.type === "status") patch((t) => ({ ...t, stage: e.stage }));
      else if (e.type === "delta") patch((t) => ({ ...t, a: t.a + e.text, stage: "answering" }));
      else if (e.type === "done") {
        ended = true;
        patch((t) => {
          const a = e.answer?.trim() ? e.answer : t.a;
          return { ...t, a, citations: e.citations ?? [], threadId: e.thread_id, state: a.trim() ? "done" : "error", note: a.trim() ? (e.truncated ? CUT : undefined) : FAILED };
        });
      } else if (e.type === "limit") {
        ended = true;
        patch((t) => ({ ...t, state: "limit", note: limitMessage(e.reason, e.message) }));
      } else if (e.type === "error") {
        ended = true;
        patch((t) => ({ ...t, state: "error", note: e.detail || FAILED }));
      }
    }, c.signal);
    if (!ended) patch((t) => (t.state === "streaming" ? { ...t, state: c.signal.aborted || t.a ? "stopped" : "error", note: c.signal.aborted ? undefined : t.a ? CUT : FAILED } : t));
    if (ctrl.current === c) ctrl.current = null;
  };

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || streaming) return;
    if (workspace && (withMeetings || isMemoryQuestion(text))) return askMeetings(text);
    const history = historyFor(turns);
    const id = ++seq;
    setTurns((t) => [...t, { id, q: text, a: "", state: "streaming" }]);
    setQ("");
    if (input.current) input.current.style.height = "";
    stick.current = true;
    const c = new AbortController();
    ctrl.current = c;
    const patch = (fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));
    let ended = false;
    try {
      await streamAsk(slug, { question: text, history }, c.signal, (e) => {
        if (e.type === "delta") patch((t) => ({ ...t, a: e.reset ? e.text : t.a + e.text }));
        else if (e.type === "done") {
          ended = true;
          patch((t) => {
            const a = typeof e.markdown === "string" && e.markdown.trim() ? e.markdown : t.a;
            return { ...t, a, state: a.trim() ? "done" : "error", note: a.trim() ? undefined : FAILED, trimmed: e.trimmed === true };
          });
        } else if (e.type === "limit") {
          ended = true;
          patch((t) => ({ ...t, state: "limit", note: limitMessage(e.reason, e.detail) }));
        } else if (e.type === "error") {
          ended = true;
          patch((t) => ({ ...t, state: "error", note: e.detail || FAILED }));
        }
      });
      // Stop cancels the read, which then just ends: that's a stop, not a cut-off.
      if (!ended && c.signal.aborted) patch((t) => (t.state === "streaming" ? { ...t, state: "stopped" } : t));
      else if (!ended) patch((t) => (t.state === "streaming" ? { ...t, state: t.a ? "stopped" : "error", note: t.a ? CUT : FAILED } : t));
    } catch (e) {
      if (c.signal.aborted) patch((t) => (t.state === "streaming" ? { ...t, state: "stopped" } : t));
      else {
        const refused = e instanceof PageAiError;
        patch((t) => ({ ...t, state: refused && e.reason ? "limit" : "error", note: refused ? e.message : FAILED }));
      }
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
  const retry = (turn: Turn) => {
    setTurns((ts) => ts.filter((t) => t.id !== turn.id));
    // After the removal lands, so the history doesn't carry it.
    window.setTimeout(() => void ask(turn.q), 0);
  };

  const goTo = useCallback(
    (id: string) => {
      const go = () => {
        if (!revealSection(id)) toast.info("That section isn't on the page any more.");
      };
      if (phone) {
        onClose();
        window.setTimeout(go, 200);
      } else go();
    },
    [phone, onClose, toast],
  );

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

  const name = title?.trim() || "this page";
  return createPortal(
    <div className="pa-ask" data-open={open ? "" : undefined} data-phone={phone ? "" : undefined} inert={!open}>
      {phone && <div className="pa-ask__scrim" onClick={onClose} aria-hidden />}
      <section
        ref={panel}
        className="pa-ask__panel"
        role="dialog"
        aria-modal={phone || undefined}
        aria-labelledby="pa-ask-title"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.defaultPrevented) {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        {phone && <div className="pa-ask__handle" aria-hidden />}
        <header className="pa-ask__head">
          <span className="pa-ask__glyph" aria-hidden>
            <Icon name="sparkle" />
          </span>
          <div className="pa-ask__titles">
            <h2 id="pa-ask-title">Ask this page</h2>
            <p className="ph-mask" title={name}>{name}</p>
          </div>
          {turns.length > 0 && (
            <button type="button" className="pa-ask__clear" onClick={clear}>
              Clear
            </button>
          )}
          <IconButton icon="x" label="Close" size="sm" onClick={onClose} />
        </header>

        <div ref={body} className="pa-ask__body ph-no-capture" onScroll={onScroll}>
          {turns.length === 0 ? (
            <div className="pa-empty">
              <span className="pa-empty__glyph" aria-hidden>
                <Icon name="sparkle" />
              </span>
              <p className="pa-empty__title">What would you like to know?</p>
              <p className="pa-empty__sub">
                {workspace && withMeetings
                  ? "Answers come from this page and your team's meetings and documents that you can open, with links to the meeting and the moment."
                  : "Answers come from this page and the pages it embeds that you can open, with links to the sections they use."}
              </p>
              <div className="pa-suggest" role="group" aria-label="Suggested questions">
                {(workspace ? [...SUGGESTIONS.slice(0, 2), MEETING_SUGGESTION] : SUGGESTIONS).map((s, i) => (
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
                <TurnView key={t.id} turn={t} onSection={goTo} onRetry={retry} onCopy={(a) => void copyText(a).then((ok) => (ok ? toast.success("Answer copied") : toast.error("Couldn't copy")))} />
              ))}
            </ol>
          )}
        </div>

        <form
          className="pa-ask__composer"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(q);
          }}
        >
          <div className="pa-field">
            <textarea
              ref={input}
              className="pa-field__input"
              rows={1}
              value={q}
              maxLength={2000}
              placeholder={turns.length ? "Ask a follow-up…" : "Ask a question about this page…"}
              aria-label="Your question"
              enterKeyHint="send"
              onChange={(e) => {
                setQ(e.target.value);
                grow(e.target);
              }}
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
          <div className="pa-ask__foot">
            {workspace && (
              <button type="button" className="pa-meet" role="switch" aria-checked={withMeetings} onClick={toggleMeetings}
                title={withMeetings ? "Answers also use your team's meetings. Click to ask this page only." : "Ask this page only. Click to also use your team's meetings."}>
                <Icon name={withMeetings ? "check" : "plus"} className="pa-meet__icon" />
                <span>Meetings</span>
              </button>
            )}
            <span>{workspace && withMeetings ? "Answers use this page and meetings and documents you can open." : "Answers use only this page and pages you can open."} AI can be wrong.</span>
          </div>
        </form>
      </section>
    </div>,
    document.body,
  );
}

const TurnView = memo(function TurnView({ turn, onSection, onRetry, onCopy }: {
  turn: Turn;
  onSection: (id: string) => void;
  onRetry: (t: Turn) => void;
  onCopy: (answer: string) => void;
}) {
  const live = turn.state === "streaming";
  const sections = useMemo(() => (!turn.meetings && (turn.state === "done" || turn.state === "stopped") ? sectionsUsed(turn.a) : []), [turn.a, turn.state, turn.meetings]);
  const cited = useMemo(() => (turn.meetings && turn.state === "done" ? citedMarkdown(turn.a, turn.citations ?? [], window.location.origin) : null), [turn.a, turn.state, turn.meetings, turn.citations]);
  return (
    <li className="pa-turn">
      <p className="pa-q ph-mask">{turn.q}</p>
      {turn.meetings && <p className="pa-q__via"><Icon name="mic" /> With meetings</p>}
      <div className="pa-a">
        {live && !turn.a && (
          <p className="pa-thinking" role="status">
            <span className="pa-dots" aria-hidden><i /><i /><i /></span>
            {turn.meetings ? STAGE_TEXT[turn.stage ?? ""] ?? "Reading the page…" : "Reading the page…"}
          </p>
        )}
        {turn.a && <Answer md={cited ? cited.markdown : turn.meetings ? turn.a.replace(/\[(\d{1,2})(?:-s\d{1,5})?\]/g, "") : turn.a} streaming={live} onSection={onSection} />}
        {turn.state === "stopped" && <p className="pa-a__meta">{turn.note ?? "Stopped."}</p>}
        {turn.trimmed && <p className="pa-a__meta">This page is long, so the answer used the parts most related to your question.</p>}
        {(turn.state === "limit" || turn.state === "error") && (
          <div className={`pa-notice${turn.state === "limit" ? " pa-notice--limit" : ""}`} role="alert">
            <Icon name={turn.state === "limit" ? "clock" : "alertCircle"} className="pa-notice__icon" />
            <span>{turn.note}</span>
            {turn.state === "error" && (
              <button type="button" className="pa-notice__retry" onClick={() => onRetry(turn)}>
                Try again
              </button>
            )}
          </div>
        )}
        {sections.length > 0 && (
          <div className="pa-sources">
            <span className="pa-sources__label">Sections</span>
            {sections.map((s) => (
              <button key={s.id} type="button" className="pa-chip" onClick={() => onSection(s.id)}>
                <Icon name="hash" className="pa-chip__icon" />
                <span>{s.text}</span>
              </button>
            ))}
          </div>
        )}
        {cited && cited.sources.length > 0 && <MeetingSources sources={cited.sources} />}
        {turn.state === "done" && (
          <div className="pa-a__tools">
            <button type="button" className="pa-tool" onClick={() => onCopy(turn.a)} aria-label="Copy answer" title="Copy answer">
              <Icon name="copy" />
            </button>
          </div>
        )}
      </div>
    </li>
  );
});

function MeetingSources({ sources }: { sources: CitedSource[] }) {
  return (
    <ol className="pa-cites" aria-label="Sources">
      {sources.map((s) => (
        <li key={s.n} className="pa-cites__item">
          <span className="pa-cites__n">{s.shown}</span>
          {s.href ? <a href={s.href} className="pa-cites__title">{s.title || "Untitled"}</a> : <span className="pa-cites__title">{s.title || "Untitled"}</span>}
          {s.kind === "this page" && <span className="pa-cites__kind">This page</span>}
          {s.moments.map((m, i) => (m.url ? (
            <a key={m.label} href={m.url.startsWith(window.location.origin) ? m.url.slice(window.location.origin.length) : m.url} className="pa-cites__moment" title="Jump to this moment">
              <Icon name="play" /> {m.moment || `${s.shown}·${i + 1}`}
            </a>
          ) : null))}
        </li>
      ))}
    </ol>
  );
}

const Answer = memo(function Answer({ md, streaming, onSection }: { md: string; streaming: boolean; onSection: (id: string) => void }) {
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        const here = { origin: window.location.origin, pathname: window.location.pathname };
        const id = sectionId(href, here);
        if (id)
          return (
            <a
              href={`#${id}`}
              className="pa-sec"
              onClick={(e) => {
                e.preventDefault();
                onSection(id);
              }}
            >
              {children}
            </a>
          );
        const label = typeof children === "string" ? children : Array.isArray(children) && children.length === 1 && typeof children[0] === "string" ? children[0] : "";
        if (href && /^\[\d+(·\d+)?\]$/.test(label)) return <a href={href} className="pa-cite" target={/^https?:/i.test(href) ? "_blank" : undefined} rel={/^https?:/i.test(href) ? "noopener noreferrer nofollow" : undefined}>{label.slice(1, -1)}</a>;
        if (href && /^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>;
        if (href && href.startsWith("/") && !href.startsWith("//")) return <a href={href}>{children}</a>;
        return <>{children}</>;
      },
      img: () => null,
      h1: ({ children }) => <p className="pa-md__h">{children}</p>,
      h2: ({ children }) => <p className="pa-md__h">{children}</p>,
      h3: ({ children }) => <p className="pa-md__h">{children}</p>,
      h4: ({ children }) => <p className="pa-md__h">{children}</p>,
      table: ({ children }) => (
        <div className="pa-md__table">
          <table>{children}</table>
        </div>
      ),
    }),
    [onSection],
  );
  return (
    <div className="pa-md ph-no-capture" data-streaming={streaming ? "" : undefined}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {md}
      </Markdown>
    </div>
  );
});

export default AskPanel;
