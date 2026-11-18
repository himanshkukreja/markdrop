"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { Alert, Button, Card, Skeleton, useToast } from "@/components/ui";
import { zoomDecide, zoomReview, type ZoomHeld } from "@/lib/zoom";

type Decision = "share" | "private" | "skip";
const DONE: Record<Decision, string> = {
  share: "Shared: it appears in Meetings within a few minutes.",
  private: "Kept just for you: it appears in your Meetings within a few minutes, private to you.",
  skip: "Skipped: Markdrop won't bring it in.",
};

/**
 * Your recorded Zoom meetings that wait for your decision (backend services/zoom_review.py): held because everyone
 * on the call is from the company, or because you chose "Ask me first". Only metadata is kept until you decide
 * (nothing downloaded) and only you see them. Share with the team, keep it just for you, or skip it. They expire
 * after 30 days. `?workspace=` narrows to one workspace (the inbox and Slack links pass it).
 */
export default function ZoomReviewClient() {
  const params = useSearchParams();
  const ws = params.get("workspace");
  const { user, loading } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState<ZoomHeld[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [done, setDone] = useState<Record<string, Decision>>({});
  const redirected = useRef(false);

  const load = useCallback(async () => {
    try {
      setRows((await zoomReview(ws)).meetings);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load your Zoom meetings.");
    }
  }, [ws]);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      if (!redirected.current) {
        redirected.current = true;
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
      }
      return;
    }
    void load();
  }, [loading, user, load]);

  const decide = async (m: ZoomHeld, d: Decision) => {
    setBusy(`${m.uuid}:${d}`);
    try {
      await zoomDecide(m.workspace_id, m.uuid, d);
      setDone((x) => ({ ...x, [m.uuid]: d }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work.");
    } finally { setBusy(""); }
  };

  return (
    <div className="flex w-full max-w-[680px] min-w-0 flex-col gap-4" data-testid="zoom-review">
      <div>
        <h1 className="text-h2 text-text">Zoom meetings to review</h1>
        <p className="mt-1 text-[13px] leading-5 text-text-secondary">
          These recorded meetings wait for you. Until you decide, Markdrop keeps only their topic, time and who joined,
          and only you see them. They expire after 30 days (Zoom keeps the recording).{" "}
          <Link href="/settings/account#zoom" className="text-accent-text hover:underline">Change when Markdrop asks</Link>
        </p>
      </div>
      {error && <Alert tone="danger" title="Couldn't load">{error}</Alert>}
      {!rows && !error && <Skeleton width="70%" height={16} />}
      {rows && rows.length === 0 && (
        <Card><p className="m-0 text-[13px] text-text-secondary" data-testid="zoom-review-empty">Nothing waits for you.</p></Card>
      )}
      {rows?.map((m) => (
        <Card key={`${m.workspace_id}:${m.uuid}`} data-testid="zoom-review-row">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="min-w-0">
              <h2 className="break-words text-body-strong text-text">{m.topic}</h2>
              <p className="m-0 text-[13px] text-text-muted">
                {[m.date && `${m.date}${m.time ? ` ${m.time}` : ""}`, m.duration_min && `${m.duration_min} min`,
                  m.people_count && `${m.people_count} ${m.people_count === 1 ? "person" : "people"}`].filter(Boolean).join(" · ")}
              </p>
              {m.people.length > 0 && <p className="m-0 break-words text-[13px] text-text-secondary">{m.people.join(", ")}</p>}
              {m.why && <p className="m-0 mt-1 text-caption text-text-muted">{m.why}</p>}
            </div>
            {done[m.uuid] ? (
              <p className="m-0 text-[13px] text-success" role="status">{DONE[done[m.uuid]]}</p>
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
      ))}
    </div>
  );
}
