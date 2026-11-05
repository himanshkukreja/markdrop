"use client";

/**
 * The shared chat's state: turns, the stream in flight (stop), the server-side thread, and a memory per
 * `persistKey` so a conversation survives moving around the app (a reload restores it through `loadThread`).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { historyOf } from "./chatCore.mjs";
import type { ChatEvent, ChatScope, ChatTransport, ChatTurn } from "./types";

const FAILED = "Something went wrong while answering. Try again.";
const MAX_TURNS = 30;
const memory = new Map<string, { turns: ChatTurn[]; threadId: string | null }>();
let seq = 0;
const newId = () => `t${Date.now().toString(36)}${++seq}`;

export interface UseChat {
  turns: ChatTurn[];
  streaming: boolean;
  restoring: boolean;
  threadId: string | null;
  ask: (question: string) => void;
  stop: () => void;
  retry: (turn: ChatTurn) => void;
  reset: () => void;
}

export function useChat<C>({ transport, persistKey, scope, context, threadId: threadProp, onThreadChange, loadThread }: {
  transport: ChatTransport<ChatScope, C>;
  persistKey: string;
  scope: ChatScope;
  context: C | undefined;
  threadId?: string | null;
  onThreadChange?: (id: string | null) => void;
  loadThread?: (id: string) => Promise<ChatTurn[]>;
}): UseChat {
  const remembered = memory.get(persistKey);
  const [turns, setTurnsState] = useState<ChatTurn[]>(() => remembered?.turns ?? []);
  const [threadId, setThreadState] = useState<string | null>(() => remembered?.threadId ?? threadProp ?? null);
  const [restoring, setRestoring] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  const key = useRef(persistKey);
  const live = useRef({ transport, scope, context, onThreadChange, threadId, turns });
  live.current = { transport, scope, context, onThreadChange, threadId, turns };

  const save = useCallback((k: string, next: { turns?: ChatTurn[]; threadId?: string | null }) => {
    const cur = memory.get(k) ?? { turns: [], threadId: null };
    memory.set(k, { ...cur, ...next });
  }, []);
  const setTurns = useCallback((fn: (t: ChatTurn[]) => ChatTurn[]) => {
    const k = key.current;
    setTurnsState((prev) => {
      const next = fn(prev).slice(-MAX_TURNS);
      save(k, { turns: next });
      return next;
    });
  }, [save]);
  const setThread = useCallback((id: string | null) => {
    setThreadState(id);
    save(key.current, { threadId: id });
    live.current.onThreadChange?.(id);
  }, [save]);

  // Another conversation (another meeting): its memory, or its saved thread.
  useEffect(() => {
    if (key.current === persistKey) return;
    key.current = persistKey;
    ctrl.current?.abort();
    const m = memory.get(persistKey);
    setTurnsState(m?.turns ?? []);
    setThreadState(m?.threadId ?? threadProp ?? null);
  }, [persistKey, threadProp]);

  // A reload: the saved thread's turns (once per key, only when nothing is in memory).
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!loadThread || !threadProp || loadedFor.current === `${persistKey}:${threadProp}`) return;
    if ((memory.get(persistKey)?.turns.length ?? 0) > 0) return;
    loadedFor.current = `${persistKey}:${threadProp}`;
    let gone = false;
    setRestoring(true);
    loadThread(threadProp)
      .then((t) => {
        if (gone || key.current !== persistKey) return;
        setThreadState(threadProp);
        save(persistKey, { threadId: threadProp });
        setTurns(() => t);
      })
      .catch(() => { if (!gone) live.current.onThreadChange?.(null); })
      .finally(() => { if (!gone) setRestoring(false); });
    return () => { gone = true; };
  }, [loadThread, threadProp, persistKey, save, setTurns]);

  useEffect(() => () => ctrl.current?.abort(), []);

  const streaming = turns.some((t) => t.state === "streaming");

  const ask = useCallback((question: string) => {
    const text = question.trim();
    if (!text || ctrl.current) return;
    const { transport: send, scope: sc, context: cx, threadId: tid } = live.current;
    const history = historyOf(live.current.turns);
    const id = newId();
    setTurns((t) => [...t, { id, question: text, answer: "", state: "streaming", citations: [], sources: [] }]);
    const c = new AbortController();
    ctrl.current = c;
    const patch = (fn: (t: ChatTurn) => ChatTurn) => setTurns((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));
    let ended = false;
    const emit = (e: ChatEvent) => {
      if (c.signal.aborted && e.type !== "done") return;
      if (e.type === "stage") patch((t) => ({ ...t, stage: e.label }));
      else if (e.type === "sources") patch((t) => ({ ...t, sources: e.items, scopeNote: e.note ?? t.scopeNote }));
      else if (e.type === "delta") patch((t) => ({ ...t, answer: t.answer + e.text }));
      else if (e.type === "done") {
        ended = true;
        if (e.threadId !== undefined && e.threadId !== live.current.threadId) setThread(e.threadId);
        patch((t) => {
          const a = (e.answer || t.answer || "").trim();
          return { ...t, answer: a, citations: e.citations || [], sources: e.sources ?? t.sources, scopeNote: e.note ?? t.scopeNote,
            state: a ? "done" : "error", note: a ? null : FAILED, stage: null };
        });
      } else if (e.type === "limit") {
        ended = true;
        patch((t) => ({ ...t, state: "limit", note: e.message || "AI limit reached. Try again later.", stage: null }));
      } else if (e.type === "error") {
        ended = true;
        patch((t) => ({ ...t, state: "error", note: e.message || FAILED, stage: null }));
      }
    };
    void (async () => {
      try {
        await send({ question: text, history, scope: sc, context: cx, threadId: tid, signal: c.signal }, emit);
      } catch {
        if (!c.signal.aborted) emit({ type: "error", message: FAILED });
      } finally {
        if (!ended) {
          patch((t) => (t.state === "streaming"
            ? { ...t, state: c.signal.aborted || t.answer ? "stopped" : "error", stage: null,
                note: c.signal.aborted ? null : t.answer ? "The answer stopped early." : FAILED }
            : t));
        }
        if (ctrl.current === c) ctrl.current = null;
      }
    })();
  }, [setTurns, setThread]);

  const stop = useCallback(() => ctrl.current?.abort(), []);
  const retry = useCallback((turn: ChatTurn) => {
    setTurns((ts) => ts.filter((x) => x.id !== turn.id));
    window.setTimeout(() => ask(turn.question), 0);
  }, [ask, setTurns]);
  const reset = useCallback(() => {
    ctrl.current?.abort();
    setTurns(() => []);
    setThread(null);
  }, [setTurns, setThread]);

  return { turns, streaming, restoring, threadId, ask, stop, retry, reset };
}

/** Forget every remembered conversation (sign-out). */
export function forgetChats() {
  memory.clear();
}

/** Forget one remembered conversation (the home's "Recent questions" opens another in its place). */
export function forgetChat(persistKey: string) {
  memory.delete(persistKey);
}
