"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar, Button, EmptyState, Icon, RowMenu, SegmentedControl, Skeleton, Textarea, cx, useToast } from "@/components/ui";
import { docsErrorMessage } from "@/lib/docsSites";
import {
  addComment, deleteComment, listComments, replyToComment, resolveComment, type PageComment,
} from "@/lib/guideEditor";
import type { TextAnchor } from "@/components/docs-editor";
import { timeAgo } from "../format";

/**
 * A page's review comments: loaded with the page and every 30 s while it's open (other people
 * comment too), plus the actions. Everything here is the team's words: shown inside ph-no-capture.
 */
export function usePageComments(siteId: string, pageId: string | null, enabled: boolean) {
  const [comments, setComments] = useState<PageComment[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!pageId || !enabled) return;
    try {
      const r = await listComments(siteId, pageId);
      setComments(r.comments);
      setError("");
    } catch (e) {
      setError(docsErrorMessage(e, "Couldn't load the comments."));
    }
  }, [siteId, pageId, enabled]);
  useEffect(() => {
    setComments(null);
    void load();
  }, [load]);
  useEffect(() => {
    if (!enabled || !pageId) return;
    const id = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    return () => window.clearInterval(id);
  }, [load, enabled, pageId]);
  const put = (c: PageComment) => setComments((cur) => (cur ? cur.map((x) => (x.id === c.id ? c : x)) : cur));
  return {
    comments,
    error,
    reload: load,
    open: comments?.filter((c) => !c.resolved).length ?? 0,
    async add(anchor: TextAnchor, body: string) {
      if (!pageId) return null;
      const c = await addComment(siteId, pageId, { ...anchor, body });
      setComments((cur) => [...(cur ?? []), c]);
      return c;
    },
    async reply(id: string, body: string) {
      if (!pageId) return;
      put(await replyToComment(siteId, pageId, id, body));
    },
    async resolve(id: string, resolved: boolean) {
      if (!pageId) return;
      put(await resolveComment(siteId, pageId, id, resolved));
    },
    async remove(id: string) {
      if (!pageId) return;
      await deleteComment(siteId, pageId, id);
      setComments((cur) => cur?.filter((x) => x.id !== id) ?? cur);
    },
  };
}

export type CommentsApi = ReturnType<typeof usePageComments>;

function Composer({ placeholder, submitLabel, onSubmit, onCancel, autoFocus }: {
  placeholder: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  const send = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await onSubmit(text);
      setBody("");
    } catch (e) {
      toast.error(docsErrorMessage(e, "The comment wasn't saved."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        ref={ref}
        rows={2}
        value={body}
        maxLength={4000}
        placeholder={placeholder}
        aria-label={placeholder}
        className="ph-no-capture"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          } else if (e.key === "Escape" && onCancel) {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" loading={busy} disabled={!body.trim()} onClick={() => void send()}>{submitLabel}</Button>
        {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
        <span className="ml-auto text-[12px] text-text-muted max-sm:hidden">⌘ Enter to send</span>
      </div>
    </div>
  );
}

function Quote({ text, onClick }: { text: string; onClick?: () => void }) {
  const inner = <span className="line-clamp-2 text-left">{text}</span>;
  return onClick ? (
    <button type="button" onClick={onClick} title="Show in the page" className="md-focus block w-full rounded border-l-2 border-warning bg-surface-inset px-2 py-1 text-[12px] leading-[18px] text-text-secondary hover:text-text">
      {inner}
    </button>
  ) : (
    <span className="block rounded border-l-2 border-warning bg-surface-inset px-2 py-1 text-[12px] leading-[18px] text-text-secondary">{inner}</span>
  );
}

/**
 * The Comments tab: a new comment on the text selected in the page (the format toolbar's Comment
 * fills `draft`), then the threads (open or resolved), each with replies, Resolve / Reopen and
 * Delete (the author, or an admin).
 */
export function CommentsTab({ api, draft, onDraftDone, active, onActive, onShow, onCommentSelection }: {
  api: CommentsApi;
  draft: TextAnchor | null;
  onDraftDone: () => void;
  active: string | null;
  onActive: (id: string | null) => void;
  onShow: (c: PageComment) => void;
  /** Starts a comment on whatever is selected in the page (any mode). */
  onCommentSelection: () => void;
}) {
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const [replying, setReplying] = useState<string | null>(null);
  const toast = useToast();
  const listRef = useRef<HTMLOListElement>(null);
  const { comments } = api;
  const shown = comments?.filter((c) => (filter === "open" ? !c.resolved : c.resolved)) ?? [];
  const resolvedCount = comments?.filter((c) => c.resolved).length ?? 0;

  // A highlight clicked in the page: show its thread.
  useEffect(() => {
    if (!active) return;
    const c = comments?.find((x) => x.id === active);
    if (c && c.resolved && filter === "open") setFilter("resolved");
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-comment-id="${active}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ph-no-capture flex flex-col gap-4">
      {draft ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <Quote text={draft.quote} />
          <Composer
            autoFocus
            placeholder="Add a comment"
            submitLabel="Comment"
            onCancel={onDraftDone}
            onSubmit={async (body) => {
              const c = await api.add(draft, body);
              onDraftDone();
              setFilter("open");
              if (c) onActive(c.id);
            }}
          />
        </div>
      ) : (
        <div className="flex flex-col items-start gap-1.5">
          <Button size="sm" variant="secondary" iconLeft="message" onClick={onCommentSelection}>Comment on selection</Button>
          <span className="text-[12px] text-text-muted">Select text in the page first, or use Comment in its formatting bar.</span>
        </div>
      )}

      {(comments?.length ?? 0) > 0 && (
        <SegmentedControl
          aria-label="Show comments"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "open", label: `Open${api.open ? ` · ${api.open}` : ""}` },
            { value: "resolved", label: `Resolved${resolvedCount ? ` · ${resolvedCount}` : ""}` },
          ]}
        />
      )}

      {api.error && <p className="text-[13px] text-danger">{api.error}</p>}
      {!comments && !api.error && <div className="flex flex-col gap-3"><Skeleton width="85%" /><Skeleton width="60%" /></div>}
      {comments && comments.length === 0 && !draft && (
        <EmptyState icon="message" title="No comments yet" description="Select text in the page and press Comment to ask a question or suggest a change. Editors and reviewers of this guide see them." />
      )}
      {comments && comments.length > 0 && shown.length === 0 && (
        <p className="text-[13px] text-text-muted">{filter === "open" ? "No open comments. Everything's resolved." : "No resolved comments yet."}</p>
      )}

      <ol ref={listRef} className="flex flex-col gap-3">
        {shown.map((c) => (
          <li
            key={c.id}
            data-comment-id={c.id}
            className={cx("flex flex-col gap-2 rounded-lg border p-3 transition-colors", c.id === active ? "border-border-strong bg-surface-hover" : "border-border")}
            onClick={(e) => { if ((e.target as HTMLElement).closest("button, textarea, a")) return; onActive(c.id); }}
          >
            <Quote text={c.quote} onClick={() => { onActive(c.id); onShow(c); }} />
            <div className="flex items-start gap-2">
              <Avatar name={c.by_name || "Someone"} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] text-text-muted"><span className="font-semibold text-text">{c.by_name || "Someone"}</span> · {timeAgo(c.at)}</p>
                <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-text">{c.body}</p>
              </div>
              <RowMenu
                label="More for this comment"
                portal
                items={[
                  c.resolved
                    ? { label: "Reopen", icon: "rotate", onClick: () => void api.resolve(c.id, false).catch((e) => toast.error(docsErrorMessage(e))) }
                    : { label: "Resolve", icon: "check", onClick: () => void api.resolve(c.id, true).catch((e) => toast.error(docsErrorMessage(e))) },
                  ...(c.can_delete ? [{ label: "Delete", icon: "trash", danger: true, separated: true, onClick: () => void api.remove(c.id).catch((e: unknown) => toast.error(docsErrorMessage(e))) }] : []),
                ]}
              />
            </div>
            {c.replies.map((r) => (
              <div key={r.id} className="flex items-start gap-2 pl-6">
                <Avatar name={r.by_name || "Someone"} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] text-text-muted"><span className="font-semibold text-text">{r.by_name || "Someone"}</span> · {timeAgo(r.at)}</p>
                  <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-text">{r.body}</p>
                </div>
              </div>
            ))}
            {c.resolved && (
              <p className="flex items-center gap-1.5 text-[12px] text-text-muted">
                <Icon name="checkCircle" size={13} /> Resolved{c.resolved_by_name ? ` by ${c.resolved_by_name}` : ""}{c.resolved_at ? ` · ${timeAgo(c.resolved_at)}` : ""}
              </p>
            )}
            {!c.resolved && (replying === c.id ? (
              <div className="pl-6">
                <Composer autoFocus placeholder="Reply" submitLabel="Reply" onCancel={() => setReplying(null)} onSubmit={async (body) => { await api.reply(c.id, body); setReplying(null); }} />
              </div>
            ) : (
              <div className="flex gap-1 pl-6">
                <Button size="sm" variant="ghost" onClick={() => setReplying(c.id)}>Reply</Button>
                <Button size="sm" variant="ghost" iconLeft="check" onClick={() => void api.resolve(c.id, true).catch((e) => toast.error(docsErrorMessage(e)))}>Resolve</Button>
              </div>
            ))}
          </li>
        ))}
      </ol>
    </div>
  );
}
