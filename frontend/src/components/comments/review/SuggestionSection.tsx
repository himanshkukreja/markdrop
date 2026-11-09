"use client";

/**
 * Under a thread's first message (ThreadSection): its suggested edit — the quote struck through, the
 * replacement, and Accept / Reject / Withdraw / Edit for whoever may — plus the suggestion editor and the
 * "Ask Markdrop AI" box when a thread action opened them.
 *
 * Accepting is an edit of the page under its own rules: nobody (or you) editing → the page says it now, as a
 * version in its history, and the thread resolves; someone else editing → it waits for them (they see
 * "Apply" here, on their own copy of the page, and their editor loads the change).
 */
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Icon, Textarea, useToast } from "@/components/ui";
import type { Thread } from "@/lib/comments";
import { CommentsApiError } from "@/lib/comments";
import {
  acceptSuggestion,
  aiApply,
  aiAsk,
  deleteSuggestion,
  getSuggestion,
  putSuggestion,
  type SuggestionDetail,
} from "@/lib/commentsReview";
import type { CommentsCtx } from "../context";
import { reviewUi, useReviewUi } from "./store";

const STATE_LABEL: Record<string, { label: string; tone: "info" | "success" | "neutral" | "warning" }> = {
  open: { label: "Suggested edit", tone: "info" },
  accepted: { label: "Accepted", tone: "success" },
  rejected: { label: "Not used", tone: "neutral" },
  stale: { label: "Out of date", tone: "warning" },
};

const REASON: Record<string, string> = {
  stale: "The text it replaces has changed, so it can't be applied any more.",
  changed: "The text it replaces has changed, so it can't be applied any more.",
  unappliable: "It crosses formatting (bold, a link…) a one-click edit would break. Copy it and edit the page by hand.",
};

function quoteOf(t: Thread): string {
  return t.anchor.quote?.exact || t.original.exact || "";
}

function errText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "That didn't work. Try again.";
}

function opts(ctx: CommentsCtx) {
  return { readPassword: ctx.readPassword ?? null };
}

export function SuggestionSection({ thread, ctx }: { thread: Thread; ctx: CommentsCtx }) {
  const ui = useReviewUi();
  const editing = ui.editor(thread.id);
  const asking = ui.isAsking(thread.id);
  return (
    <>
      {thread.suggestion && !editing && <SuggestionCard thread={thread} ctx={ctx} />}
      {editing && <SuggestEditor thread={thread} ctx={ctx} />}
      {asking && <AskBox thread={thread} ctx={ctx} />}
    </>
  );
}

function SuggestionCard({ thread, ctx }: { thread: Thread; ctx: CommentsCtx }) {
  const s = thread.suggestion!;
  const toast = useToast();
  const [detail, setDetail] = useState<SuggestionDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isOpen = s.state === "open" && thread.status === "open";
  const signedIn = !!ctx.user;

  // What accepting would do now (only for open suggestions; re-read when the thread changes).
  useEffect(() => {
    if (!isOpen || !signedIn) {
      setDetail(null);
      return;
    }
    let live = true;
    getSuggestion(ctx.slug, thread.id, opts(ctx))
      .then((d) => live && setDetail(d))
      .catch(() => live && setDetail(null));
    return () => {
      live = false;
    };
  }, [ctx.slug, thread.id, thread.updated_at, isOpen, signedIn, ctx.readPassword]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(what: string, fn: () => Promise<void>) {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
      if (e instanceof CommentsApiError && (e.code === "suggestion_stale" || e.code === "no_suggestion")) void ctx.refresh();
    } finally {
      setBusy(null);
    }
  }

  const accept = () =>
    run("accept", async () => {
      const r = await acceptSuggestion(ctx.slug, thread.id, true, opts(ctx));
      ctx.upsert(r.thread);
      if (r.applied) toast.success("Applied to the page.");
      else toast.info(`${r.holder ?? "Someone"} is editing the page, so it's waiting for them to apply it.`);
    });
  const reject = () =>
    run("reject", async () => {
      ctx.upsert(await deleteSuggestion(ctx.slug, thread.id, opts(ctx)));
    });

  const meta = STATE_LABEL[s.state] ?? STATE_LABEL.open;
  const can = detail?.can;
  const reason = isOpen ? detail?.reason ?? (thread.anchor_status === "changed" ? "changed" : null) : null;
  const blocked = reason === "stale" || reason === "changed" || reason === "unappliable";
  const mine = !!ctx.user && s.by?.id === ctx.user.id;
  const quote = quoteOf(thread);

  return (
    <div className={`cr-sugg cr-sugg--${s.state}`} data-testid="suggestion-card">
      <div className="cr-sugg__head">
        <Icon name="edit" size={14} aria-hidden />
        <span className="cr-sugg__title">{meta.label}</span>
        {detail?.suggestion?.ai && <Badge size="sm" tone="neutral" icon="sparkle">AI draft</Badge>}
        {s.state !== "open" && <Badge size="sm" tone={meta.tone}>{s.state === "accepted" ? "Applied" : meta.label}</Badge>}
      </div>
      <div className="cr-sugg__diff">
        {quote && <del className="cr-sugg__old">{quote}</del>}
        <ins className="cr-sugg__new">{s.text}</ins>
      </div>
      <p className="cr-sugg__by">
        {s.state === "accepted" && s.decided_by
          ? <>Accepted by <strong>{s.decided_by.name}</strong>{s.version_id && <> · saved as version {s.version_id} in the page's history</>}</>
          : s.state === "rejected" && s.decided_by
            ? <>{s.decided_by.id === s.by?.id ? "Withdrawn" : <>Not used by <strong>{s.decided_by.name}</strong></>}</>
            : <>Suggested by <strong>{mine ? "you" : s.by?.name ?? "someone"}</strong></>}
      </p>

      {isOpen && detail?.offer?.mine && (
        <div className="cr-sugg__offer" role="status">
          <Icon name="info" size={14} aria-hidden />
          <span>
            <strong>{detail.offer.by?.name ?? "An editor"}</strong> accepted this while you're editing. Apply it to the page?
          </span>
        </div>
      )}
      {isOpen && reason === "locked" && detail?.holder && !detail.offer?.mine && (
        <p className="cr-sugg__note">
          <strong>{detail.holder.name}</strong> is editing the page: accepting sends it to them to apply.
          {detail.offer && !detail.offer.mine && <> Waiting for them.</>}
        </p>
      )}
      {isOpen && blocked && <p className="cr-sugg__note cr-sugg__note--warn">{REASON[reason!]}</p>}
      {error && <p className="cr-sugg__error" role="alert">{error}</p>}

      {isOpen && signedIn && (
        <div className="cr-sugg__actions">
          {(can?.accept ?? thread.can.accept) && !blocked && (
            <Button size="sm" variant="primary" loading={busy === "accept"} disabled={!!busy} onClick={() => void accept()} iconLeft="check">
              {detail?.offer?.mine ? "Apply" : "Accept"}
            </Button>
          )}
          {can?.reject && (
            <Button size="sm" variant="ghost" loading={busy === "reject"} disabled={!!busy} onClick={() => void reject()}>
              Reject
            </Button>
          )}
          {can?.withdraw && (
            <Button size="sm" variant="ghost" loading={busy === "reject"} disabled={!!busy} onClick={() => void reject()}>
              Withdraw
            </Button>
          )}
          {can?.edit && (
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => reviewUi.openEditor(thread.id, { text: s.text })}>
              Edit
            </Button>
          )}
          {reason === "unappliable" && (
            <Button size="sm" variant="ghost" iconLeft="copy" onClick={() => void navigator.clipboard?.writeText(s.text).then(() => toast.success("Copied."))}>
              Copy
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function SuggestEditor({ thread, ctx }: { thread: Thread; ctx: CommentsCtx }) {
  const ui = useReviewUi();
  const st = ui.editor(thread.id)!;
  const [text, setText] = useState(st.text || quoteOf(thread));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  async function draft() {
    reviewUi.openEditor(thread.id, { drafting: true });
    setError(null);
    try {
      const r = await aiApply(ctx.slug, thread.id, null, opts(ctx));
      setText(r.text);
      reviewUi.openEditor(thread.id, { drafting: false, ai: true, note: r.note, text: r.text });
    } catch (e) {
      setError(errText(e));
      reviewUi.openEditor(thread.id, { drafting: false });
    }
  }

  useEffect(() => {
    if (st.drafting && !started.current) {
      started.current = true;
      void draft();
    } else {
      ref.current?.focus();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function propose() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      ctx.upsert(await putSuggestion(ctx.slug, thread.id, text, st.ai, opts(ctx)));
      reviewUi.closeEditor(thread.id);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const quote = quoteOf(thread);
  return (
    <div className="cr-edit" data-testid="suggestion-editor">
      <label className="cr-edit__label" htmlFor={`cr-edit-${thread.id}`}>
        Suggest replacing <q>{quote.length > 80 ? `${quote.slice(0, 79)}…` : quote}</q> with
      </label>
      <Textarea
        id={`cr-edit-${thread.id}`}
        ref={ref}
        rows={3}
        value={text}
        disabled={st.drafting}
        onChange={(e) => {
          setText(e.target.value);
          if (st.ai) reviewUi.openEditor(thread.id, { ai: true });
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void propose();
          if (e.key === "Escape") reviewUi.closeEditor(thread.id);
        }}
      />
      {st.drafting && <p className="cr-edit__note"><Icon name="sparkle" size={12} aria-hidden /> Drafting from the discussion…</p>}
      {!st.drafting && st.ai && st.note && <p className="cr-edit__note"><Icon name="sparkle" size={12} aria-hidden /> {st.note} Check it before you suggest it.</p>}
      {error && <p className="cr-sugg__error" role="alert">{error}</p>}
      <div className="cr-sugg__actions">
        <Button size="sm" variant="primary" loading={busy} disabled={st.drafting || !text.trim() || text === quote} onClick={() => void propose()}>
          Suggest
        </Button>
        <Button size="sm" variant="ghost" iconLeft="sparkle" disabled={busy || st.drafting} onClick={() => void draft()}>
          {st.ai ? "Draft again" : "Draft with AI"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => reviewUi.closeEditor(thread.id)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function AskBox({ thread, ctx }: { thread: Thread; ctx: CommentsCtx }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);

  async function ask() {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await aiAsk(ctx.slug, thread.id, q.trim(), opts(ctx));
      ctx.upsert(r.thread);
      reviewUi.setAsking(thread.id, false);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cr-edit" data-testid="ask-ai">
      <label className="cr-edit__label" htmlFor={`cr-ask-${thread.id}`}>
        <Icon name="sparkle" size={12} aria-hidden /> Ask Markdrop AI — everyone in this thread sees the answer
      </label>
      <Textarea
        id={`cr-ask-${thread.id}`}
        ref={ref}
        rows={2}
        value={q}
        placeholder="What does this mean for the launch date?"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void ask();
          }
          if (e.key === "Escape") reviewUi.setAsking(thread.id, false);
        }}
      />
      {error && <p className="cr-sugg__error" role="alert">{error}</p>}
      <div className="cr-sugg__actions">
        <Button size="sm" variant="primary" loading={busy} disabled={!q.trim()} onClick={() => void ask()}>
          Ask
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => reviewUi.setAsking(thread.id, false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
