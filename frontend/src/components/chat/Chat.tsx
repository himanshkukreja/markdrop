"use client";

/**
 * The shared chat: a conversation with streamed, cited answers. Used by Ask across meetings and Ask this
 * meeting (components/meetings); built to be the one assistant everywhere (types.ts says how to plug in).
 *
 *  - Thread: your question on the right, the answer on the left with the ✦ avatar; a typing state with what
 *    it is doing ("Finding the meetings…") and what it reads; text revealed smoothly as it streams.
 *  - Citations: numbered chips [1] in the answer; a chip (or "N sources") opens the sources list (a rail beside
 *    a page-wide chat, a drawer in a panel, a bottom sheet on phones): title, date, speaker and time, the
 *    quote, and a link to the moment.
 *  - Under an answer: sources, copy, insert (when the host can), try again; follow-up questions.
 *  - Composer: sticky, grows with the text; Enter sends, Shift+Enter is a new line, ↑ in an empty box
 *    edits the last question, Esc stops an answer (or closes the sources); scope chips; a stop button.
 *  - Screen readers: the thread is a log; a finished answer is announced once (not every streamed word).
 */
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Dropdown, Icon, Spinner, copyText, cx, useToast } from "@/components/ui";
import { DEFAULT_CITE, autoGrowHeight, linkCitations, numberCitations, plainAnswer, revealStep } from "./chatCore.mjs";
import { useChat } from "./useChat";
import type { ChatCitation, ChatHandle, ChatProps, ChatScope, ChatScopeOption, ChatTurn } from "./types";
import "./chat.css";

export type * from "./types";

export const Chat = forwardRef<ChatHandle, ChatProps<unknown>>(function Chat(props, ref) {
  const {
    transport, persistKey, layout = "panel", scope = EMPTY_SCOPE, scopeOptions, onScopeChange, context, threadId: threadProp,
    onThreadChange, loadThread, suggestions = [], followUps, onInsert, onNavigate, empty, placeholder = "Ask anything…",
    followUpPlaceholder = "Ask a follow-up…", footnote, banner, citePattern = DEFAULT_CITE, autoFocus, maxLength = 600,
    assistantName = "Markdrop AI", className, testId,
  } = props;
  const toast = useToast();
  const chat = useChat({ transport, persistKey, scope, context, threadId: threadProp, onThreadChange, loadThread });
  const { turns, streaming } = chat;
  const [q, setQ] = useState("");
  const [sources, setSources] = useState<{ turn: string; token: string | null } | null>(null);
  const [announce, setAnnounce] = useState("");
  const [away, setAway] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  const grow = useCallback(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${autoGrowHeight(el.scrollHeight)}px`;
  }, []);
  const focus = useCallback(() => input.current?.focus({ preventScroll: true }), []);
  const send = useCallback((text: string) => {
    if (!text.trim() || streaming) return;
    chat.ask(text);
    setQ("");
    stick.current = true;
    setAway(false);
    window.requestAnimationFrame(grow);
  }, [chat, streaming, grow]);
  const newChat = useCallback(() => {
    chat.reset();
    setSources(null);
    setQ("");
    window.setTimeout(focus, 0);
  }, [chat, focus]);

  useImperativeHandle(ref, () => ({ ask: send, newChat, focus, hasTurns: () => turns.length > 0 }), [send, newChat, focus, turns.length]);

  useEffect(() => {
    if (autoFocus) window.setTimeout(focus, 60);
  }, [autoFocus, focus]);

  // Follow the answer as it grows, unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns]);
  const onScroll = () => {
    const el = body.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    stick.current = near;
    setAway(!near && el.scrollHeight > el.clientHeight + 64);
  };
  const toBottom = () => {
    const el = body.current;
    if (!el) return;
    stick.current = true;
    setAway(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // A finished answer is announced once.
  const lastState = useRef<string | null>(null);
  useEffect(() => {
    const last = turns[turns.length - 1];
    const sig = last ? `${last.id}:${last.state}` : null;
    if (sig === lastState.current) return;
    lastState.current = sig;
    if (!last || last.state === "streaming") return;
    if (last.state === "done") setAnnounce(`Answer: ${plainAnswer(last.answer, [], citePattern).replace(/\s*\[\d+\]/g, "").slice(0, 600)}`);
    else if (last.note) setAnnounce(last.note);
  }, [turns, citePattern]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(q);
    } else if (e.key === "ArrowUp" && !q && turns.length && !streaming) {
      e.preventDefault();
      setQ(turns[turns.length - 1].question);
      window.requestAnimationFrame(() => {
        grow();
        const el = input.current;
        if (el) el.setSelectionRange(el.value.length, el.value.length);
      });
    }
  };
  const onRootKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (sources) {
      e.preventDefault();
      e.stopPropagation();
      setSources(null);
      focus();
    } else if (streaming) {
      e.preventDefault();
      e.stopPropagation();
      chat.stop();
    }
  };

  const openSources = useCallback((turn: string, token: string | null) => setSources({ turn, token }), []);
  const copy = useCallback((t: ChatTurn) => {
    void copyText(plainAnswer(t.answer, t.citations, citePattern)).then((ok) => (ok ? toast.success("Answer copied") : toast.error("Couldn't copy")));
  }, [citePattern, toast]);
  const insert = useMemo(() => (onInsert ? (t: ChatTurn) => onInsert(insertable(t, citePattern), t) : undefined), [onInsert, citePattern]);

  const lastDone = [...turns].reverse().find((t) => t.state !== "streaming");
  const offered = !streaming && lastDone && lastDone === turns[turns.length - 1] && lastDone.state === "done" && followUps
    ? followUps(lastDone).slice(0, 3) : [];
  const openTurn = sources ? turns.find((t) => t.id === sources.turn) : undefined;

  return (
    <div className={cx("ch", className)} data-layout={layout} data-sources={openTurn ? "" : undefined} onKeyDown={onRootKey} data-testid={testId}>
      <div className="ch__main">
        <div ref={body} className="ch__body ph-no-capture" onScroll={onScroll}>
          <div className="ch__col">
            {banner}
            {chat.restoring && turns.length === 0 ? (
              <div className="ch-restoring" role="status"><Spinner size={14} /> Opening the conversation…</div>
            ) : turns.length === 0 ? (
              <EmptyState empty={empty} suggestions={suggestions} onPick={send} layout={layout} />
            ) : (
              <ol className="ch-thread" role="log" aria-label="Conversation" aria-busy={streaming || undefined}>
                {turns.map((t) => (
                  <TurnView key={t.id} turn={t} pattern={citePattern} assistantName={assistantName}
                    activeToken={sources?.turn === t.id ? sources.token : null}
                    onCite={openSources} onCopy={copy} onInsert={insert} onRetry={chat.retry} onNavigate={onNavigate} />
                ))}
              </ol>
            )}
            {offered.length > 0 && (
              <div className="ch-follow" role="group" aria-label="Follow-up questions" data-testid="chat-followups">
                {offered.map((f) => (
                  <button key={f} type="button" className="ch-follow__item" onClick={() => send(f)}>
                    <Icon name="arrowRight" className="ch-follow__icon" />
                    <span>{f}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {away && (
          <button type="button" className="ch-jump" onClick={toBottom} aria-label="Scroll to the latest">
            <Icon name="arrowDown" />
          </button>
        )}
        <form className="ch-composer" onSubmit={(e) => { e.preventDefault(); send(q); }}>
          <div className="ch__col">
            <div className="ch-field" data-streaming={streaming ? "" : undefined}>
              {scopeOptions && scopeOptions.length > 0 && (
                <ScopeChips options={scopeOptions} scope={scope} onChange={onScopeChange} disabled={streaming} />
              )}
              <div className="ch-field__row">
                <textarea
                  ref={input}
                  className="ch-field__input"
                  rows={1}
                  value={q}
                  maxLength={maxLength}
                  placeholder={turns.length ? followUpPlaceholder : placeholder}
                  aria-label="Your question"
                  enterKeyHint="send"
                  onChange={(e) => { setQ(e.target.value); grow(); }}
                  onKeyDown={onKey}
                />
                {streaming ? (
                  <button type="button" className="ch-send ch-send--stop" onClick={chat.stop} aria-label="Stop answering" title="Stop (Esc)" data-testid="chat-stop">
                    <Icon name="square" />
                  </button>
                ) : (
                  <button type="submit" className="ch-send" disabled={!q.trim()} aria-label="Send" title="Send (Enter)" data-testid="chat-send">
                    <Icon name="arrowUp" />
                  </button>
                )}
              </div>
            </div>
            <div className="ch-foot">
              <span className="ch-foot__text">{footnote}</span>
              {turns.length > 0 && (
                <button type="button" className="ch-foot__new" onClick={newChat} data-testid="chat-new">
                  <Icon name="plus" /> New chat
                </button>
              )}
            </div>
          </div>
        </form>
        <p className="ch-sr" aria-live="polite" role="status">{announce}</p>
      </div>
      {openTurn && (
        <SourcesPanel turn={openTurn} token={sources?.token ?? null} pattern={citePattern} layout={layout}
          onClose={() => { setSources(null); focus(); }} onNavigate={onNavigate} />
      )}
    </div>
  );
});

const EMPTY_SCOPE: ChatScope = {};

function insertable(t: ChatTurn, pattern: RegExp): string {
  const nums = numberCitations(t.answer, t.citations.map((c) => c.token), pattern);
  const by = new Map(t.citations.map((c) => [c.token, c]));
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  return t.answer.replace(re, (_w, tok: string) => {
    const c = by.get(tok);
    return c ? `[[${nums.get(tok)}]](${c.href})` : "";
  }).trim();
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ empty, suggestions, onPick, layout }: {
  empty: ChatProps["empty"]; suggestions: NonNullable<ChatProps["suggestions"]>; onPick: (q: string) => void; layout: string;
}) {
  return (
    <div className="ch-empty" data-layout={layout}>
      <span className="ch-empty__glyph" aria-hidden><Icon name={empty?.icon ?? "sparkle"} /></span>
      {empty?.title && <h3 className="ch-empty__title">{empty.title}</h3>}
      {empty?.sub && <p className="ch-empty__sub">{empty.sub}</p>}
      {suggestions.length > 0 && (
        <div className="ch-starters" role="group" aria-label="Suggested questions" data-testid="chat-starters">
          {suggestions.map((s, i) => (
            <button key={s.q} type="button" className="ch-starter" style={{ animationDelay: `${40 + i * 40}ms` }} onClick={() => onPick(s.q)}>
              <Icon name={s.icon ?? "message"} className="ch-starter__icon" />
              {s.label ? <span className="ch-starter__text"><span className="ch-starter__label">{s.label}</span><span>{s.q}</span></span> : <span>{s.q}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Scope chips ───────────────────────────────────────────────────────────────

function ScopeChips({ options, scope, onChange, disabled }: {
  options: ChatScopeOption[]; scope: ChatScope; onChange?: (s: ChatScope) => void; disabled: boolean;
}) {
  return (
    <div className="ch-scopes" role="group" aria-label="What to ask">
      {options.map((o) => {
        const v = scope[o.id] ?? "";
        const cur = o.choices.find((c) => c.value === v);
        return (
          <Dropdown key={o.id} align="left" placement="top" portal minWidth={200} aria-label={o.label}
            trigger={(
              <button type="button" className="ch-scope" data-set={v ? "" : undefined} disabled={disabled} data-testid={`chat-scope-${o.id}`}>
                <Icon name={cur?.icon ?? o.icon ?? "filter"} className="ch-scope__icon" />
                <span>{cur?.label ?? o.label}</span>
                <Icon name="chevronDown" className="ch-scope__caret" />
              </button>
            )}
            items={o.choices.map((c) => ({
              label: c.label,
              icon: c.value === v ? "check" : c.icon ?? "",
              onClick: () => onChange?.({ ...scope, [o.id]: c.value }),
            }))}
          />
        );
      })}
    </div>
  );
}

// ── A turn ────────────────────────────────────────────────────────────────────

const TurnView = memo(function TurnView({ turn, pattern, assistantName, activeToken, onCite, onCopy, onInsert, onRetry, onNavigate }: {
  turn: ChatTurn;
  pattern: RegExp;
  assistantName: string;
  activeToken: string | null;
  onCite: (turn: string, token: string | null) => void;
  onCopy: (t: ChatTurn) => void;
  onInsert?: (t: ChatTurn) => void;
  onRetry: (t: ChatTurn) => void;
  onNavigate?: () => void;
}) {
  const live = turn.state === "streaming";
  const shown = useReveal(turn.answer, live);
  const typing = live && !shown;
  const n = turn.citations.length;
  return (
    <li className="ch-turn" data-state={turn.state}>
      <div className="ch-q"><p className="ch-q__bubble ph-mask">{turn.question}</p></div>
      <div className="ch-a">
        <span className="ch-avatar" aria-hidden title={assistantName}><Icon name="sparkle" /></span>
        <div className="ch-a__body">
          <span className="ch-sr">{assistantName}:</span>
          {turn.scopeNote && <p className="ch-scopenote" data-testid="chat-scopenote"><Icon name="filter" />{turn.scopeNote}</p>}
          {typing && (
            <div className="ch-typing" role="status" data-testid="chat-typing">
              <span className="ch-dots" aria-hidden><i /><i /><i /></span>
              <span>{turn.stage || "Thinking…"}</span>
            </div>
          )}
          {live && turn.sources.length > 0 && !shown && (
            <ul className="ch-reading" aria-label="Reading">
              {turn.sources.slice(0, 5).map((s) => (
                <li key={s.id} className="ch-reading__item"><Icon name={s.icon ?? "doc"} />{s.title}{s.subtitle ? <small>{s.subtitle}</small> : null}</li>
              ))}
            </ul>
          )}
          {turn.state === "withheld" && (
            <p className="ch-note">This answer is hidden: something it used isn't open to you any more.</p>
          )}
          {shown && <AnswerText md={shown} turn={turn} pattern={pattern} live={live} activeToken={activeToken} onCite={onCite} />}
          {turn.state === "stopped" && <p className="ch-note">{turn.note ?? "Stopped."}</p>}
          {(turn.state === "limit" || turn.state === "error") && (
            <div className={cx("ch-notice", turn.state === "limit" && "ch-notice--limit")} role="alert" data-testid="chat-notice">
              <Icon name={turn.state === "limit" ? "clock" : "alertCircle"} className="ch-notice__icon" />
              <span>{turn.note}</span>
              {turn.state === "error" && <button type="button" className="ch-notice__retry" onClick={() => onRetry(turn)}>Try again</button>}
            </div>
          )}
          {turn.state === "done" && (
            <div className="ch-tools">
              {n > 0 && (
                <button type="button" className="ch-tool ch-tool--sources" onClick={() => onCite(turn.id, null)} data-testid="chat-sources-btn">
                  <span className="ch-tool__stack" aria-hidden>
                    {turn.citations.slice(0, 3).map((c) => <span key={c.token}><Icon name={c.icon ?? "doc"} /></span>)}
                  </span>
                  {n} {n === 1 ? "source" : "sources"}
                </button>
              )}
              <button type="button" className="ch-tool" onClick={() => onCopy(turn)} aria-label="Copy answer" title="Copy answer">
                <Icon name="copy" />
              </button>
              {onInsert && (
                <button type="button" className="ch-tool ch-tool--label" onClick={() => onInsert(turn)} title="Insert into the doc">
                  <Icon name="plus" /> Insert
                </button>
              )}
              <button type="button" className="ch-tool" onClick={() => onRetry(turn)} aria-label="Ask again" title="Ask again">
                <Icon name="refresh" />
              </button>
            </div>
          )}
          {turn.state === "done" && !n && turn.sources.length > 0 && (
            <div className="ch-used">
              {turn.sources.slice(0, 4).map((s) => (
                <a key={s.id} className="ch-used__item" href={s.href} onClick={onNavigate}><Icon name={s.icon ?? "doc"} />{s.title}</a>
              ))}
            </div>
          )}
        </div>
      </div>
    </li>
  );
});

/** Streamed text, revealed a few characters a frame so it reads smoothly whatever the network does. */
function useReveal(text: string, live: boolean): string {
  const animate = useRef(live);
  const shown = useRef(live ? 0 : text.length);
  const [, force] = useState(0);
  if (live) animate.current = true;
  useEffect(() => {
    if (!animate.current) {
      shown.current = text.length;
      force((x) => x + 1);
      return;
    }
    let raf = 0;
    const tick = () => {
      const step = revealStep(shown.current, text.length);
      if (step <= 0) return;
      shown.current = Math.min(text.length, shown.current + step);
      force((x) => x + 1);
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [text]);
  return text.slice(0, Math.min(shown.current, text.length));
}

const AnswerText = memo(function AnswerText({ md, turn, pattern, live, activeToken, onCite }: {
  md: string; turn: ChatTurn; pattern: RegExp; live: boolean; activeToken: string | null;
  onCite: (turn: string, token: string | null) => void;
}) {
  const nums = useMemo(() => numberCitations(turn.answer, turn.citations.map((c) => c.token), pattern), [turn.answer, turn.citations, pattern]);
  const by = useMemo(() => new Map(turn.citations.map((c) => [c.token, c])), [turn.citations]);
  const writing = live || md.length < turn.answer.length;
  const components = useMemo<Components>(() => ({
    a: ({ href, children }) => {
      if (href && href.startsWith("#cite-")) {
        const tok = decodeURIComponent(href.slice(6));
        const c = by.get(tok);
        if (!c) return <span className="ch-cite ch-cite--pending" aria-hidden>·</span>;
        return <CiteChip n={nums.get(tok) ?? 0} c={c} active={activeToken === tok} onOpen={() => onCite(turn.id, tok)} />;
      }
      if (href && /^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>;
      if (href && href.startsWith("/") && !href.startsWith("//")) return <a href={href}>{children}</a>;
      return <>{children}</>;
    },
    img: () => null,
    h1: ({ children }) => <p className="ch-md__h">{children}</p>,
    h2: ({ children }) => <p className="ch-md__h">{children}</p>,
    h3: ({ children }) => <p className="ch-md__h">{children}</p>,
    table: ({ children }) => <div className="ch-md__table"><table>{children}</table></div>,
  }), [by, nums, activeToken, onCite, turn.id]);
  const known = useMemo(() => new Set(by.keys()), [by]);
  return (
    <div className="ch-md" data-streaming={writing ? "" : undefined}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>{linkCitations(md, known, pattern, writing)}</Markdown>
    </div>
  );
});

function CiteChip({ n, c, active, onOpen }: { n: number; c: ChatCitation; active: boolean; onOpen: () => void }) {
  const label = [c.title, c.meta].filter(Boolean).join(" · ");
  return (
    <button type="button" className="ch-cite" data-active={active ? "" : undefined} onClick={onOpen}
      aria-label={`Source ${n}: ${label}`} title={label} data-href={c.href} data-testid="chat-cite">
      {n}
    </button>
  );
}

// ── Sources ───────────────────────────────────────────────────────────────────

function SourcesPanel({ turn, token, pattern, layout, onClose, onNavigate }: {
  turn: ChatTurn; token: string | null; pattern: RegExp; layout: string; onClose: () => void; onNavigate?: () => void;
}) {
  const nums = useMemo(() => numberCitations(turn.answer, turn.citations.map((c) => c.token), pattern), [turn, pattern]);
  const list = useMemo(() => [...turn.citations].sort((a, b) => (nums.get(a.token) ?? 0) - (nums.get(b.token) ?? 0)), [turn.citations, nums]);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const item = token ? el.querySelector<HTMLElement>(`[data-token="${CSS.escape(token)}"]`) : null;
    (item ?? el.querySelector<HTMLElement>(".ch-src__title, button"))?.focus({ preventScroll: true });
    item?.scrollIntoView({ block: "nearest" });
  }, [token]);
  return (
    <>
      <div className="ch-sources__scrim" onClick={onClose} aria-hidden />
      <aside ref={panel} className="ch-sources" data-layout={layout} aria-label="Sources" data-testid="chat-sources">
        <header className="ch-sources__head">
          <h3>Sources <small>{list.length}</small></h3>
          <button type="button" className="ch-tool" onClick={onClose} aria-label="Close sources" title="Close (Esc)"><Icon name="x" /></button>
        </header>
        <ol className="ch-sources__list">
          {list.map((c) => (
            <SourceItem key={c.token} c={c} n={nums.get(c.token) ?? 0} active={c.token === token} onNavigate={onNavigate} />
          ))}
        </ol>
      </aside>
    </>
  );
}

function SourceItem({ c, n, active, onNavigate }: { c: ChatCitation; n: number; active: boolean; onNavigate?: () => void }): ReactNode {
  const ext = c.external || /^https?:\/\//i.test(c.href);
  return (
    <li className="ch-src" data-active={active ? "" : undefined} data-token={c.token} tabIndex={-1}>
      <span className="ch-src__n" aria-hidden>{n}</span>
      <div className="ch-src__main">
        <p className="ch-src__title"><Icon name={c.icon ?? "doc"} />{c.title}</p>
        {c.subtitle && <p className="ch-src__sub">{c.subtitle}</p>}
        {c.meta && <p className="ch-src__meta">{c.meta}</p>}
        {c.quote && <blockquote className="ch-src__quote">{c.quote}</blockquote>}
        <a className="ch-src__go" href={c.href} onClick={onNavigate} {...(ext ? { target: "_blank", rel: "noopener noreferrer" } : {})} data-testid="chat-source-link">
          {c.action ?? "Open"} <Icon name={ext ? "external" : "arrowRight"} />
        </a>
      </div>
    </li>
  );
}

export default Chat;
