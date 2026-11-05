"use client";

/**
 * Ask across meetings, from the Meetings hub: a launcher on the hub (a question box and starter chips) that
 * opens the conversation in a panel docked on the right (desktop), as a full-screen sheet (phones and
 * tablets), or expanded to a page-wide conversation with its sources beside it. The chat itself is the
 * shared one (MeetingChat → components/chat).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, IconButton } from "@/components/ui";
import { useMediaQuery } from "@/components/kit/publish-utils";
import type { ChatHandle, ChatScope } from "@/components/chat";
import type { MeetingSeries } from "@/lib/meetings";
import { MeetingChat } from "./MeetingChat";
import { ALL_STARTERS } from "./meetingAsk";

const SHEET_QUERY = "(max-width: 899px)";

export function AskMeetingsDock({ workspaceId, series, aiMessage, count }: {
  workspaceId: string;
  series: MeetingSeries[];
  /** Why AI is off here (null: on). */
  aiMessage: string | null;
  count: number;
}) {
  const sheet = useMediaQuery(SHEET_QUERY);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [mounted, setMounted] = useState(false);
  const chat = useRef<ChatHandle>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const pending = useRef<string | null>(null);
  useEffect(() => setMounted(true), []);

  const [used, setUsed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const show = useCallback((question?: string) => {
    pending.current = question ?? null;
    setUsed(true);
    setOpen(true);
    setNonce((n) => n + 1);
  }, []);
  // Opened (the chat is mounted now): ask the question picked, or put the cursor in the box.
  useEffect(() => {
    if (!open) return;
    const q = pending.current;
    pending.current = null;
    if (q) chat.current?.ask(q);
    else if (!sheet) chat.current?.focus();
  }, [open, nonce, sheet]);
  const close = useCallback(() => {
    setOpen(false);
    setExpanded(false);
    window.setTimeout(() => launcher.current?.focus({ preventScroll: true }), 0);
  }, []);
  // ?ask=1 opens it (links from elsewhere).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("ask") === "1") show();
  }, [show]);
  // The page behind a sheet or an expanded chat doesn't scroll.
  useEffect(() => {
    if (!open || !(sheet || expanded)) return;
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => { document.documentElement.style.overflow = prev; };
  }, [open, sheet, expanded]);

  const layout = sheet ? "sheet" : expanded ? "page" : "panel";
  const scope: ChatScope = {};

  return (
    <>
      <section className="mt-asklaunch" aria-label="Ask across meetings" data-testid="ask-across">
        <button ref={launcher} type="button" className="mt-asklaunch__box" onClick={() => show()} aria-haspopup="dialog" aria-expanded={open}
          data-testid="ask-across-open">
          <span className="mt-asklaunch__glyph" aria-hidden><Icon name="sparkle" /></span>
          <span className="mt-asklaunch__text">
            <span className="mt-asklaunch__ph">Ask anything about {count === 1 ? "this meeting" : `your ${count} meetings`}…</span>
            <span className="mt-asklaunch__hint">{aiMessage ?? "Decisions, owners, blockers — with links to the moment it was said"}</span>
          </span>
          <span className="mt-asklaunch__go" aria-hidden><Icon name="arrowUp" /></span>
        </button>
        <div className="mt-asklaunch__chips" role="group" aria-label="Suggested questions">
          {ALL_STARTERS.slice(0, 3).map((s) => (
            <button key={s.q} type="button" className="mt-asklaunch__chip" onClick={() => show(s.q)}>
              <Icon name={s.icon} /><span>{s.q}</span>
            </button>
          ))}
        </div>
      </section>
      {mounted && createPortal(
        <div className="mt-dock" data-open={open ? "" : undefined} data-layout={layout} inert={!open}>
          {(sheet || expanded) && <div className="mt-dock__scrim" onClick={close} aria-hidden />}
          <section className="mt-dock__panel" role="dialog" aria-modal={sheet || expanded || undefined} aria-labelledby="mt-dock-title"
            onKeyDown={(e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.stopPropagation(); close(); } }}
            data-testid="ask-across-panel">
            <header className="mt-dock__head">
              <span className="mt-dock__glyph" aria-hidden><Icon name="sparkle" /></span>
              <div className="mt-dock__titles">
                <h2 id="mt-dock-title">Ask across meetings</h2>
                <p>Markdrop AI · {count} {count === 1 ? "meeting" : "meetings"} you can open</p>
              </div>
              {!sheet && (
                <IconButton icon={expanded ? "minimize" : "expand"} label={expanded ? "Back to the side panel" : "Expand"} size="sm"
                  onClick={() => setExpanded((x) => !x)} data-testid="ask-across-expand" />
              )}
              <IconButton icon="x" label="Close" size="sm" onClick={close} />
            </header>
            {used && (
              <MeetingChat ref={chat} mode="all" workspaceId={workspaceId} series={series} layout={layout} initialScope={scope}
                onNavigate={sheet ? close : undefined} autoFocus={!sheet} />
            )}
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}

export default AskMeetingsDock;
