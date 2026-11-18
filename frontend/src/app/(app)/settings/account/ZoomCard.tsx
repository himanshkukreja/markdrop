"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Card, SegmentedControl, useToast } from "@/components/ui";
import { ZOOM_SHARE_LABELS, zoomMe, zoomSetMe, type ZoomMe, type ZoomShare } from "@/lib/zoom";

const HINT: Record<ZoomShare, string> = {
  auto: "Your recorded meetings come into the team on their own. Calls where everyone is from the company still wait for you.",
  ask: "Markdrop asks you (inbox and Slack) before a recorded meeting comes in, unless someone outside the company was on it.",
  never: "Markdrop never brings your recorded Zoom meetings in.",
};

/**
 * Settings › Account › Zoom (backend services/zoom_review.py): "When my Zoom meetings are recorded". Shown to
 * members of a workspace's Zoom team. Whatever the choice: a topic with "personal" or "private" never comes in,
 * a call with someone from outside the company comes in, and an internal-only call waits for the host.
 */
export function ZoomCard() {
  const toast = useToast();
  const [me, setMe] = useState<ZoomMe | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { zoomMe().then(setMe, () => setMe(null)); }, []);
  if (!me || me.teams.length === 0) return null;

  const save = async (share: ZoomShare) => {
    setBusy(true);
    try {
      setMe(await zoomSetMe(share));
      toast.success("Saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't save.");
    } finally { setBusy(false); }
  };
  const teams = me.teams.map((t) => `${t.team ?? "?"}${t.workspace ? ` (${t.workspace})` : ""}`).join(", ");

  return (
    <Card title="Zoom" id="zoom" description={`Your recorded Zoom meetings go to ${teams}.`}>
      <div className="flex min-w-0 flex-col gap-3" data-testid="zoom-me">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[13px] font-medium text-text" id="zoom-share-label">When my Zoom meetings are recorded</span>
          <div className="min-w-0 overflow-x-auto" data-testid="zoom-share">
            <SegmentedControl<ZoomShare> aria-labelledby="zoom-share-label" value={me.share} disabled={busy} size="sm"
              onChange={(v) => void save(v)}
              options={(["auto", "ask", "never"] as ZoomShare[]).map((v) => ({ value: v, label: ZOOM_SHARE_LABELS[v] }))} />
          </div>
          <p className="m-0 text-[13px] leading-5 text-text-secondary">{HINT[me.share]}</p>
          <p className="m-0 text-caption text-text-muted">
            A meeting whose Zoom topic says &ldquo;personal&rdquo; or &ldquo;private&rdquo; never comes in.
          </p>
        </div>
        {me.held > 0 && (
          <Link href="/integrations/zoom/review" className="self-start text-[13px] font-medium text-accent-text hover:underline" data-testid="zoom-me-review">
            {me.held} {me.held === 1 ? "meeting waits" : "meetings wait"} for you to decide →
          </Link>
        )}
      </div>
    </Card>
  );
}
