"use client";

/**
 * "Ask Markdrop": the first thing on the home (/dashboard, the installed app's start page).
 *
 * One box that asks across the meetings, documents, pages, files and Guides the person can open
 * (backend services/ask_markdrop.py). Suggested questions, recent questions, and a conversation
 * with follow-ups. The open conversation lives in the URL (?ask=<id>) so reload and Back work.
 * Phone first: a 16px field (no iOS zoom), 44px targets, chips that scroll sideways.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog, Icon, IconButton, Spinner, cx } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { useLocationSearch, useMounted } from "@/components/shell/useLocation";
import {
  askHome, askMarkdrop, clearAskThreads, deleteAskThread, getAskThread,
  type AskCitation, type AskEvent, type AskHomeData, type AskIntent, type AskResultItem,
} from "@/lib/ask";
import { hrefOf } from "@/lib/search";
import { askSegments, blocksOf, chipOf, sourcesOf, STAGES, SUGGESTION_ICONS, type AskSource } from "@/lib/askCore.mjs";
import { shortAgo } from "@/lib/searchCore.mjs";
import { track } from "@/lib/track";
import s from "./ask.module.css";

interface Turn {
  id: string;
  question: string;
  intent: AskIntent;
  status: "running" | "done" | "limit" | "error" | "withheld";
  stage: string | null;
  text: string;
  answer: string;
  citations: AskCitation[];
  ranked: AskResultItem[];
  message: string;
}

const RECENT_SHOWN = 5;
let turnSeq = 0;
const newTurn = (question: string, intent: AskIntent, patch: Partial<Turn> = {}): Turn => ({
  id: `t${++turnSeq}`, question, intent, status: "running", stage: null, text: "", answer: "", citations: [], ranked: [], message: "", ...patch,
});

const KIND_ICON: Record<string, string> = { page: "lines", doc: "doc", file: "layers", guide: "listTree", folder: "folder", workspace: "users" };

function readAsk(search: string): string | null {
  const v = new URLSearchParams(search).get("ask");
  return v && /^[0-9a-f]{24}$/.test(v) ? v : null;
}

export default function AskHome() {
  const router = useRouter();
  const toast = useToast();
  const mounted = useMounted();
  const search = useLocationSearch();
  const urlThread = mounted ? readAsk(search) : null;

  const [home, setHome] = useState<AskHomeData | null>(null);
  const [homeFailed, setHomeFailed] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [input, setInput] = useState("");
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  const loaded = useRef<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const refreshHome = useCallback(() => {
    askHome().then((h) => { setHome(h); setHomeFailed(false); }).catch(() => setHomeFailed(true));
  }, []);
  useEffect(() => { refreshHome(); }, [refreshHome]);
  useEffect(() => () => ctl.current?.abort(), []);

  /** ?ask=<id> in the URL (push: Back closes the conversation). */
  const setAskParam = useCallback((id: string | null, replace = false) => {
    const p = new URLSearchParams(window.location.search);
    if (id) p.set("ask", id); else p.delete("ask");
    const qs = p.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    if (replace) router.replace(url, { scroll: false }); else router.push(url, { scroll: false });
  }, [router]);

  // The URL decides which conversation is open.
  useEffect(() => {
    if (!mounted) return;
    if (!urlThread) {
      if (loaded.current) {
        ctl.current?.abort();
        loaded.current = null;
        setThreadId(null);
        setTurns([]);
      }
      return;
    }
    if (urlThread === loaded.current) return;
    loaded.current = urlThread;
    ctl.current?.abort();
    setThreadId(urlThread);
    setTurns([]);
    setLoadingThread(true);
    getAskThread(urlThread)
      .then((t) => {
        if (loaded.current !== urlThread) return;
        setTurns(t.turns.map((x) => newTurn(x.question, x.intent, x.withheld
          ? { status: "withheld" }
          : { status: "done", answer: x.answer || "", citations: x.citations || [] })));
      })
      .catch(() => {
        if (loaded.current !== urlThread) return;
        toast.error("That conversation isn't there any more.");
        loaded.current = null;
        setThreadId(null);
        setAskParam(null, true);
      })
      .finally(() => setLoadingThread(false));
  }, [mounted, urlThread, toast, setAskParam]);

  const running = turns.some((t) => t.status === "running");
  const enabled = home?.status.enabled !== false;

  const run = useCallback((question: string, intent: AskIntent | null) => {
    const q = question.trim();
    if ((!q && !intent) || running) return;
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    const thread = threadId;
    const label = q || home?.suggestions.find((x) => x.intent === intent)?.question || "";
    const turn = newTurn(label, intent || "ask", { stage: intent && intent !== "ask" ? "searching" : "understanding" });
    setTurns((ts) => [...ts, turn]);
    setInput("");
    track("ask_markdrop", { intent: intent || "typed", follow_up: !!thread });
    const patch = (fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === turn.id ? fn(t) : t)));
    const on = (e: AskEvent) => {
      if (c.signal.aborted) return;
      switch (e.type) {
        case "status": patch((t) => ({ ...t, stage: e.stage })); break;
        case "results": patch((t) => ({ ...t, ranked: e.items || [] })); break;
        case "delta": patch((t) => ({ ...t, stage: "answering", text: t.text + e.text })); break;
        case "done":
          patch((t) => ({ ...t, status: "done", stage: null, intent: e.intent || t.intent, answer: e.answer || t.text, citations: e.citations || [], ranked: e.ranked || t.ranked }));
          if (e.thread_id && !thread) {
            loaded.current = e.thread_id;
            setThreadId(e.thread_id);
            setAskParam(e.thread_id);
          }
          refreshHome();
          break;
        case "limit": patch((t) => ({ ...t, status: "limit", stage: null, message: e.message })); break;
        case "error": patch((t) => ({ ...t, status: "error", stage: null, message: e.detail || "Ask Markdrop hit a problem. Try again." })); break;
      }
    };
    void askMarkdrop({ question: q, thread_id: thread, intent }, on, c.signal).then(() => {
      if (c.signal.aborted) return;
      patch((t) => (t.status === "running" ? { ...t, status: t.text ? "done" : "error", answer: t.answer || t.text, message: t.text ? "" : "The answer stopped early. Try again." } : t));
    });
  }, [running, threadId, home, refreshHome, setAskParam]);

  // Keep the newest turn in view while it streams.
  const lastText = turns.length ? turns[turns.length - 1].text.length : 0;
  useEffect(() => {
    if (!turns.length || !running) return;
    bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [turns.length, lastText, running]);

  // The field grows with what is typed (up to ~6 lines).
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [input]);

  const startOver = useCallback(() => {
    ctl.current?.abort();
    setInput("");
    if (urlThread) setAskParam(null);
    else { loaded.current = null; setThreadId(null); setTurns([]); }
    requestAnimationFrame(() => field.current?.focus());
  }, [urlThread, setAskParam]);

  const open = useCallback((target: { url: string | null; kind?: string | null; slug?: string | null }, newTab: boolean) => {
    if (!target.url) return;
    const { href, external } = hrefOf({ url: target.url, kind: (target.kind || "page") as AskResultItem["kind"], slug: target.slug || undefined });
    if (newTab || external) window.open(href, "_blank", "noopener,noreferrer");
    else router.push(href);
  }, [router]);

  const inThread = turns.length > 0 || loadingThread;
  const recent = home?.recent || [];
  const recentShown = showAllRecent ? recent : recent.slice(0, RECENT_SHOWN);
  const placeholder = inThread ? "Ask a follow-up…" : "Ask about your meetings, docs, pages and files…";

  return (
    <section className={s.ask} aria-labelledby="md-ask-title" data-testid="ask-home">
      <header className={s.head}>
        <h2 id="md-ask-title" className={s.title}>
          <span className={s.spark} aria-hidden><Icon name="sparkle" size={14} /></span>
          Ask Markdrop
        </h2>
        {inThread && (
          <button type="button" className={s.newBtn} onClick={startOver} disabled={loadingThread}>
            <Icon name="plus" size={14} /> New question
          </button>
        )}
      </header>

      {inThread && (
        <ol className={s.turns} aria-label="Conversation">
          {loadingThread && !turns.length && (
            <li className={s.turn}><p className={s.stage}><Spinner size={12} /> Opening the conversation…</p></li>
          )}
          {turns.map((t) => <TurnView key={t.id} turn={t} onOpen={open} onRetry={() => run(t.question, t.intent === "ask" ? null : t.intent)} />)}
        </ol>
      )}
      <div ref={bottom} />

      <form
        className={cx(s.composer, !enabled && s.composerOff)}
        onSubmit={(e) => { e.preventDefault(); run(input, null); }}
      >
        <label htmlFor="md-ask-field" className="md-visually-hidden">{inThread ? "Ask a follow-up" : "Ask Markdrop"}</label>
        <textarea
          id="md-ask-field"
          ref={field}
          className={s.field}
          rows={1}
          value={input}
          maxLength={500}
          placeholder={enabled ? placeholder : home?.status.message || "AI isn't available right now."}
          disabled={!enabled}
          enterKeyHint="send"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); run(input, null); }
            if (e.key === "Escape" && input) { e.preventDefault(); setInput(""); }
          }}
        />
        <button type="submit" className={s.send} aria-label="Ask" disabled={!enabled || running || !input.trim()}>
          {running ? <Spinner size={16} /> : <Icon name="arrowUp" size={18} />}
        </button>
      </form>
      {!enabled && home?.status.message && <p className={s.note} role="status">{home.status.message}</p>}

      {!inThread && (
        <>
          {home && home.suggestions.length > 0 && (
            <ul className={s.chips} aria-label="Suggested questions">
              {home.suggestions.map((sg) => (
                <li key={sg.label}>
                  <button type="button" className={s.chip} disabled={!enabled || running}
                    onClick={() => run(sg.intent === "ask" ? sg.question : "", sg.intent === "ask" ? null : sg.intent)}>
                    <Icon name={SUGGESTION_ICONS[sg.intent] || "sparkle"} size={14} />
                    <span>{sg.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {homeFailed && !home && <p className={s.note}>Couldn&apos;t load suggestions. <button type="button" className={s.linkBtn} onClick={refreshHome}>Try again</button></p>}
          {recent.length > 0 && (
            <div className={s.recent}>
              <div className={s.recentHead}>
                <h3 className={s.recentTitle}>Recent questions</h3>
                <button type="button" className={s.linkBtn} onClick={() => setClearOpen(true)}>Clear</button>
              </div>
              <ul className={s.recentList}>
                {recentShown.map((r) => (
                  <li key={r.id} className={s.recentRow}>
                    <button type="button" className={s.recentOpen} onClick={() => setAskParam(r.id)}>
                      <Icon name="message" size={14} className={s.recentIcon} />
                      <span className={cx(s.recentQ, "ph-sensitive")} dir="auto">{r.title}</span>
                      <span className={s.recentMeta}>{r.turns > 1 ? `${r.turns} questions · ` : ""}{shortAgo(r.updated_at)}</span>
                    </button>
                    <IconButton icon="x" label={`Forget “${r.title}”`} size="sm" className={s.recentDel}
                      onClick={async () => {
                        try { await deleteAskThread(r.id); refreshHome(); } catch { toast.error("Couldn't remove it. Try again."); }
                      }} />
                  </li>
                ))}
              </ul>
              {recent.length > RECENT_SHOWN && (
                <button type="button" className={s.linkBtn} onClick={() => setShowAllRecent((v) => !v)}>
                  {showAllRecent ? "Show fewer" : `Show all ${recent.length}`}
                </button>
              )}
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        title="Clear recent questions?"
        body={<p className="text-body text-text-secondary">Every conversation you had with Ask Markdrop is deleted. Your documents aren&apos;t touched.</p>}
        confirmLabel="Clear"
        onConfirm={async () => { await clearAskThreads(); setClearOpen(false); refreshHome(); toast.success("Recent questions cleared"); }}
      />
    </section>
  );
}

/* ── One question and its answer ─────────────────────────────────────────── */

function TurnView({ turn, onOpen, onRetry }: {
  turn: Turn;
  onOpen: (t: { url: string | null; kind?: string | null; slug?: string | null }, newTab: boolean) => void;
  onRetry: () => void;
}) {
  // While it streams the numbers aren't final (the server re-checks every cited item): chips come with the answer.
  const body = turn.status === "done" ? turn.answer : turn.text.replace(/\s?\[\d{1,2}(?:-s\d{1,5})?\]/g, "");
  const sources = useMemo(() => sourcesOf(body, turn.citations), [body, turn.citations]);
  const known = useMemo(() => turn.citations.map((c) => c.label), [turn.citations]);
  const byLabel = useMemo(() => new Map(turn.citations.map((c) => [c.label, c])), [turn.citations]);
  const blocks = blocksOf(body);

  const cite = (label: string) => {
    const c = byLabel.get(label);
    return (
      <button type="button" className={s.cite} title={c ? [c.title, c.moment].filter(Boolean).join(" · ") : undefined}
        onClick={(e) => c && onOpen({ url: c.url, kind: c.kind, slug: c.slug }, e.metaKey || e.ctrlKey)}>
        {chipOf(sources, label)}
      </button>
    );
  };

  return (
    <li className={s.turn}>
      <p className={cx(s.question, "ph-sensitive")} dir="auto">{turn.question}</p>
      <div className={s.answer} aria-live={turn.status === "running" ? "polite" : undefined} aria-busy={turn.status === "running"}>
        {turn.status === "withheld" ? (
          <p className={s.note}><Icon name="lock" size={13} /> This answer is hidden: something it cited is no longer open to you.</p>
        ) : turn.status === "limit" || turn.status === "error" ? (
          <p className={s.note} role="alert">
            {turn.message}
            {turn.status === "error" && <button type="button" className={s.linkBtn} onClick={onRetry}>Try again</button>}
          </p>
        ) : (
          <>
            {turn.status === "running" && turn.stage && !body && (
              <p className={s.stage}><Spinner size={12} /> {STAGES[turn.stage] || STAGES.searching}</p>
            )}
            {blocks.length > 0 && (
              <div className={s.text} dir="auto">
                {blocks.map((b, i) => (b.type === "ul"
                  ? <ul key={i}>{b.items.map((it, j) => <li key={j}><Inline text={it} known={known} cite={cite} /></li>)}</ul>
                  : <p key={i}><Inline text={b.text} known={known} cite={cite} /></p>))}
                {turn.status === "running" && <span className={s.caret} aria-hidden />}
              </div>
            )}
            {turn.status === "running" && !body && turn.stage === "answering" && (
              <p className={s.placeholder} aria-hidden><span className={s.shimmer} /><span className={s.shimmer} style={{ width: "62%" }} /></p>
            )}
          </>
        )}
        {sources.length > 0 && turn.status !== "withheld" && <Sources sources={sources} onOpen={onOpen} />}
        {turn.status === "done" && sources.length > 0 && (
          <p className={s.foot}>AI can be wrong; check the sources. Only what you can open was read.</p>
        )}
      </div>
    </li>
  );
}

function Sources({ sources, onOpen }: { sources: AskSource[]; onOpen: (t: { url: string | null; kind?: string | null; slug?: string | null }, newTab: boolean) => void }) {
  return (
    <ol className={s.sources} aria-label="Sources">
      {sources.map((src) => (
        <li key={src.n} className={s.source}>
          <button type="button" className={s.sourceMain} disabled={!src.url}
            onClick={(e) => onOpen({ url: src.url, kind: src.kind, slug: src.slug }, e.metaKey || e.ctrlKey)}>
            <span className={s.sourceN}>{src.shown}</span>
            <Icon name={KIND_ICON[src.kind || "page"] || "lines"} size={14} className={s.sourceIcon} />
            <span className={s.sourceTitle} dir="auto">{src.title || "Untitled"}</span>
          </button>
          {src.task && <span className={s.sourceTask} dir="auto">{src.task}</span>}
          {src.moments.length > 0 && (
            <span className={s.moments}>
              {src.moments.map((m, i) => (
                <button key={m.label} type="button" className={s.moment} disabled={!m.url}
                  onClick={(e) => onOpen({ url: m.url, kind: "page", slug: m.slug }, e.metaKey || e.ctrlKey)}>
                  <Icon name="mic" size={12} /> {src.shown}·{i + 1} {m.moment || "Transcript"}
                </button>
              ))}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Inline Markdown for an answer line: **bold**, `code`, and citation chips. */
function Inline({ text, known, cite }: { text: string; known: string[]; cite: (label: string) => React.ReactNode }) {
  return (
    <>
      {askSegments(text, known).map((seg, i) => {
        if (seg.cite !== undefined) return <span key={i}>{cite(seg.cite)}</span>;
        const parts = (seg.text || "").split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
        return (
          <span key={i}>
            {parts.map((p, j) => (p.startsWith("**") && p.endsWith("**") && p.length > 4 ? <strong key={j}>{p.slice(2, -2)}</strong>
              : p.startsWith("`") && p.endsWith("`") && p.length > 2 ? <code key={j}>{p.slice(1, -1)}</code> : <span key={j}>{p}</span>))}
          </span>
        );
      })}
    </>
  );
}
