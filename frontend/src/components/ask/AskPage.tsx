"use client";

/**
 * The Ask page (/ask): the one assistant (components/assistant) as its own place, not only the side panel.
 * Owner, 2026-11-06 (.work/briefs/ask-page.md): the name follows the scope — "Ask" (Everything), "Ask
 * <Workspace>", "Ask my files".
 *
 *  - Left: your conversations (the same 90-day threads as the ✦ Ask panel and the home's Recent questions);
 *    on phones they live in a drawer (History). Centre: the conversation (the shared chat, page layout).
 *    Top: the title and the scope chips — Everything · <each workspace> · My files.
 *  - Empty: a big composer and suggestions. In a workspace: its live team questions (GET /ask/suggestions:
 *    built only from what every member can read, "Updated 2 h ago") and yours; elsewhere, yours.
 *    A suggestion asks at once, in that scope.
 *  - One conversation everywhere: the panel and this page share it (store + PERSIST_KEY); "Open full page"
 *    in the panel lands here on it. ⌘J here focuses the composer.
 *  - URL: ?workspace=<id> | ?scope=mine, ?c=<conversation> (the old home's ?ask=<id> too), ?q=<ask now>.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog, Drawer, Icon, IconButton, Spinner, cx } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { useMounted } from "@/components/shell/useLocation";
import { Chat } from "@/components/chat";
import { forgetChat } from "@/components/chat/useChat";
import type { ChatHandle, ChatScope, ChatSuggestion } from "@/components/chat/types";
import { PHONE_QUERY, useMediaQuery } from "@/components/kit/publish-utils";
import {
  clearAskThreads, deleteAskThread, getAskSuggestions, getAssistantContext, listAskThreads,
  type AskSuggestions, type AskThreadCard, type AssistantContext, type AssistantScopeKind,
} from "@/lib/ask";
import { readAskParams, suggestionsOf, updatedLine } from "@/lib/askCore.mjs";
import { shortAgo } from "@/lib/searchCore.mjs";
import { track } from "@/lib/track";
import { askPlaceholder, askTitle } from "@/components/assistant/assistantCore.mjs";
import { PERSIST_KEY, setAssistantThread, useAssistant, useAssistantHere, useHomeFocus } from "@/components/assistant/store";
import { assistantTransport, loadAssistantThread } from "@/components/assistant/transport";
import s from "./AskPage.module.css";

type PageScope = { kind: "everything" | "workspace" | "mine"; workspace?: string };
const SCOPE_KEY = "md_ask_scope";
const CONTEXT = { ctx: null };
const FALLBACK: ChatSuggestion[] = [
  { q: "Catch me up on this week", icon: "clock" },
  { q: "What are my open action items?", icon: "checkSquare" },
];
const NARROW_QUERY = "(max-width: 899px)";
const POLL_MS = 4000;
const POLLS = 5;

function remembered(): PageScope | null {
  try {
    const v = JSON.parse(localStorage.getItem(SCOPE_KEY) || "null");
    if (v && (v.kind === "everything" || v.kind === "mine" || (v.kind === "workspace" && /^[0-9a-f]{24}$/.test(v.workspace || "")))) return v;
  } catch { /* storage blocked */ }
  return null;
}

function remember(scope: PageScope) {
  try { localStorage.setItem(SCOPE_KEY, JSON.stringify(scope)); } catch { /* storage blocked */ }
}

export default function AskPage() {
  const toast = useToast();
  const mounted = useMounted();
  const phone = useMediaQuery(PHONE_QUERY);
  // Below 900px the conversations list is a drawer (phones, tablets in portrait); above, a column.
  const narrow = useMediaQuery(NARROW_QUERY);
  const { threadId } = useAssistant();
  const chat = useRef<ChatHandle>(null);
  const [chatKey, setChatKey] = useState(0);
  const [scope, setScopeState] = useState<PageScope | null>(null);
  const [ctx, setCtx] = useState<AssistantContext | null>(null);
  const [threads, setThreads] = useState<AskThreadCard[] | null>(null);
  const [sug, setSug] = useState<AskSuggestions | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const pendingQ = useRef<string | null>(null);

  // What the URL asks for (once): a scope, a conversation, a question to ask now.
  useEffect(() => {
    if (!mounted) return;
    const p = readAskParams(window.location.search);
    const wanted: PageScope = p.workspace ? { kind: "workspace", workspace: p.workspace } : p.mine ? { kind: "mine" } : remembered() ?? { kind: "everything" };
    setScopeState(wanted);
    if (p.q) {
      // A suggestion from elsewhere (the home, the panel): a new conversation, asked at once.
      forgetChat(PERSIST_KEY);
      setAssistantThread(null);
      pendingQ.current = p.q;
      setChatKey((k) => k + 1);
    } else if (p.thread && p.thread !== threadId) {
      forgetChat(PERSIST_KEY);
      setAssistantThread(p.thread);
      setChatKey((k) => k + 1);
    }
    getAssistantContext({}).then(setCtx).catch(() => setCtx(null));
  }, [mounted]); // eslint-disable-line react-hooks/exhaustive-deps

  const workspaces = useMemo(() => ctx?.workspaces ?? [], [ctx]);
  // A workspace from the URL that isn't one of yours: Everything (the server would answer 404 anyway).
  useEffect(() => {
    if (ctx && scope?.kind === "workspace" && !workspaces.some((w) => w.id === scope.workspace)) setScopeState({ kind: "everything" });
  }, [ctx, scope, workspaces]);

  const ws = scope?.kind === "workspace" ? workspaces.find((w) => w.id === scope.workspace) ?? null : null;
  const kind: AssistantScopeKind = scope?.kind ?? "everything";
  const title = askTitle(kind, ws?.name);
  useAssistantHere({ home: true, workspace: ws?.id ?? null });
  const focus = useCallback(() => chat.current?.focus(), []);
  useHomeFocus(focus);

  const setScope = useCallback((next: PageScope) => {
    setScopeState(next);
    remember(next);
    track("ask_page_scope", { scope: next.kind });
    const p = new URLSearchParams(window.location.search);
    p.delete("workspace");
    p.delete("scope");
    if (next.kind === "workspace" && next.workspace) p.set("workspace", next.workspace);
    if (next.kind === "mine") p.set("scope", "mine");
    const qs = p.toString();
    window.history.replaceState(window.history.state, "", `/ask${qs ? `?${qs}` : ""}`);
  }, []);

  // Suggestions for this scope: the workspace's live ones (polled while the first list is being built).
  const sugFor = scope ? (scope.kind === "workspace" ? scope.workspace ?? "" : "") : null;
  useEffect(() => {
    if (sugFor === null || !mounted) return;
    let on = true;
    let polls = 0;
    let timer = 0;
    setSug(null);
    const load = () => getAskSuggestions(sugFor || null).then((x) => {
      if (!on) return;
      setSug(x);
      if (x.refreshing && polls++ < POLLS) timer = window.setTimeout(load, POLL_MS);
    }).catch(() => {});
    void load();
    return () => { on = false; window.clearTimeout(timer); };
  }, [sugFor, mounted]);

  const refreshThreads = useCallback(() => {
    listAskThreads(50).then((r) => setThreads(r.threads)).catch(() => setThreads((t) => t ?? []));
  }, []);
  useEffect(() => { if (mounted) refreshThreads(); }, [mounted, refreshThreads]);

  // The URL follows the open conversation (?c=), for a reload.
  const setConvParam = useCallback((id: string | null) => {
    const p = new URLSearchParams(window.location.search);
    p.delete("ask");
    p.delete("q");
    if (id) p.set("c", id); else p.delete("c");
    const qs = p.toString();
    window.history.replaceState(window.history.state, "", `/ask${qs ? `?${qs}` : ""}`);
  }, []);

  const switching = useRef(false);
  const openThread = useCallback((id: string | null) => {
    switching.current = true;
    chat.current?.newChat();
    switching.current = false;
    forgetChat(PERSIST_KEY);
    setAssistantThread(id);
    setConvParam(id);
    setChatKey((k) => k + 1);
    setHistoryOpen(false);
  }, [setConvParam]);

  const onThread = useCallback((id: string | null) => {
    if (switching.current) return;
    setAssistantThread(id);
    setConvParam(id);
    if (id) refreshThreads();
  }, [setConvParam, refreshThreads]);

  // A question from the URL, once the chat is mounted on its scope.
  useEffect(() => {
    if (!scope || !pendingQ.current) return;
    const q = pendingQ.current;
    pendingQ.current = null;
    window.setTimeout(() => chat.current?.ask(q), 0);
    setConvParam(null);
  }, [scope, chatKey, setConvParam]);

  const chatScope = useMemo<ChatScope>(() => ({ kind, ...(ws ? { workspace: ws.id } : {}) }), [kind, ws]);
  const suggestions = useMemo(() => {
    const live = sug ? suggestionsOf(sug, phone ? 4 : 8) : [];
    return live.length ? live : FALLBACK;
  }, [sug, phone]);
  const status = sug?.status ?? ctx?.status.search ?? null;
  const enabled = status?.enabled !== false;
  const sub = [
    kind === "workspace" ? "The meetings, docs, pages and files of this workspace that you can open." :
      kind === "mine" ? "Your own documents, pages and files outside any workspace." :
        "Your meetings, documents, pages, files and Guides — only what you can open.",
    kind === "workspace" ? (sug?.refreshing ? "Finding what's happening…" : updatedLine(sug)) : "",
  ].filter(Boolean).join(" ");

  const chips: Array<{ key: string; scope: PageScope; label: string; icon: string }> = [
    { key: "everything", scope: { kind: "everything" }, label: "Everything", icon: "sparkle" },
    ...workspaces.map((w) => ({ key: `workspace:${w.id}`, scope: { kind: "workspace" as const, workspace: w.id }, label: w.name || "Workspace", icon: "users" })),
    { key: "mine", scope: { kind: "mine" }, label: "My files", icon: "user" },
  ];
  const activeKey = kind === "workspace" ? `workspace:${scope?.workspace}` : kind;

  const history = (
    <History threads={threads} current={threadId} onOpen={(id) => { track("ask_page_thread", {}); openThread(id); }}
      onNew={() => openThread(null)} onClear={() => setClearOpen(true)}
      onForget={async (t) => {
        try {
          await deleteAskThread(t.id);
          if (t.id === threadId) openThread(null);
          refreshThreads();
        } catch { toast.error("Couldn't remove it. Try again."); }
      }} />
  );

  return (
    <div className={s.page} data-testid="ask-page">
      <aside className={s.side} aria-label="Conversations">{history}</aside>
      <section className={s.main} aria-labelledby="ask-title">
        <header className={s.head}>
          <div className={s.titleRow}>
            <button type="button" className={s.historyBtn} onClick={() => setHistoryOpen(true)} aria-haspopup="dialog" data-testid="ask-history-open">
              <Icon name="history" size={18} /><span className={s.historyLabel}>History</span>
            </button>
            <h1 id="ask-title" className={s.title} data-testid="ask-title">
              <span className={s.spark} aria-hidden><Icon name="sparkle" size={16} /></span>
              <span className={s.titleText}>{title}</span>
            </h1>
            <button type="button" className={s.newBtn} onClick={() => openThread(null)} data-testid="ask-new">
              <Icon name="plus" size={16} /><span className={s.newLabel}>New chat</span>
            </button>
          </div>
          <div className={s.chips} role="radiogroup" aria-label="Ask about" data-testid="ask-scopes">
            {!ctx && mounted && <span className={s.wait}><Spinner size={12} /> Loading your workspaces…</span>}
            {chips.map((c) => (
              <button key={c.key} type="button" role="radio" aria-checked={activeKey === c.key}
                className={cx(s.chip, activeKey === c.key && s.chipOn)} onClick={() => setScope(c.scope)}
                data-testid={`ask-scope-${c.key.replace(":", "-")}`}>
                <Icon name={c.icon} size={14} /><span className={s.chipLabel}>{c.label}</span>
              </button>
            ))}
          </div>
        </header>
        <div className={s.chat}>
          {scope && (
            <Chat
              key={chatKey}
              ref={chat}
              layout="page"
              persistKey={PERSIST_KEY}
              transport={assistantTransport as never}
              scope={chatScope}
              context={CONTEXT}
              threadId={threadId}
              onThreadChange={onThread}
              loadThread={loadAssistantThread}
              suggestions={suggestions}
              empty={{ icon: "sparkle", title, sub }}
              placeholder={enabled ? askPlaceholder(kind, ws?.name) : status?.message || "AI isn't available right now."}
              banner={!enabled && status?.message ? <p className={s.note} role="status"><Icon name="clock" size={14} /> {status.message}</p> : null}
              footnote="Answers use only what you can open. AI can be wrong."
              assistantName={title}
              maxLength={500}
              autoFocus={!phone}
              className={s.chatInner}
              testId="ask-page-chat"
            />
          )}
        </div>
      </section>
      {narrow && (
        <Drawer open={historyOpen} onClose={() => setHistoryOpen(false)} side="left" width={320} title="Conversations" bodyClassName="p-0">
          {history}
        </Drawer>
      )}
      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        title="Clear all conversations?"
        body={<p className="text-body text-text-secondary">Every conversation you had with Ask is deleted, here and in the ✦ Ask panel. Your documents aren&apos;t touched.</p>}
        confirmLabel="Clear"
        onConfirm={async () => {
          await clearAskThreads();
          setClearOpen(false);
          openThread(null);
          refreshThreads();
          toast.success("Conversations cleared");
        }}
      />
    </div>
  );
}

function History({ threads, current, onOpen, onNew, onForget, onClear }: {
  threads: AskThreadCard[] | null; current: string | null; onOpen: (id: string) => void; onNew: () => void;
  onForget: (t: AskThreadCard) => void; onClear: () => void;
}) {
  return (
    <div className={s.history} data-ask-history="" data-testid="ask-history">
      <button type="button" className={s.newRow} onClick={onNew}>
        <Icon name="plus" size={16} /> New chat
      </button>
      <h2 className={s.historyTitle}>Recent</h2>
      {threads === null ? (
        <p className={s.historyEmpty}><Spinner size={12} /> Loading…</p>
      ) : threads.length === 0 ? (
        <p className={s.historyEmpty}>Your questions show up here for 90 days.</p>
      ) : (
        <ul className={s.threadList}>
          {threads.map((t) => (
            <li key={t.id} className={s.threadRow}>
              <button type="button" className={cx(s.thread, t.id === current && s.threadOn)} aria-current={t.id === current || undefined}
                onClick={() => onOpen(t.id)} data-testid="ask-thread">
                <span className={cx(s.threadQ, "ph-sensitive")} dir="auto">{t.title}</span>
                <span className={s.threadMeta}>{t.turns > 1 ? `${t.turns} questions · ` : ""}{shortAgo(t.updated_at)}</span>
              </button>
              <IconButton icon="x" label={`Forget “${t.title}”`} size="sm" className={s.forget} onClick={() => onForget(t)} />
            </li>
          ))}
        </ul>
      )}
      {threads && threads.length > 0 && (
        <button type="button" className={s.clear} onClick={onClear}>Clear all</button>
      )}
    </div>
  );
}
