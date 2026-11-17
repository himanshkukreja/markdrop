"use client";

/**
 * A meeting's recording on the workspace's own domain (the tenant host, components/tenant). The meeting
 * bar's other tools (Transcript, Ask, attendees) stay on markdrop.in; this is only its "Recording" button,
 * in the same bar look, opening the same player (captions, chapters, the domain's accent). The page's read
 * says `meeting.has_recording` (signed in, can read the meeting), so there's no extra call until a play:
 * GET /meetings/{id}/recording, which a tenant token may call for its own workspace only.
 * Transcript lines' times seek the video here too; a summary's citations stay links (no transcript slug).
 */
import { useState } from "react";
import { Button } from "@/components/ui";
import { MeetingRecording, type RecordingSeek } from "./MeetingRecording";
import { useRecordingSeek } from "./useRecordingSeek";
import "./meetings.css";

export function TenantRecording({ meetingId, role, title, workspaceId }: {
  meetingId: string; role?: string; title: string | null; workspaceId: string | null;
}) {
  const [playing, setPlaying] = useState(false);
  const [seek, setSeek] = useState<RecordingSeek | null>(null);
  useRecordingSeek(true, role === "transcript", null, (t) => {
    setSeek((x) => ({ t, n: (x?.n ?? 0) + 1 }));
    setPlaying(true);
  });
  const m = { id: meetingId, title, workspace_id: workspaceId ?? "", can_delete: false };
  return (
    <>
      <div className="mt-pagebar no-print" data-testid="meeting-header">
        <div className="mt-pagebar__facts" />
        <div className="mt-pagebar__actions">
          <Button size="sm" variant="secondary" iconLeft="film" aria-expanded={playing} onClick={() => setPlaying((p) => !p)}
            data-testid="meeting-recording-open">Recording</Button>
        </div>
      </div>
      {playing && (
        <MeetingRecording m={m} seek={seek} onClose={() => { setPlaying(false); setSeek(null); }}
          onRemoved={() => { setPlaying(false); setSeek(null); }} />
      )}
    </>
  );
}
