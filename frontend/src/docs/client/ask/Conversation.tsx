"use client";

/**
 * The pieces of an Ask AI conversation (board "AskAI", "MobileAsk", "Search" ask mode): the
 * question bubble, the status line while it works, the streamed answer, numbered source chips,
 * copy / helpful / not helpful / Continue in Claude, limit and error states with the Open-in
 * links, "Ask next" suggestions and the composer.
 */
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Button, Icon, IconButton, Spinner, Tag, Textarea, copyText, cx, useToast } from "@/components/ui";
import { OPEN_IN, openInHref } from "../page";
import { loadDocs } from "../searchIndex";
import type { OpenIn, Source } from "./api";
import { Answer, answerForCopy } from "./Answer";
import { docsPath, goToSource } from "./cite";
import { aboutProduct, claudeHref, contextUrl, isStreaming, sendFeedback, setContext, setDraft, setFeedback, stopTurn, type AskContext, type Turn } from "./store";

export type Variant = "panel" | "sheet" | "palette";

/* ── status ──────────────────────────────────────────────────────────────── */

export function StatusLine({ label }: { label: string }) {
  return (
    <div className="dx-askstatus">
      <Spinner size={14} />
      <span>{label}</span>
    </div>
  );
}

/* ── sources ─────────────────────────────────────────────────────────────── */

function sourceLabel(s: Source): { main: string; sub?: string } {
  if (s.section && s.page_title) return { main: s.section, sub: s.page_title };
  return { main: s.title, sub: s.page_title && s.page_title !== s.title ? s.page_title : undefined };
}

export function SourceList({ sources, variant, siteUrl, onNavigate }: { sources: Source[]; variant: Variant; siteUrl: string; onNavigate?: () => void }) {
  const router = useRouter();
  const [active, setActive] = useState<string | null>(null);
  const sorted = [...sources].sort((a, b) => a.n - b.n);
  return (
    <ul className={cx("dx-sources", `dx-sources--${variant}`)} aria-label="Sources">
      {sorted.map((s) => {
        const { main, sub } = sourceLabel(s);
        const local = docsPath(s.url, siteUrl);
        return (
          <li key={s.id}>
            <a
              href={local ?? s.url}
              className="dx-source"
              data-active={active === s.id ? "" : undefined}
              target={local ? undefined : "_blank"}
              rel={local ? undefined : "noopener noreferrer"}
              onClick={(e) => {
                if (!local || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                setActive(s.id);
                onNavigate?.();
                goToSource(s.url, router.push, siteUrl);
              }}
            >
              <span className="dx-source__n" aria-hidden>
                {s.n}
              </span>
              <span className="dx-sr">Source {s.n}: </span>
              {variant === "palette" ? (
                <span className="dx-source__text">{sub ? `${sub} › ${main}` : main}</span>
              ) : variant === "sheet" ? (
                <span className="dx-source__text">{sub ? `${sub} › ${main}` : main}</span>
              ) : (
                <span className="dx-source__text">
                  <span className="dx-source__main">{main}</span>
                  {sub && <span className="dx-source__sub">{sub}</span>}
                </span>
              )}
              {variant === "panel" && <Icon name="arrowRight" className="dx-source__go" />}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/* ── open-in links (limits, errors, off-topic, unavailable) ─────────────── */

export function OpenInLinks({ links }: { links: OpenIn[] }) {
  return (
    <div className="dx-openin">
      {links.map((l) => (
        <Button key={l.label} href={l.href} target="_blank" variant="secondary" size="sm" iconRight="external">
          {l.label}
        </Button>
      ))}
    </div>
  );
}

/** Open-in links for a context (when the server gave none). */
export function fallbackOpenIn(question: string, ctx: AskContext | null | undefined, siteUrl: string): OpenIn[] {
  if (question) {
    const prompt = `Read ${contextUrl(ctx, siteUrl)} and answer my question ${aboutProduct()}: ${question}`.slice(0, 1500);
    return OPEN_IN.map((o) => ({ label: o.label, href: o.base + encodeURIComponent(prompt) }));
  }
  return OPEN_IN.map((o) => ({ label: o.label, href: openInHref(o.base, contextUrl(ctx, siteUrl)) }));
}

/* ── answer actions ──────────────────────────────────────────────────────── */

function TurnActions({ turn, siteUrl, compact }: { turn: Turn; siteUrl: string; compact?: boolean }) {
  const toasts = useToast();
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState("");
  const fid = useId();
  const canRate = !!turn.requestId && turn.state === "done";
  const rated = turn.feedback;

  const copy = async () => {
    if (await copyText(answerForCopy(turn.answer, turn.sources))) toasts.success("Answer copied");
    else toasts.error("Couldn't copy the answer.");
  };

  return (
    <>
      <div className="dx-turnactions">
        <IconButton icon="copy" label="Copy answer" size="sm" onClick={copy} />
        {canRate && !rated && (
          <>
            <IconButton
              icon="check"
              label="Helpful"
              size="sm"
              onClick={() => {
                sendFeedback(turn.requestId!, true);
                setFeedback(turn.id, "up");
              }}
            />
            <IconButton icon="x" label="Not helpful" size="sm" aria-expanded={asking} onClick={() => setAsking((v) => !v)} />
          </>
        )}
        {rated && (
          <span className="dx-turnactions__thanks" role="status">
            <Icon name={rated === "up" ? "check" : "x"} />
            {rated === "up" ? "Marked helpful. Thanks." : "Thanks. It helps us fix the answer."}
          </span>
        )}
        <span className="dx-turnactions__spacer" />
        <Button href={claudeHref(turn.question, turn.ctx, siteUrl)} target="_blank" variant="ghost" size="sm" iconRight="external">
          {compact ? "Claude" : "Continue in Claude"}
        </Button>
      </div>
      {asking && !rated && (
        <form
          className="dx-askfb"
          onSubmit={(e) => {
            e.preventDefault();
            sendFeedback(turn.requestId!, false, comment.trim() || undefined);
            setFeedback(turn.id, "down");
            setAsking(false);
          }}
        >
          <label htmlFor={fid} className="dx-askfb__q">
            What was wrong or missing?
          </label>
          <Textarea id={fid} rows={2} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Optional. Don't include passwords or keys." autoFocus />
          <div className="dx-askfb__row">
            <Button type="submit" size="sm">
              Send
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                sendFeedback(turn.requestId!, false);
                setFeedback(turn.id, "down");
                setAsking(false);
              }}
            >
              Skip
            </Button>
          </div>
        </form>
      )}
    </>
  );
}

/* ── one turn ────────────────────────────────────────────────────────────── */

export function TurnView({ turn, variant, siteUrl, onNavigate, actions }: { turn: Turn; variant: Variant; siteUrl: string; onNavigate?: () => void; actions?: React.ReactNode }) {
  const streaming = isStreaming(turn);
  const failed = turn.state === "error" || turn.state === "limit";
  const offTopic = turn.outcome === "off_topic";
  return (
    <div className={cx("dx-turn", `dx-turn--${variant}`)}>
      {variant !== "palette" && <div className="dx-turn__q">{turn.question}</div>}
      <div className="dx-turn__a">
        {variant === "palette" && <Icon name="zap" className="dx-turn__glyph" />}
        <div className="dx-turn__body">
          {streaming && turn.status && <StatusLine label={turn.status.label} />}
          {turn.answer && <Answer answer={turn.answer} sources={turn.sources} siteUrl={siteUrl} onNavigate={onNavigate} className={variant === "palette" ? "dx-answer--lg" : variant === "sheet" ? "dx-answer--sheet" : undefined} />}
          {turn.state === "stopped" && <p className="dx-turn__note">{turn.answer ? "Stopped." : "Stopped before an answer arrived."}</p>}
          {failed && (
            <div className={cx("dx-turn__problem", turn.state === "limit" && "dx-turn__problem--limit")} role="alert">
              <Icon name={turn.state === "limit" ? "info" : "alertCircle"} />
              <span>{turn.message}</span>
            </div>
          )}
          {(failed || offTopic) && <OpenInLinks links={turn.openIn ?? fallbackOpenIn(turn.question, turn.ctx, siteUrl)} />}
          {turn.sources.length > 0 && <SourceList sources={turn.sources} variant={variant} siteUrl={siteUrl} onNavigate={onNavigate} />}
          {turn.state === "done" && turn.answer && variant !== "palette" && <TurnActions turn={turn} siteUrl={siteUrl} compact={variant === "sheet"} />}
          {actions}
        </div>
      </div>
    </div>
  );
}

/* ── "Ask next" ──────────────────────────────────────────────────────────── */

/**
 * Ask AI sends no follow-up suggestions, so these come from the docs themselves: sections of the
 * pages the answer cited that it didn't cite (from the static search index, nothing is sent).
 */
export interface FollowUp {
  label: string;
  question: string;
}

export function useFollowUps(turn: Turn | undefined, asked: string[]): FollowUp[] {
  const [list, setList] = useState<FollowUp[]>([]);
  const key = turn && turn.state === "done" ? turn.id : "";
  useEffect(() => {
    if (!key || !turn?.sources.length) {
      setList([]);
      return;
    }
    let live = true;
    const pages = new Set(turn.sources.map((s) => s.page));
    const cited = new Set(turn.sources.map((s) => (docsPath(s.url) ?? "").toLowerCase()));
    const seen = new Set(asked.map((q) => q.toLowerCase()));
    loadDocs()
      .then((docs) => {
        if (!live) return;
        const out: FollowUp[] = [];
        for (const d of docs) {
          if (d.kind !== "section") continue;
          const [path] = d.href.split("#");
          if (!pages.has(path) || cited.has(d.href.toLowerCase())) continue;
          if (/^(related|next steps?|see also|limits)$/i.test(d.title)) continue;
          const question = `Tell me more about “${d.title}” on the “${d.where}” page.`;
          if (seen.has(question.toLowerCase())) continue;
          out.push({ label: pages.size > 1 ? `${d.title} · ${d.where}` : d.title, question });
          if (out.length >= 3) break;
        }
        setList(out);
      })
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
    // Recompute once per finished answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return list;
}

export function FollowUps({ items, onPick, title = "Ask next" }: { items: Array<string | FollowUp>; onPick: (q: string) => void; title?: string }) {
  if (!items.length) return null;
  return (
    <div className="dx-followups">
      <span className="dx-followups__title">{title}</span>
      {items.map((it) => {
        const f = typeof it === "string" ? { label: it, question: it } : it;
        return (
          <button key={f.question} type="button" className="dx-followup" onClick={() => onPick(f.question)}>
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── composer ────────────────────────────────────────────────────────────── */

export function contextLabel(ctx: AskContext): string {
  return ctx.section ? `This section: ${ctx.section.label}` : `This page: ${ctx.title}`;
}

export function Composer({
  draft,
  context,
  streamingTurn,
  focusNonce,
  onSubmit,
  variant,
  followUp,
}: {
  draft: string;
  context: AskContext | null;
  streamingTurn?: Turn;
  focusNonce: number;
  onSubmit: (q: string) => void;
  variant: "panel" | "sheet";
  followUp: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el || !focusNonce) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusNonce]);

  // Grow with the text, up to about six lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [draft]);

  const submit = () => {
    const q = draft.trim();
    if (!q || streamingTurn) return;
    onSubmit(q);
  };
  const tooLong = draft.length > 2000;

  return (
    <form
      className={cx("dx-composer", `dx-composer--${variant}`)}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {variant === "panel" && context && (
        <div className="dx-composer__tags">
          <Tag onRemove={() => setContext(null)} removeLabel={context.section ? "Don't use this section as context" : "Don't use this page as context"}>
            {contextLabel(context)}
          </Tag>
        </div>
      )}
      <label htmlFor={id} className="dx-sr">
        {followUp ? "Ask a follow-up" : `Ask a question ${aboutProduct()}`}
      </label>
      <div className="dx-composer__box">
        <textarea
          ref={ref}
          id={id}
          rows={variant === "sheet" ? 1 : 2}
          className="dx-composer__input"
          placeholder={followUp ? "Ask a follow-up…" : `Ask a question ${aboutProduct()}…`}
          value={draft}
          maxLength={4000}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          aria-invalid={tooLong || undefined}
          aria-describedby={tooLong ? `${id}-len` : undefined}
        />
        {streamingTurn ? (
          <IconButton icon="stop" label="Stop answering" variant="secondary" onClick={() => stopTurn(streamingTurn.id)} />
        ) : (
          <IconButton icon="arrowRight" label="Send" variant="primary" type="submit" disabled={!draft.trim() || tooLong} />
        )}
      </div>
      {tooLong && (
        <span id={`${id}-len`} className="dx-composer__err">
          Questions can be up to 2,000 characters ({draft.length.toLocaleString()} now).
        </span>
      )}
      {variant === "panel" && <span className="dx-composer__note">Answers come only from these docs and link to the sections they used. It can be wrong; the linked section is the source of truth.</span>}
    </form>
  );
}
