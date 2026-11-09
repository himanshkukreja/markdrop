"use client";

/**
 * Summarize discussion (the panel's ⋯ menu): decided / still open / waiting on whom across the item's
 * threads, each line jumping to its threads. Cached on the server until the discussion changes.
 */
import { useEffect, useState } from "react";
import { Button, Dialog, Icon, Spinner } from "@/components/ui";
import { aiSummary, type DiscussionSummary, type SummaryLine } from "@/lib/commentsReview";
import type { CommentsCtx } from "../context";
import { openDialog } from "./mount";

export function openSummary(ctx: CommentsCtx): void {
  void openDialog<null>((done) => <SummaryDialog ctx={ctx} done={() => done(null)} />);
}

function SummaryDialog({ ctx, done }: { ctx: CommentsCtx; done(): void }) {
  const [open, setOpen] = useState(true);
  const [data, setData] = useState<DiscussionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  async function load(refresh: boolean) {
    setBusy(true);
    setError(null);
    try {
      setData(await aiSummary(ctx.slug, refresh, { readPassword: ctx.readPassword ?? null }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The summary didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    setOpen(false);
    done();
  };
  const jump = (id: string) => {
    close();
    ctx.openPanel(id);
    ctx.setActive(id, { scroll: true });
  };

  const section = (title: string, icon: string, rows: SummaryLine[], empty: string) => (
    <section className="cr-sum__sec">
      <h3 className="cr-sum__h"><Icon name={icon} size={14} aria-hidden /> {title}</h3>
      {rows.length ? (
        <ul className="cr-sum__list">
          {rows.map((r, i) => (
            <li key={i}>
              {r.person && <strong>{r.person}: </strong>}
              {r.text}
              {r.threads.map((t, j) => (
                <button key={t} type="button" className="cr-sum__jump" onClick={() => jump(t)} aria-label={`Open thread ${j + 1} of this line`}>
                  {r.threads.length > 1 ? `thread ${j + 1}` : "open thread"}
                </button>
              ))}
            </li>
          ))}
        </ul>
      ) : (
        <p className="cr-sum__empty">{empty}</p>
      )}
    </section>
  );

  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      title="Discussion summary"
      description={data && !data.empty ? `${data.counts.open} open · ${data.counts.resolved} resolved in the last 30 days` : undefined}
      footer={
        <>
          {data && !data.empty && <Button variant="ghost" iconLeft="refresh" disabled={busy} onClick={() => void load(true)}>Summarize again</Button>}
          <Button variant="primary" onClick={close}>Done</Button>
        </>
      }
    >
      <div className="cr-sum" data-testid="discussion-summary" aria-busy={busy}>
        {busy && !data && (
          <p className="cr-sum__busy"><Spinner size={14} /> Reading the threads…</p>
        )}
        {error && <p className="cr-sugg__error" role="alert">{error}</p>}
        {data?.empty && <p className="cr-sum__empty">No discussion yet: nothing open, nothing resolved in the last 30 days.</p>}
        {data && !data.empty && (
          <>
            {section("Decided", "checkCircle", data.decided, "Nothing settled yet.")}
            {section("Still open", "message", data.open, "Nothing open.")}
            {section("Waiting on", "clock", data.waiting, "Nobody in particular.")}
            <p className="cr-sum__foot"><Icon name="sparkle" size={12} aria-hidden /> Written by AI from the threads. Check the threads before you act on it.</p>
          </>
        )}
      </div>
    </Dialog>
  );
}
