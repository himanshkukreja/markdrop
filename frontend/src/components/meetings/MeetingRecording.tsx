"use client";

/**
 * A meeting's Zoom recording, kept in Markdrop (Integrations › Zoom › Transcribe and keep recordings).
 * The meeting bar's "Recording" button opens it under the bar. The video plays in the files origin's video
 * player (the same one video files use), through a short-lived signed link that GET /meetings/{id}/recording
 * hands only to people who can read the meeting. The importer or a workspace admin can remove it.
 *
 * Notes ↔ video (owner, 2026-11-16): a transcript line's time, or a summary's transcript citation, plays
 * the recording from that moment (MeetingHeader passes `seek`). The first one opens the player at it
 * (?at=<seconds>); with the player already up, a {md:1, ev:"seek", t} message moves it without a reload
 * (worker/src/index.js accepts it only from the framing window on an app origin). No answer from the
 * player within a moment (an older player, a preview host): it reopens at that time instead.
 * Played from far down the page, the player floats in the corner (its place up top is kept), so the
 * transcript stays where the reader is.
 *
 * Captions and chapters (owner, 2026-11-16): the player link carries captions built from the transcript
 * (its CC button), and the response's chapters (the notes' sections) go to the player as a
 * {md:1, ev:"chapters"} message once it loads. Transcript times become video times by `offset_s` (a
 * recording stopped and started again: the kept part may start after the transcript's time 0).
 */
import { useEffect, useRef, useState } from "react";
import { fromFrameOrigin } from "@/lib/engageCore";
import { Alert, Button, ConfirmDialog, IconButton, Skeleton, useToast } from "@/components/ui";
import { themedFrameSrc } from "@/app/[slug]/artifact/frame";
import { deleteMeetingRecording, getMeetingRecording, type Meeting } from "@/lib/meetings";
import { sendViewerAccent, sendViewerChapters, useWorkspaceAccent, type ViewerChapter } from "@/lib/workspaceAccent";
import { useTheme } from "@/lib/theme";

// The same sandbox a video file's page gives the player (app/[slug]/ArtifactView.tsx).
const SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";
const SEEK_WAIT_MS = 900;

/** Where to play from: `n` changes on every request (the same time twice seeks twice). */
export type RecordingSeek = { t: number; n: number };

export function MeetingRecording({ m, seek = null, onClose, onRemoved }: {
  /** A whole meeting, or on a workspace's own domain just what the page knows (can_delete false). */
  m: Pick<Meeting, "id" | "title" | "workspace_id" | "can_delete">; seek?: RecordingSeek | null;
  onClose: () => void; onRemoved: () => void;
}) {
  const { resolved } = useTheme();
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [chapters, setChapters] = useState<ViewerChapter[]>([]);
  const offset = useRef(0);              // video time = transcript time − offset
  const [err, setErr] = useState("");
  const [confirm, setConfirm] = useState(false);
  // The time the frame was opened at (?at=, transcript time) and a key that reopens it there.
  const [at, setAt] = useState<{ t: number; k: number }>({ t: seek?.t ?? 0, k: 0 });
  const atVideo = Math.max(0, at.t - offset.current);
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  // The progress bar in the workspace's brand accent.
  const accent = useWorkspaceAccent(m.workspace_id);
  useEffect(() => { sendViewerAccent(frame.current, accent); }, [accent]);
  useEffect(() => { sendViewerChapters(frame.current, chapters); }, [chapters]);
  const alive = useRef(false);           // the player has spoken (it's loaded and listening)
  const answered = useRef(false);        // it moved after our last seek message
  const origin = url ? safeOrigin(url) : null;
  // Floating: played from the notes while its place up top is out of view.
  const wantFloat = useRef(!!seek);
  const [float, setFloat] = useState<number | null>(null);   // the kept height of its place, when floating
  const floatNow = () => {
    const el = box.current;
    if (!el || !wantFloat.current) return;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) setFloat((h) => h ?? el.offsetHeight);
  };
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([en]) => {
      if (en?.isIntersecting) setFloat(null);
      else if (wantFloat.current) setFloat((h) => h ?? el.offsetHeight);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [url]);

  // The player's own messages (lib/engage's checks): it's up; it moved.
  useEffect(() => {
    if (!origin) return;
    const onMessage = (e: MessageEvent) => {
      const f = frame.current;
      if (!f || e.source !== f.contentWindow || !fromFrameOrigin(e.origin, origin)) return;
      const d = e.data as { md?: number; ev?: string; e?: string } | null;
      if (!d || typeof d !== "object" || d.md !== 1 || d.ev !== "media") return;
      alive.current = true;
      if (d.e === "seeking" || d.e === "seeked") answered.current = true;
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin]);

  // A new time: move the open player, or (not up yet, or no answer) open it there.
  const lastN = useRef(seek?.n ?? 0);
  useEffect(() => {
    if (!seek || seek.n === lastN.current) return;
    lastN.current = seek.n;
    wantFloat.current = true;
    floatNow();
    const f = frame.current;
    if (!alive.current || !f?.contentWindow || !origin) {
      alive.current = false;
      setAt((a) => ({ t: seek.t, k: a.k + 1 }));
      return;
    }
    answered.current = false;
    f.contentWindow.postMessage({ md: 1, ev: "seek", t: Math.max(0, seek.t - offset.current), play: true }, origin);
    const timer = window.setTimeout(() => {
      if (answered.current) return;
      alive.current = false;
      setAt((a) => ({ t: seek.t, k: a.k + 1 }));
    }, SEEK_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [seek, origin]);

  useEffect(() => {
    let live = true;
    getMeetingRecording(m.id)
      .then((r) => {
        if (!live) return;
        offset.current = Number.isFinite(r.offset_s) ? Number(r.offset_s) : 0;
        setChapters(r.chapters ?? []);
        setUrl(r.player_url);
      })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : "The recording didn't load."); });
    return () => { live = false; };
  }, [m.id]);

  return (
    <div className={`mt-recording no-print${float != null ? " mt-recording--float" : ""}`} data-testid="meeting-recording" ref={box}
      style={float != null ? { minHeight: float } : undefined}>
      {err ? <Alert tone="danger">{err}</Alert> : url ? (
        <div className="mt-recording__frame">
          {float != null && (
            <IconButton icon="x" label="Close the recording" size="sm" className="mt-recording__unfloat" onClick={onClose} />
          )}
          <iframe
            key={at.k}
            ref={frame}
            src={themedFrameSrc(url, resolved ?? "light", null, null, atVideo > 0 ? atVideo : null)}
            data-at={at.t || undefined}
            sandbox={SANDBOX}
            allow="fullscreen; picture-in-picture; autoplay"
            allowFullScreen
            referrerPolicy="no-referrer"
            title={`Recording of ${m.title || "the meeting"}`}
            onLoad={() => { sendViewerAccent(frame.current, accent); sendViewerChapters(frame.current, chapters); }}
            style={{ colorScheme: resolved }}
            className="ph-no-capture block h-full w-full border-0 bg-bg"
          />
        </div>
      ) : <Skeleton width="100%" height={240} />}
      <div className="mt-recording__actions">
        <span className="text-caption text-text-muted">Only people who can open this meeting can play its recording. Click a time in the notes or the transcript to play from there{chapters.length ? ", or pick a chapter in the player" : ""}.</span>
        {m.can_delete && <Button size="sm" variant="ghost" onClick={() => setConfirm(true)} data-testid="meeting-recording-remove">Remove recording</Button>}
        <Button size="sm" variant="secondary" onClick={onClose}>Close</Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Remove the recording?"
        description="Markdrop deletes its copy of this meeting's video. The meeting, its summary and transcript stay. The recording in Zoom isn't touched."
        confirmLabel="Remove"
        onConfirm={async () => {
          await deleteMeetingRecording(m.id);
          setConfirm(false);
          toast.success("The recording is removed.");
          onRemoved();
        }}
      />
    </div>
  );
}

function safeOrigin(u: string): string | null {
  try { return new URL(u).origin; } catch { return null; }
}
