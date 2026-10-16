"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert, Badge, Button, ConfirmDialog, Drawer, EmptyState, Pagination, Progress, RowMenu, Tabs, cx, useToast,
} from "@/components/ui";
import {
  adminDeleteFeedback, adminListFeedback, adminSetFeedbackStatus,
  type AdminFeedbackItem, type FeedbackType,
} from "@/lib/api";
import { PageHead, fmtDateTime, isUnauthorized, plural, useOnUnauthorized, LoadingBlock } from "./shared";

type Status = "open" | "resolved" | "";

function TypeBadge({ type }: { type: FeedbackType }) {
  return type === "bug"
    ? <Badge size="sm" tone="neutral" icon="bug">Bug</Badge>
    : <Badge size="sm" tone="info" icon="bulb">Feature</Badge>;
}

function useWide() {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

export function FeedbackPanel({ token, onChanged }: { token: string; onChanged: () => void }) {
  const onUnauthorized = useOnUnauthorized();
  const toast = useToast();
  const wide = useWide();
  const [status, setStatus] = useState<Status>("open");
  const [type, setType] = useState<FeedbackType | "">("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AdminFeedbackItem[] | null>(null);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [openCount, setOpenCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<AdminFeedbackItem | null>(null);
  const [sheet, setSheet] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const r = await adminListFeedback(token, page, type || undefined, status || undefined);
      setItems(r.items);
      setPages(r.pages);
      setTotal(r.total);
      setOpenCount(r.open_count);
      setSelected((s) => (s && r.items.some((i) => i.id === s) ? s : r.items[0]?.id ?? null));
    } catch (e) {
      if (isUnauthorized(e)) onUnauthorized();
      else setError(true);
    } finally {
      setLoading(false);
    }
  }, [token, page, type, status, onUnauthorized]);
  useEffect(() => { void load(); }, [load]);

  const current = items?.find((i) => i.id === selected) ?? null;

  const setResolved = async (f: AdminFeedbackItem, resolved: boolean) => {
    setBusy(true);
    try {
      await adminSetFeedbackStatus(token, f.id, resolved ? "resolved" : "open");
      toast.success(resolved ? "Marked resolved" : "Reopened");
      onChanged();
      await load();
    } catch (e) {
      if (isUnauthorized(e)) onUnauthorized();
      else toast.error("Couldn't update the feedback. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (f: AdminFeedbackItem) => {
    try {
      await adminDeleteFeedback(token, f.id);
    } catch (e) {
      if (isUnauthorized(e)) { onUnauthorized(); return; }
      throw new Error("Couldn't delete the feedback. Check your connection and try again.");
    }
    setConfirm(null);
    setSheet(false);
    toast.success("Feedback deleted");
    onChanged();
    await load();
  };

  const detail = current && (
    <article className="flex min-w-0 flex-col gap-4" aria-labelledby="fb-detail-h">
      <div className="flex flex-wrap items-center gap-2">
        <TypeBadge type={current.type} />
        {current.status === "resolved" && <Badge size="sm" tone="success" icon="check">Resolved</Badge>}
        <span className="text-caption text-text-muted">{fmtDateTime(current.created_at)}</span>
        <span className="ml-auto"><RowMenu label="More feedback actions" align="right" items={[{ label: "Delete feedback", icon: "trash", danger: true, onClick: () => setConfirm(current) }]} /></span>
      </div>
      <h2 id="fb-detail-h" className="md-visually-hidden">Feedback detail</h2>
      <p className="whitespace-pre-wrap break-words text-body-lg text-text" dir="auto">{current.message}</p>
      <dl className="flex flex-col gap-2 text-caption">
        <div className="flex flex-wrap gap-x-2"><dt className="text-text-muted">From</dt><dd className="min-w-0 break-all text-text-secondary">
          {current.user_email ?? current.email ?? "Anonymous"}
          {current.user_email && current.email && current.email !== current.user_email && <> · reply to {current.email}</>}
        </dd></div>
        {current.page_url && (
          <div className="flex flex-wrap gap-x-2"><dt className="text-text-muted">Page</dt><dd className="min-w-0"><code className="break-all rounded-sm bg-surface-inset px-1 font-mono text-micro text-text">{current.page_url}</code></dd></div>
        )}
        {current.user_agent && (
          <div className="flex flex-wrap gap-x-2"><dt className="text-text-muted">Browser</dt><dd className="min-w-0 break-all text-text-secondary">{current.user_agent}</dd></div>
        )}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button variant={current.status === "resolved" ? "secondary" : "primary"} loading={busy} iconLeft={current.status === "resolved" ? "rotate" : "check"}
          onClick={() => setResolved(current, current.status !== "resolved")}>
          {current.status === "resolved" ? "Reopen" : "Mark resolved"}
        </Button>
        {(current.email || current.user_email) && (
          <Button variant="secondary" iconLeft="mail" href={`mailto:${current.email ?? current.user_email}`}>Reply by email</Button>
        )}
      </div>
    </article>
  );

  return (
    <>
      <PageHead title="Feedback" caption={`${plural(openCount, "open item")} · ${plural(total, "item")} in this view.`} />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="px-1">
          <Tabs aria-label="Status" value={status} onChange={(v) => { setStatus(v as Status); setPage(1); }}
            items={[{ value: "open", label: "Open", count: openCount }, { value: "resolved", label: "Resolved" }, { value: "", label: "All" }]} />
        </div>
        <Tabs variant="pill" size="sm" aria-label="Type" value={type} onChange={(v) => { setType(v as FeedbackType | ""); setPage(1); }}
          items={[{ value: "", label: "All" }, { value: "bug", label: "Bugs" }, { value: "feature", label: "Features" }]} />
      </div>
      {loading && items && <Progress indeterminate size="sm" aria-label="Updating feedback" valueText="Loading" className="mb-2" />}

      {error ? (
        <Alert tone="danger" title="Couldn't load feedback" actions={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>
          Check that the API is reachable, then retry.
        </Alert>
      ) : !items ? (
        <LoadingBlock size="md" label="Loading feedback" minHeight={360} />
      ) : items.length === 0 ? (
        <EmptyState icon="message" title={status === "open" ? "No open feedback." : status === "resolved" ? "Nothing resolved yet." : "No feedback yet."} />
      ) : (
        <div className="grid min-w-0 gap-4 lg:grid-cols-[400px_minmax(0,1fr)]">
          <div className="min-w-0">
            <ul className="flex flex-col gap-1.5" aria-label="Feedback">
              {items.map((f) => {
                const on = f.id === selected;
                return (
                  <li key={f.id}>
                    <button type="button" aria-current={on && wide ? "true" : undefined}
                      onClick={() => { setSelected(f.id); if (!wide) setSheet(true); }}
                      className={cx("md-focus flex w-full min-w-0 flex-col gap-1.5 rounded-xl border p-3 text-left transition-colors duration-(--duration-fast)",
                        on && wide ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-surface-hover")}>
                      <span className="flex items-center gap-2">
                        <TypeBadge type={f.type} />
                        {f.status === "resolved" && <Badge size="sm" tone="success" icon="check">Resolved</Badge>}
                        <span className="ml-auto shrink-0 text-micro text-text-muted">{fmtDateTime(f.created_at)}</span>
                      </span>
                      <span className="line-clamp-2 text-body text-text" dir="auto">{f.message}</span>
                      <span className="truncate text-caption text-text-muted">{f.user_email ?? f.email ?? "Anonymous"}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {pages > 1 && <Pagination className="mt-3" page={page} pageCount={pages} onChange={setPage} />}
          </div>
          {wide && (
            <div className="min-w-0 self-start rounded-xl border border-border bg-surface p-5 lg:sticky lg:top-8">
              {detail ?? <p className="text-body text-text-muted">Choose an item to read it.</p>}
            </div>
          )}
        </div>
      )}

      {!wide && (
        <Drawer open={sheet && !!current} onClose={() => setSheet(false)} side="bottom" title="Feedback">
          {detail}
        </Drawer>
      )}

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => (confirm ? remove(confirm) : undefined)}
        title="Delete this feedback?"
        body={<p className="text-body text-text-secondary">It&apos;s removed for good. Mark it resolved instead if you might need it later.</p>}
        confirmLabel="Delete feedback"
      />
    </>
  );
}
