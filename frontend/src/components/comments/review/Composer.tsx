"use client";

/**
 * Composer tools: Suggest (a new comment on selected text can carry replacement text) and Check tone, plus
 * the check before posting: a comment that reads harsh (all caps, "!!!", harsh words — checked here, for
 * free) is looked at by AI, which may offer a kinder rewrite. Nothing else is sent anywhere.
 */
import { useState } from "react";
import { Button, Dialog, Icon, IconButton, Textarea, useToast } from "@/components/ui";
import { aiTone, toneFlags, type ToneResult } from "@/lib/commentsReview";
import type { CommentsCtx } from "../context";
import type { Draft } from "../slots";
import { openDialog } from "./mount";

function opts(ctx: CommentsCtx) {
  return { readPassword: ctx.readPassword ?? null };
}

export function SuggestTool({ draft, setDraft, ctx, threadId }: { draft: Draft; setDraft(d: Draft): void; ctx: CommentsCtx; threadId: string | null }) {
  const anchor = ctx.draftAnchor;
  if (threadId !== null || !anchor || anchor.type !== "text" || !ctx.perms.comment) return null;
  const on = draft.suggestion != null;
  return (
    <>
      <IconButton
        icon="edit"
        label={on ? "Remove the suggested edit" : "Suggest an edit"}
        size="sm"
        aria-pressed={on}
        className={on ? "cr-tool--on" : undefined}
        onClick={() => setDraft({ ...draft, suggestion: on ? null : anchor.quote.exact })}
      />
      {on && (
        <div className="cr-compose-sugg">
          <label className="cr-edit__label" htmlFor="cr-compose-sugg">
            Replace <q>{anchor.quote.exact.length > 60 ? `${anchor.quote.exact.slice(0, 59)}…` : anchor.quote.exact}</q> with
          </label>
          <Textarea
            id="cr-compose-sugg"
            rows={2}
            value={draft.suggestion ?? ""}
            onChange={(e) => setDraft({ ...draft, suggestion: e.target.value })}
          />
        </div>
      )}
    </>
  );
}

export function ToneTool({ draft, setDraft, ctx }: { draft: Draft; setDraft(d: Draft): void; ctx: CommentsCtx; threadId: string | null }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  if (!ctx.perms.comment || !ctx.user) return null;
  async function check() {
    if (!draft.body.trim()) return;
    setBusy(true);
    try {
      const r = await aiTone(ctx.slug, draft.body, true, opts(ctx));
      if (r.ok || !r.rewrite) {
        toast.success(r.ok ? "Reads clear and kind." : "Nothing to change.");
        return;
      }
      const pick = await toneDialog(draft.body, r, "check");
      if (pick !== null) setDraft({ ...draft, body: pick });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The check didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return <IconButton icon="sparkle" label={busy ? "Checking…" : "Check tone and clarity"} size="sm" disabled={busy || !draft.body.trim()} onClick={() => void check()} />;
}

/** Before a post: only a draft that looks harsh is checked (and the person always decides). */
export async function toneBeforePost(draft: Draft, ctx: CommentsCtx): Promise<Draft | null> {
  if (!ctx.user || !draft.body.trim() || !toneFlags(draft.body).length) return draft;
  let r: ToneResult;
  try {
    r = await aiTone(ctx.slug, draft.body, false, opts(ctx));
  } catch {
    return draft; // AI unavailable (limits, offline): never in the way of posting
  }
  if (r.ok) return draft;
  const pick = await toneDialog(draft.body, r, "post");
  return pick === null ? null : { ...draft, body: pick };
}

/** The original, the issues and the rewrite: resolves with the text to use, or null (keep editing). */
function toneDialog(body: string, r: ToneResult, mode: "post" | "check"): Promise<string | null> {
  return openDialog<string | null>((done) => <ToneDialog body={body} result={r} mode={mode} done={done} />);
}

function ToneDialog({ body, result, mode, done }: { body: string; result: ToneResult; mode: "post" | "check"; done(v: string | null): void }) {
  const [open, setOpen] = useState(true);
  const [text, setText] = useState(result.rewrite ?? body);
  const close = (v: string | null) => {
    setOpen(false);
    done(v);
  };
  return (
    <Dialog
      open={open}
      onClose={() => close(null)}
      title={mode === "post" ? "Before you post" : "Tone and clarity"}
      description={result.issues.length ? `This might read as: ${result.issues.join(", ")}.` : "A clearer, kinder way to say it:"}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(null)}>Keep editing</Button>
          {mode === "post" && <Button variant="secondary" onClick={() => close(body)}>Post as written</Button>}
          <Button variant="primary" onClick={() => close(text)}>{mode === "post" ? "Post the rewrite" : "Use the rewrite"}</Button>
        </>
      }
    >
      <div className="cr-tone">
        <p className="cr-tone__label"><Icon name="sparkle" size={12} aria-hidden /> Suggested rewrite (you can edit it)</p>
        <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} aria-label="Suggested rewrite" />
        <p className="cr-tone__label">What you wrote</p>
        <blockquote className="cr-tone__orig">{body}</blockquote>
      </div>
    </Dialog>
  );
}
