"use client";

/**
 * The comment box: plain text with light Markdown, @mention picker (people who can open the item; typing an
 * email of someone who can't offers to share the item with them first), ⌘/Ctrl+Enter to post, Esc to
 * cancel. Track B's tools (attach, suggest) sit in its toolbar and its checks (tone) run before posting.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button, Icon, IconButton, useToast } from "@/components/ui";
import { addPerson } from "@/lib/access";
import { commentPeople, type MentionCandidate, type PeopleResult } from "@/lib/comments";
import type { CommentsCtx } from "./context";
import { slots, type Draft } from "./slots";

interface Props {
  ctx: CommentsCtx;
  threadId: string | null;
  placeholder?: string;
  submitLabel?: string;
  initial?: { body: string; mentions: string[] } | null;
  autoFocus?: boolean;
  onSubmit(draft: Draft): Promise<void>;
  onCancel?: () => void;
  compact?: boolean;
}

const MENTION = /(^|\s)@([^\s@]{0,40})$/;

export function Composer({ ctx, threadId, placeholder = "Add a comment…", submitLabel = "Comment", initial, autoFocus, onSubmit, onCancel, compact }: Props) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>({ body: initial?.body ?? "", mentions: initial?.mentions ?? [], attachments: [], suggestion: null });
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [people, setPeople] = useState<PeopleResult | null>(null);
  const [pick, setPick] = useState(0);
  const ta = useRef<HTMLTextAreaElement | null>(null);
  const tools = useMemo(() => slots().composerTools, []);
  // Names already inserted, so a mention removed from the text is dropped from the list too.
  const names = useRef<Map<string, string>>(new Map());

  useEffect(() => { if (autoFocus) ta.current?.focus(); }, [autoFocus]);

  // Grow with the text.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(240, el.scrollHeight)}px`;
  }, [draft.body]);

  // The picker's people, as the query changes (debounced).
  useEffect(() => {
    if (query == null) { setPeople(null); return; }
    let live = true;
    const t = window.setTimeout(() => {
      commentPeople(ctx.slug, query, { readPassword: ctx.readPassword }).then((r) => { if (live) { setPeople(r); setPick(0); } }).catch(() => {});
    }, 120);
    return () => { live = false; window.clearTimeout(t); };
  }, [query, ctx.slug, ctx.readPassword]);

  const onText = (value: string) => {
    const caret = ta.current?.selectionStart ?? value.length;
    const m = MENTION.exec(value.slice(0, caret));
    setQuery(m ? m[2]! : null);
    // Drop mentions whose @Name is gone from the text.
    const kept = draft.mentions.filter((id) => {
      const n = names.current.get(id);
      return !n || value.includes(`@${n}`);
    });
    setDraft({ ...draft, body: value, mentions: kept });
  };

  const insertMention = (p: MentionCandidate) => {
    const el = ta.current;
    const caret = el?.selectionStart ?? draft.body.length;
    const before = draft.body.slice(0, caret).replace(MENTION, (_m, lead) => `${lead}@${p.name} `);
    const body = before + draft.body.slice(caret);
    names.current.set(p.id, p.name);
    setDraft({ ...draft, body, mentions: draft.mentions.includes(p.id) ? draft.mentions : [...draft.mentions, p.id] });
    setQuery(null);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(before.length, before.length); });
  };

  const shareAndMention = async (email: string) => {
    try {
      await addPerson(ctx.slug, email, "viewer", true, draft.body.slice(0, 400) || undefined);
      const again = await commentPeople(ctx.slug, email.split("@")[0]!, { readPassword: ctx.readPassword });
      const hit = again.people.find((p) => p.has_access && p.email?.toLowerCase() === email.toLowerCase());
      if (hit) insertMention(hit);
      else {
        setQuery(null);
        toast.success(`Shared with ${email}. They'll get an email with the link.`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't share it.");
    }
  };

  const options = people?.people ?? [];
  const submit = async () => {
    if (!draft.body.trim() || busy) return;
    setBusy(true);
    try {
      let d: Draft | null = draft;
      for (const check of slots().beforePost) {
        d = await check(d, ctx, threadId);
        if (!d) return;
      }
      await onSubmit(d);
      setDraft({ body: "", mentions: [], attachments: [], suggestion: null });
      names.current.clear();
    } catch {
      /* the store showed the error */
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (query != null && (options.length || people?.invite)) {
      if (e.key === "ArrowDown") { e.preventDefault(); setPick((p) => Math.min(options.length - 1, p + 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setPick((p) => Math.max(0, p - 1)); return; }
      if ((e.key === "Enter" || e.key === "Tab") && options[pick]) { e.preventDefault(); insertMention(options[pick]!); return; }
      if (e.key === "Escape") { e.preventDefault(); setQuery(null); return; }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); return; }
    if (e.key === "Escape" && onCancel) { e.preventDefault(); onCancel(); }
  };

  return (
    <div className={`mdc-composer${compact ? " mdc-composer--compact" : ""}`} data-comments-skip>
      <div className="mdc-composer__field">
        <textarea
          ref={ta}
          className="mdc-composer__input"
          value={draft.body}
          placeholder={placeholder}
          rows={compact ? 1 : 2}
          maxLength={5000}
          aria-label={placeholder}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => window.setTimeout(() => setQuery(null), 150)}
        />
        {query != null && (options.length > 0 || people?.invite) && (
          <div className="mdc-mentions" role="listbox" aria-label="People">
            {options.map((p, i) => (
              <button key={p.id} type="button" role="option" aria-selected={i === pick}
                className={`mdc-mentions__item${i === pick ? " is-active" : ""}`}
                onMouseDown={(e) => e.preventDefault()} onClick={() => insertMention(p)}>
                <span className="mdc-avatar mdc-avatar--sm" aria-hidden>{p.picture ? <img src={p.picture} alt="" /> : p.name.slice(0, 1).toUpperCase()}</span>
                <span className="mdc-mentions__name">{p.name}{p.you ? " (you)" : ""}</span>
                {p.email && <span className="mdc-mentions__email">{p.email}</span>}
                {!p.has_access && <span className="mdc-mentions__warn">Can’t open this</span>}
              </button>
            ))}
            {people?.invite && (
              <div className="mdc-mentions__invite">
                <Icon name="mail" />
                <span><strong>{people.invite.email}</strong> can’t open this yet.</span>
                {people.invite.can_share
                  ? <Button size="sm" variant="secondary" onMouseDown={(e) => e.preventDefault()} onClick={() => void shareAndMention(people.invite!.email)}>Share with them</Button>
                  : <span className="mdc-muted">Ask the owner to share it.</span>}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="mdc-composer__bar">
        <IconButton icon="at" label="Mention someone" size="sm" onClick={() => {
          const el = ta.current;
          const body = draft.body + (draft.body && !/\s$/.test(draft.body) ? " @" : "@");
          setDraft({ ...draft, body });
          setQuery("");
          requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(body.length, body.length); });
        }} />
        {tools.map((t) => <t.Component key={t.id} draft={draft} setDraft={setDraft} ctx={ctx} threadId={threadId} />)}
        <span className="mdc-composer__spacer" />
        {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button size="sm" onClick={() => void submit()} loading={busy} disabled={!draft.body.trim()}>{submitLabel}</Button>
      </div>
    </div>
  );
}
