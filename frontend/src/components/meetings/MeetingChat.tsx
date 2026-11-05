"use client";

/**
 * Asking meetings on the shared chat (components/chat):
 *
 *  - mode "one": Ask this meeting (the meeting panel). Follow-ups carry the conversation.
 *  - mode "all": Ask across meetings (the hub's Ask panel), with series / period chips in the composer.
 *
 * Citations are numbered chips that open the sources (meeting, date, series, speaker · time, the line,
 * "Jump to the moment"). The conversation is saved on the server (ask_threads) and comes back after a
 * reload: this device remembers which one (localStorage, per person and meeting / workspace).
 */
import { forwardRef, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Chat, type ChatHandle, type ChatLayout, type ChatScope } from "@/components/chat";
import type { MeetingSeries } from "@/lib/meetings";
import {
  ALL_STARTERS, MEETING_CITE, ONE_STARTERS, followUpsFor, loadMeetingThread, meetingTransport, saveThread, savedThread,
  scopeOptions, type MeetingInfo,
} from "./meetingAsk";

export interface MeetingChatProps {
  mode: "one" | "all";
  meetingId?: string;
  meeting?: MeetingInfo | null;
  workspaceId?: string;
  /** Across meetings: the series to offer as scope chips. */
  series?: MeetingSeries[];
  layout?: ChatLayout;
  emptyTitle?: ReactNode;
  emptySub?: ReactNode;
  placeholder?: string;
  banner?: ReactNode;
  onNavigate?: () => void;
  autoFocus?: boolean;
  /** Across meetings: the scope to start with (e.g. the hub's series filter). */
  initialScope?: ChatScope;
  footnote?: ReactNode;
}

export const MeetingChat = forwardRef<ChatHandle, MeetingChatProps>(function MeetingChat({
  mode, meetingId, meeting = null, workspaceId, series = [], layout = "panel", emptyTitle, emptySub, placeholder, banner,
  onNavigate, autoFocus, initialScope, footnote,
}, ref) {
  const { user } = useAuth();
  const uid = user?.id ?? null;
  const key = mode === "one" ? `m:${meetingId}` : `w:${workspaceId}`;
  const [scope, setScope] = useState<ChatScope>(() => initialScope ?? {});
  const [threadId, setThreadId] = useState<string | null>(() => (typeof window === "undefined" ? null : savedThread(uid, key)));
  // Signed in (or another meeting): the conversation this device was in there.
  useEffect(() => setThreadId(savedThread(uid, key)), [uid, key]);
  const transport = useMemo(() => (mode === "one"
    ? meetingTransport({ mode: "one", meetingId: meetingId!, meeting })
    : meetingTransport({ mode: "all", workspaceId: workspaceId! })), [mode, meetingId, workspaceId, meeting]);
  const options = useMemo(() => (mode === "all" ? scopeOptions(series) : undefined), [mode, series]);
  const onThread = useCallback((id: string | null) => { setThreadId(id); saveThread(uid, key, id); }, [uid, key]);
  const load = useCallback((id: string) => loadMeetingThread(id, mode === "one" ? meeting : null), [mode, meeting]);
  const followUps = useMemo(() => followUpsFor(mode, (mode === "one" ? ONE_STARTERS : ALL_STARTERS).map((s) => s.q)), [mode]);

  return (
    <Chat
      ref={ref}
      transport={transport}
      persistKey={key}
      layout={layout}
      scope={scope}
      scopeOptions={options}
      onScopeChange={setScope}
      threadId={threadId}
      onThreadChange={onThread}
      loadThread={load}
      suggestions={mode === "one" ? ONE_STARTERS : ALL_STARTERS}
      followUps={followUps}
      onNavigate={onNavigate}
      citePattern={MEETING_CITE}
      autoFocus={autoFocus}
      banner={banner}
      empty={{
        icon: mode === "one" ? "mic" : "sparkle",
        title: emptyTitle ?? (mode === "one" ? "Ask this meeting" : "Ask across meetings"),
        sub: emptySub ?? (mode === "one"
          ? "Answers come from the transcript and the notes, and link to the moment it was said."
          : "Decisions, owners, blockers — answers cite the meeting and the moment it was said."),
      }}
      placeholder={placeholder ?? (mode === "one" ? "Ask about this meeting…" : "Ask about any meeting…")}
      footnote={footnote ?? (mode === "one" ? "Only this meeting · AI can be wrong" : "Only meetings you can open · AI can be wrong")}
      assistantName="Markdrop AI"
      testId={mode === "one" ? "meeting-chat" : "meetings-chat"}
    />
  );
});

export default MeetingChat;
