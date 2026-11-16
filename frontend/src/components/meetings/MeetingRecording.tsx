"use client";

/**
 * A meeting's Zoom recording, kept in Markdrop (Integrations › Zoom › Transcribe and keep recordings).
 * The meeting bar's "Recording" button opens it under the bar. The video plays in the files origin's video
 * player (the same one video files use), through a short-lived signed link that GET /meetings/{id}/recording
 * hands only to people who can read the meeting. The importer or a workspace admin can remove it.
 */
import { useEffect, useState } from "react";
import { Alert, Button, ConfirmDialog, Skeleton, useToast } from "@/components/ui";
import { themedFrameSrc } from "@/app/[slug]/artifact/frame";
import { deleteMeetingRecording, getMeetingRecording, type Meeting } from "@/lib/meetings";
import { useTheme } from "@/lib/theme";

// The same sandbox a video file's page gives the player (app/[slug]/ArtifactView.tsx).
const SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

export function MeetingRecording({ m, onClose, onRemoved }: { m: Meeting; onClose: () => void; onRemoved: () => void }) {
  const { resolved } = useTheme();
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    let live = true;
    getMeetingRecording(m.id)
      .then((r) => { if (live) setUrl(r.player_url); })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : "The recording didn't load."); });
    return () => { live = false; };
  }, [m.id]);

  return (
    <div className="mt-recording no-print" data-testid="meeting-recording">
      {err ? <Alert tone="danger">{err}</Alert> : url ? (
        <div className="mt-recording__frame">
          <iframe
            src={themedFrameSrc(url, resolved ?? "light")}
            sandbox={SANDBOX}
            allow="fullscreen; picture-in-picture"
            allowFullScreen
            referrerPolicy="no-referrer"
            title={`Recording of ${m.title || "the meeting"}`}
            style={{ colorScheme: resolved }}
            className="ph-no-capture block h-full w-full border-0 bg-bg"
          />
        </div>
      ) : <Skeleton width="100%" height={240} />}
      <div className="mt-recording__actions">
        <span className="text-caption text-text-muted">Only people who can open this meeting can play its recording.</span>
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
