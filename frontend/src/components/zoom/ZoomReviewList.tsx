"use client";

/**
 * Your recorded Zoom meetings waiting for your decision (backend services/zoom_review.py): held because everyone on
 * the call is from the company, or because you chose "Ask me first". Share with the team, keep it just for you, or
 * skip it. Used by /integrations/zoom/review and by a team's Meetings › To review (`teamId`: only that Zoom team's).
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Skeleton, useToast } from "@/components/ui";
import { zoomDecide, zoomReview, type ZoomHeld } from "@/lib/zoom";

type Decision = "share" | "private" | "skip";
const DONE: Record<Decision, string> = {
  share: "Shared: it appears in Meetings within a few minutes.",
  private: "Kept just for you: it appears in your Meetings within a few minutes, private to you.",
  skip: "Skipped: Markdrop won't bring it in.",
};

export function ZoomReviewList({ workspace, teamId, emptyText = "Nothing waits for you.", onDecided }: {
  workspace?: string | null; teamId?: string | null; emptyText?: string;
  /** After a decision (the caller refreshes its list and counts). */
  onDecided?: (m: ZoomHeld, d: Decision) => void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<ZoomHeld[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [done, setDone] = useState<Record<string, Decision>>({});

  const load = useCallback(async () => {
    try {
      const got = (await zoomReview(workspace)).meetings;
      setRows(teamId ? got.filter((m) => !m.team_id || m.team_id === teamId) : got);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load your Zoom meetings.");
    }
  }, [workspace, teamId]);
  useEffect(() => { void load(); }, [load]);

  const decide = async (m: ZoomHeld, d: Decision) => {
    setBusy(`${m.uuid}:${d}`);
    try {
      await zoomDecide(m.workspace_id, m.uuid, d);
      setDone((x) => ({ ...x, [m.uuid]: d }));
      onDecided?.(m, d);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work.");
    } finally { setBusy(""); }
  };

  if (error) return <Alert tone="danger" title="Couldn't load">{error}</Alert>;
  if (!rows) return <div aria-busy="true" className="flex flex-col gap-2"><Skeleton variant="rect" height={96} /><Skeleton variant="rect" height={96} /></div>;
  if (rows.length === 0) return <Card><p className="m-0 text-body text-text-secondary" data-testid="zoom-review-empty">{emptyText}</p></Card>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="zoom-review-list">
      {rows.map((m) => (
        <li key={`${m.workspace_id}:${m.uuid}`}>
          <Card data-testid="zoom-review-row">
            <div className="flex min-w-0 flex-col gap-2">
              <div className="min-w-0">
                <h3 className="m-0 break-words text-body-strong text-text">{m.topic}</h3>
                <p className="m-0 text-caption text-text-muted">
                  {[m.date && `${m.date}${m.time ? ` ${m.time}` : ""}`, m.duration_min && `${m.duration_min} min`,
                    m.people_count && `${m.people_count} ${m.people_count === 1 ? "person" : "people"}`].filter(Boolean).join(" · ")}
                </p>
                {m.people.length > 0 && <p className="m-0 break-words text-caption text-text-secondary">{m.people.join(", ")}</p>}
                {m.why && <p className="m-0 mt-1 text-caption text-text-muted">{m.why}</p>}
              </div>
              {done[m.uuid] ? (
                <p className="m-0 text-caption text-success" role="status">{DONE[done[m.uuid]]}</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" loading={busy === `${m.uuid}:share`} disabled={!!busy} onClick={() => void decide(m, "share")}
                    data-testid="zoom-review-share">Share with {m.team}</Button>
                  <Button size="sm" variant="secondary" loading={busy === `${m.uuid}:private`} disabled={!!busy}
                    onClick={() => void decide(m, "private")} data-testid="zoom-review-private">Keep it just for me</Button>
                  <Button size="sm" variant="ghost" loading={busy === `${m.uuid}:skip`} disabled={!!busy}
                    onClick={() => void decide(m, "skip")} data-testid="zoom-review-skip">Skip</Button>
                </div>
              )}
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}

export default ZoomReviewList;
