"use client";

/**
 * A kept recording: the times in the notes play it from there (a summary's transcript citation, a
 * transcript line's "12:34 · Ada"). Reading view only (never inside the editor); a modified click keeps
 * the link's own behaviour. Capture phase, so the page's link handling never navigates first.
 * Used by the meeting bar (MeetingPanel.tsx) and, on a workspace's own domain, TenantRecording.tsx
 * (there without the transcript's slug: transcript lines seek, summary citations stay links).
 */
import { useEffect, useRef } from "react";
import { track } from "@/lib/track";
import { citeSeconds, lineSeconds } from "./recordingSeek.mjs";

export function useRecordingSeek(enabled: boolean, onTranscript: boolean, transcriptSlug: string | null,
                                 onSeek: (t: number) => void): void {
  const cb = useRef(onSeek);
  useEffect(() => { cb.current = onSeek; });
  useEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    root.dataset.mtRec = onTranscript ? "transcript" : "summary";
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const el = e.target instanceof Element ? e.target : null;
      if (!el || !el.closest(".pb-body") || el.closest('[contenteditable="true"]')) return;
      let t: number | null = null;
      if (onTranscript) {
        const lead = el.closest("strong");
        const block = lead?.parentElement?.closest<HTMLElement>("[data-bid]");
        if (lead && block && lead.parentElement === block && block.firstElementChild === lead) t = lineSeconds(block.dataset.bid, lead.textContent);
      } else {
        const a = el.closest("a");
        if (a) t = citeSeconds(a.getAttribute("href"), a.textContent, transcriptSlug, window.location.origin);
      }
      if (t == null) return;
      e.preventDefault();
      e.stopPropagation();
      cb.current(t);
      track("meeting_recording_seek", { from: onTranscript ? "transcript" : "summary" });
    };
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      delete root.dataset.mtRec;
    };
  }, [enabled, onTranscript, transcriptSlug]);
}
