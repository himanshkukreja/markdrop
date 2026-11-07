"use client";

/**
 * Settings → Account → Your views of other people's items (viewer analytics, backend
 * services/doc_views.py): how many views the owners of documents and files see with your name, and
 * a way to take your name off all of them (they stay as anonymous views).
 */
import { useEffect, useState } from "react";
import { Button, Card, ConfirmDialog, useToast } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { forgetMyViewHistory, getMyViewHistory } from "@/lib/analytics";

export function ViewHistoryCard() {
  const toast = useToast();
  const [total, setTotal] = useState<number | null>(null);
  const [days, setDays] = useState(180);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getMyViewHistory()
      .then((h) => { if (live) { setTotal(h.total); setDays(h.retention_days); } })
      .catch(() => { if (live) setTotal(null); });
    return () => { live = false; };
  }, []);

  async function forget() {
    setBusy(true);
    try {
      const n = await forgetMyViewHistory();
      setTotal(0);
      setConfirm(false);
      toast.success(n ? `Your name is off ${n} view${n === 1 ? "" : "s"}.` : "There was nothing to remove.");
    } catch {
      toast.error("Couldn't do that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Your views of other people's items" id="views">
      <div className="flex min-w-0 flex-col gap-3">
        <p className="m-0 text-[13px] text-text-secondary">
          When you open someone&apos;s document or file while signed in, its owner sees your name with that view, and what you
          did in it. Views are kept for {days} days. <ReadMore topic="viewers" />
        </p>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <span className="text-body-strong text-text">
            {total == null ? " " : total === 0 ? "No views with your name" : `${total.toLocaleString("en-US")} view${total === 1 ? "" : "s"} with your name`}
          </span>
          <Button variant="secondary" size="sm" iconLeft="userX" disabled={!total} onClick={() => setConfirm(true)}>
            Take my name off them
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={forget}
        busy={busy}
        tone="default"
        title="Take your name off your views?"
        description="Owners will see these views as an anonymous visitor's. Views you make from now on still show your name while you're signed in."
        confirmLabel="Take my name off"
      />
    </Card>
  );
}
