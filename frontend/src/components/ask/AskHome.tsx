"use client";

/**
 * "Ask Markdrop" on the home (/dashboard, the installed app's start page): the one assistant
 * (components/assistant) as the first thing on the page, asking across everything the person can open.
 *
 * The same chat and the same conversation as the ✦ Ask panel: a question asked here continues on a page
 * with ⌘J, and back. Suggested questions (catch me up, my action items, the newest meeting), recent
 * conversations (open, forget, clear). The open conversation is in the URL (?ask=<id>) for reload / share
 * with yourself; ⌘J on the home focuses this box.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog, Icon, IconButton, cx } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { useLocationSearch, useMounted } from "@/components/shell/useLocation";
import { Chat } from "@/components/chat";
import type { ChatHandle, ChatSuggestion } from "@/components/chat/types";
import { askHome, clearAskThreads, deleteAskThread, type AskHomeData } from "@/lib/ask";
import { SUGGESTION_ICONS } from "@/lib/askCore.mjs";
import { shortAgo } from "@/lib/searchCore.mjs";
import { PERSIST_KEY, setAssistantThread, useAssistant, useAssistantHere, useHomeFocus } from "@/components/assistant/store";
import { assistantTransport, loadAssistantThread } from "@/components/assistant/transport";
import s from "./ask.module.css";

const RECENT_SHOWN = 5;
const SCOPE = { kind: "everything" };
const CONTEXT = { ctx: null };

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
  const { threadId } = useAssistant();
  const chat = useRef<ChatHandle>(null);
  const [home, setHome] = useState<AskHomeData | null>(null);
  const [homeFailed, setHomeFailed] = useState(false);
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [chatKey, setChatKey] = useState(0);

  useAssistantHere({ home: true });
  const focus = useCallback(() => {
    document.getElementById("md-ask-home")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    chat.current?.focus();
  }, []);
  useHomeFocus(focus);

  const refreshHome = useCallback(() => {
    askHome().then((h) => { setHome(h); setHomeFailed(false); }).catch(() => setHomeFailed(true));
  }, []);
  useEffect(() => { refreshHome(); }, [refreshHome]);

  const setAskParam = useCallback((id: string | null) => {
    const p = new URLSearchParams(window.location.search);
    if (id) p.set("ask", id); else p.delete("ask");
    const qs = p.toString();
    router.replace(`${window.location.pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [router]);

  /** Show another saved conversation (the chat starts again on it). */
  const switching = useRef(false);
  const openThread = useCallback((id: string | null) => {
    switching.current = true;
    chat.current?.newChat();
    switching.current = false;
    setAssistantThread(id);
    setChatKey((k) => k + 1);
  }, []);

  // ?ask=<id> opens that conversation (unless it's the one already open).
  useEffect(() => {
    if (urlThread && urlThread !== threadId) openThread(urlThread);
  }, [urlThread]); // eslint-disable-line react-hooks/exhaustive-deps

  const onThread = useCallback((id: string | null) => {
    if (switching.current) return;
    setAssistantThread(id);
    setAskParam(id);
    if (id) refreshHome();
  }, [setAskParam, refreshHome]);

  const suggestions = useMemo<ChatSuggestion[]>(() => (home?.suggestions ?? []).map((x) => ({
    q: x.question, icon: (SUGGESTION_ICONS as Record<string, string>)[x.intent] || "sparkle",
  })), [home]);
  const enabled = home?.status.enabled !== false;
  const recent = home?.recent || [];
  const recentShown = showAllRecent ? recent : recent.slice(0, RECENT_SHOWN);

  return (
    <section id="md-ask-home" className={s.ask} aria-labelledby="md-ask-title" data-testid="ask-home">
      <header className={s.head}>
        <h2 id="md-ask-title" className={s.title}>
          <span className={s.spark} aria-hidden><Icon name="sparkle" size={14} /></span>
          Ask Markdrop
        </h2>
        <span className={s.hint} aria-hidden>Anywhere: <kbd>⌘J</kbd></span>
      </header>
      <div className={s.chat}>
        <Chat
          key={chatKey}
          ref={chat}
          layout="panel"
          persistKey={PERSIST_KEY}
          transport={assistantTransport as never}
          scope={SCOPE}
          context={CONTEXT}
          threadId={threadId}
          onThreadChange={onThread}
          loadThread={loadAssistantThread}
          suggestions={suggestions}
          empty={{ icon: "sparkle", title: "Ask about your work", sub: "Meetings, documents, pages, files and Guides — only what you can open, with sources." }}
          placeholder={enabled ? "Ask about your meetings, docs, pages and files…" : home?.status.message || "AI isn't available right now."}
          banner={!enabled && home?.status.message ? <p className={s.note} role="status">{home.status.message}</p> : null}
          footnote="Answers use only what you can open. AI can be wrong."
          assistantName="Ask Markdrop"
          maxLength={500}
          testId="ask-home-chat"
        />
      </div>
      {homeFailed && !home && <p className={s.note}>Couldn&apos;t load suggestions. <button type="button" className={s.linkBtn} onClick={refreshHome}>Try again</button></p>}
      {recent.length > 0 && (
        <div className={s.recent}>
          <div className={s.recentHead}>
            <h3 className={s.recentTitle}>Recent conversations</h3>
            <button type="button" className={s.linkBtn} onClick={() => setClearOpen(true)}>Clear</button>
          </div>
          <ul className={s.recentList}>
            {recentShown.map((r) => (
              <li key={r.id} className={s.recentRow}>
                <button type="button" className={cx(s.recentOpen, r.id === threadId && s.recentOn)} aria-current={r.id === threadId || undefined}
                  onClick={() => { openThread(r.id); setAskParam(r.id); }}>
                  <Icon name="message" size={14} className={s.recentIcon} />
                  <span className={cx(s.recentQ, "ph-sensitive")} dir="auto">{r.title}</span>
                  <span className={s.recentMeta}>{r.turns > 1 ? `${r.turns} questions · ` : ""}{shortAgo(r.updated_at)}</span>
                </button>
                <IconButton icon="x" label={`Forget “${r.title}”`} size="sm" className={s.recentDel}
                  onClick={async () => {
                    try {
                      await deleteAskThread(r.id);
                      if (r.id === threadId) { openThread(null); setAskParam(null); }
                      refreshHome();
                    } catch { toast.error("Couldn't remove it. Try again."); }
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
      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        title="Clear recent conversations?"
        body={<p className="text-body text-text-secondary">Every conversation you had with Ask Markdrop is deleted, here and in the ✦ Ask panel. Your documents aren&apos;t touched.</p>}
        confirmLabel="Clear"
        onConfirm={async () => { await clearAskThreads(); setClearOpen(false); openThread(null); setAskParam(null); refreshHome(); toast.success("Recent conversations cleared"); }}
      />
    </section>
  );
}
