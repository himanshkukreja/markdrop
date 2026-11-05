"use client";

/**
 * "Ask Markdrop": the one assistant, as a side panel (non-modal: the page stays usable beside it) or, on
 * phones, a bottom sheet. Opened by ✦ Ask in the top bar or ⌘J from anywhere (AssistantRoot).
 *
 *  - Scope chips at the top: This doc · Meetings · This folder · Workspace · Everything (only what the
 *    person can open here, GET /api/v1/ask/context); widen or narrow at any time. Meetings adds chips in
 *    the composer: this meeting / all, a series, a period.
 *  - One conversation across screens: the thread id is kept (store) and the chat's turns follow the
 *    person from the home to a page and back; a reload reads the thread from the server.
 *  - In a doc, the question carries where the reader is (section, selection). "Insert" puts an answer
 *    into the doc at the caret, with its citations as links — editors only, and only when they click it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, Spinner, cx, useToast } from "@/components/ui";
import { Chat } from "@/components/chat";
import type { ChatHandle, ChatScope, ChatTurn } from "@/components/chat/types";
import { PHONE_QUERY, useMediaQuery } from "@/components/kit/publish-utils";
import { getAssistantContext, type AssistantContext, type AssistantScopeKind } from "@/lib/ask";
import { track } from "@/lib/track";
import { initialScope, meetingOptions, scopeChips, starters } from "./assistantCore.mjs";
import { PERSIST_KEY, closeAssistant, setAssistantThread, takePending, useAssistant } from "./store";
import { assistantTransport, loadAssistantThread, type AssistantChatContext } from "./transport";
import "./assistant.css";

const FOOT = "Answers use only what you can open. AI can be wrong.";

export function AssistantPanel() {
  const { open, here, insert, threadId } = useAssistant();
  const phone = useMediaQuery(PHONE_QUERY);
  const toast = useToast();
  const chat = useRef<ChatHandle>(null);
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [ctx, setCtx] = useState<AssistantContext | null>(null);
  const [failed, setFailed] = useState(false);
  const [scope, setScope] = useState<ChatScope>({ kind: "everything" });
  const hereKey = JSON.stringify(here ?? {});
  const ctxFor = useRef<string | null>(null);

  // What the assistant offers here (the scopes you can open), once per place.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setFailed(false);
    const same = ctxFor.current === hereKey;
    if (!same) setCtx(null); // another place: its own chips, not the last one's
    ctxFor.current = hereKey;
    const h = here ?? {};
    getAssistantContext({ page: h.page, workspace: h.workspace, folder: h.folder, meeting: h.meeting })
      .then((c) => {
        if (!live) return;
        setCtx(c);
        const pend = takePending();
        // Reopened in the same place: the chip picked last stays (unless something asked for one).
        if (!same || pend?.scope) {
          const kind = initialScope(c, pend?.scope ?? h.scope ?? null);
          // On a meeting (its page, its transcript, or named), Meetings starts on This meeting.
          setScope({ kind, meeting: c.meeting && (h.meeting || c.page?.meeting_id) ? "this" : "" });
        }
        if (pend?.question) window.setTimeout(() => chat.current?.ask(pend.question!), 0);
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [open, hereKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opening: remember who opened it (focus goes back there), focus the question (not on phones).
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!phone) window.setTimeout(() => chat.current?.focus(), 80);
    track("assistant_open", { where: here?.page ? "doc" : here?.meeting ? "meeting" : here?.folder ? "folder" : here?.workspace ? "workspace" : here?.home ? "home" : "other" });
    return () => {
      const el = opener.current;
      if (el && document.contains(el)) window.setTimeout(() => el.focus({ preventScroll: true }), 0);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // A pending question arriving while open (From meetings › Ask about this).
  const { pending } = useAssistant();
  useEffect(() => {
    if (!open || !ctx || !pending) return;
    const p = takePending();
    if (p?.scope && scopeChips(ctx).some((s) => s.kind === p.scope)) setScope((s) => ({ ...s, kind: p.scope! }));
    if (p?.question) window.setTimeout(() => chat.current?.ask(p.question!), 0);
  }, [open, ctx, pending]);

  // Phones: the sheet rides above the keyboard.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!phone || !open || !vv) return;
    const fit = () => panel.current?.style.setProperty("--as-kb", `${Math.round(Math.max(0, window.innerHeight - vv.height - vv.offsetTop))}px`);
    fit();
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    return () => {
      vv.removeEventListener("resize", fit);
      vv.removeEventListener("scroll", fit);
    };
  }, [phone, open]);

  const kind = (scope.kind || "everything") as AssistantScopeKind;
  // No chips until the place is known (a guess would flash "Everything" first).
  const chips = useMemo(() => (ctx || failed ? scopeChips(ctx) : []), [ctx, failed]);
  const options = useMemo(() => (kind === "meetings" ? meetingOptions(ctx) : undefined), [kind, ctx]);
  const status = kind === "meetings" ? ctx?.status.meetings : ctx?.status.search;
  const context = useMemo<AssistantChatContext>(() => ({ ctx }), [ctx]);
  const suggestions = useMemo(() => starters(kind, ctx), [kind, ctx]);

  const canInsert = !!ctx?.can_insert && !!insert;
  const onInsert = useCallback(async (markdown: string) => {
    const fn = insert;
    if (!fn) return;
    const ok = await Promise.resolve(fn(markdown)).catch(() => false);
    if (ok) {
      toast.success("Inserted into the doc, with its sources as links");
      track("assistant_insert", { scope: kind });
    } else {
      toast.info("Click in the doc where it should go, then Insert again.");
    }
  }, [insert, toast, kind]);

  const close = useCallback(() => closeAssistant(), []);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      close();
    }
  };
  const followUps = useCallback((t: ChatTurn) => (t.citations.length && kind !== "meetings" && ctx?.workspace
    ? ["What did the meetings say about this?"] : []), [kind, ctx]);

  if (!open) return null;
  const layout = phone ? "sheet" : "panel";
  return (
    <>
      {phone && <div className="as-scrim" onClick={close} aria-hidden />}
      <aside
        ref={panel}
        className="as-panel no-print"
        data-layout={layout}
        role="dialog"
        aria-modal={phone ? true : undefined}
        aria-label="Ask Markdrop"
        onKeyDown={onKey}
        data-testid="assistant"
      >
        <header className="as-head">
          <span className="as-head__title"><span className="as-head__glyph" aria-hidden><Icon name="sparkle" /></span>Ask Markdrop</span>
          <kbd className="as-head__kbd" aria-hidden>{shortcutLabel()}</kbd>
          <button type="button" className="as-icon" onClick={close} aria-label="Close Ask Markdrop" title="Close (Esc)" data-testid="assistant-close">
            <Icon name="x" />
          </button>
        </header>
        <div className="as-scopes" role="radiogroup" aria-label="Answer from" data-testid="assistant-scopes">
          {!ctx && !failed && <span className="as-scopes__wait"><Spinner size={12} /> Finding what you can ask about…</span>}
          {failed && <span className="as-scopes__wait">Couldn&apos;t check this place. Everything you can open is used.</span>}
          {chips.map((c) => (
            <button
              key={c.kind}
              type="button"
              role="radio"
              aria-checked={kind === c.kind}
              className={cx("as-scope", kind === c.kind && "as-scope--on")}
              onClick={() => { setScope((s) => ({ ...s, kind: c.kind })); track("assistant_scope", { scope: c.kind }); }}
              title={c.sub ? `${c.label} · ${c.sub}` : c.label}
              data-testid={`assistant-scope-${c.kind}`}
            >
              <Icon name={c.icon} />
              <span>{c.label}</span>
            </button>
          ))}
        </div>
        <Chat
          ref={chat}
          layout={layout}
          persistKey={PERSIST_KEY}
          transport={assistantTransport as never}
          scope={scope}
          scopeOptions={options}
          onScopeChange={(s) => setScope(s)}
          context={context}
          threadId={threadId}
          onThreadChange={setAssistantThread}
          loadThread={loadAssistantThread}
          suggestions={suggestions}
          followUps={followUps}
          onInsert={canInsert ? (md) => void onInsert(md) : undefined}
          onNavigate={phone ? close : undefined}
          empty={{ icon: "sparkle", title: emptyTitle(kind, ctx), sub: emptySub(kind, ctx) }}
          placeholder={placeholderFor(kind)}
          banner={status && !status.enabled ? <p className="as-banner" role="status"><Icon name="clock" /> {status.message ?? "AI isn't available right now."}</p> : null}
          footnote={FOOT}
          assistantName="Ask Markdrop"
          className="as-chat"
          testId="assistant-chat"
        />
      </aside>
    </>
  );
}

/** "⌘J" on Apple keyboards, "Ctrl J" elsewhere. */
export function shortcutLabel(): string {
  if (typeof navigator === "undefined") return "⌘J";
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent) ? "⌘J" : "Ctrl J";
}

function emptyTitle(kind: AssistantScopeKind, ctx: AssistantContext | null): string {
  if (kind === "doc") return ctx?.page?.title ? `Ask about “${ctx.page.title}”` : "Ask about this doc";
  if (kind === "meetings") return ctx?.meeting?.title ? `Ask about ${ctx.meeting.title}` : "Ask your meetings";
  if (kind === "folder") return ctx?.folder?.name ? `Ask about ${ctx.folder.name}` : "Ask about this folder";
  if (kind === "workspace") return ctx?.workspace?.name ? `Ask ${ctx.workspace.name}` : "Ask this workspace";
  return "Ask Markdrop";
}

function emptySub(kind: AssistantScopeKind, ctx: AssistantContext | null): string {
  if (kind === "doc") return ctx?.workspace ? "This doc first, then what your meetings decided, then the workspace. Sources are cited." : "This doc first, then everything you can open. Sources are cited.";
  if (kind === "meetings") return "Decisions, owners and dates from the meetings you can open, with a jump to the moment.";
  if (kind === "folder") return "Only the docs, pages and files in this folder and its sub-folders.";
  if (kind === "workspace") return "The meetings, docs, pages and files of this workspace that you can open.";
  return "Your meetings, documents, pages, files and Guides — only what you can open.";
}

function placeholderFor(kind: AssistantScopeKind): string {
  if (kind === "doc") return "Ask about this doc…";
  if (kind === "meetings") return "Ask your meetings…";
  if (kind === "folder") return "Ask about this folder…";
  return "Ask anything…";
}

export default AssistantPanel;
