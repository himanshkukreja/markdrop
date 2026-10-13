"use client";
/**
 * Combobox / TokenInput (REVAMP_PLAN 7.6 "Share", 8.2): "Add people by email".
 *
 * - The tags sit inside the field; the text input is an ARIA 1.2 combobox (`aria-expanded`,
 *   `aria-controls`, `aria-activedescendant`) over a listbox of suggestions.
 * - Suggestions come only from the caller (workspace members and people this user has shared
 *   with before; never a global search). They show Avatar, name, email and an optional role.
 *   The list is filtered here by name/email and hides people already added.
 * - Any address typed in full is accepted: Enter, comma, semicolon, space or Tab commits it;
 *   blur commits a valid one; a paste of several addresses adds each valid one.
 * - Backspace in an empty input removes the last tag. Each tag has a 24px remove button.
 * - Escape closes the list (and stops there: it doesn't also close an enclosing Dialog).
 * - Adds and removals are announced through the shared status region.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Avatar, Icon, Tag, announce } from "@/components/ui";
import { looksLikeEmail } from "./publish-utils";
import s from "./publish.module.css";

export interface ComboboxSuggestion {
  email: string;
  name?: string;
  avatarUrl?: string;
  /** Shown quietly at the end of the row ("Member", "Shared with before"). */
  role?: string;
}

export interface ComboboxProps {
  /** Committed addresses. */
  tags: string[];
  onTagsChange: (tags: string[]) => void;
  suggestions?: ComboboxSuggestion[];
  label?: React.ReactNode;
  placeholder?: string;
  hint?: React.ReactNode;
  /** An error from the caller (e.g. the server refused an address). Replaces the hint. */
  error?: React.ReactNode;
  disabled?: boolean;
  /** Validates a typed entry before it becomes a tag. Default: looks like an email address. */
  validate?: (text: string) => boolean;
  /** Message when a typed entry fails `validate`. */
  invalidMessage?: string;
  maxTags?: number;
  /** The raw query, e.g. to fetch suggestions lazily. */
  onQueryChange?: (q: string) => void;
  id?: string;
  className?: string;
  /** Max suggestions shown (default 6). */
  limit?: number;
}

const SEPARATORS = new Set([",", ";", " "]);
const norm = (s: string) => s.trim().toLowerCase();

export function Combobox({
  tags, onTagsChange, suggestions = [], label = "Add people by email", placeholder = "name@example.com", hint, error, disabled,
  validate = looksLikeEmail, invalidMessage = "That doesn't look like an email address. Check it and try again.",
  maxTags, onQueryChange, id, className, limit = 6,
}: ComboboxProps) {
  const uid = useId();
  const inputId = id ?? `${uid}-input`;
  const listId = `${uid}-list`, hintId = `${uid}-hint`, errId = `${uid}-err`, labelId = `${uid}-label`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [localError, setLocalError] = useState<string | null>(null);

  const taken = useMemo(() => new Set(tags.map(norm)), [tags]);
  const matches = useMemo(() => {
    const q = norm(query);
    return suggestions
      .filter((p) => !taken.has(norm(p.email)))
      .filter((p) => !q || norm(p.email).includes(q) || (p.name ? norm(p.name).includes(q) : false))
      .slice(0, limit);
  }, [suggestions, taken, query, limit]);
  const listOpen = open && matches.length > 0 && !disabled;
  useEffect(() => { if (active >= matches.length) setActive(matches.length ? 0 : -1); }, [matches.length, active]);

  const full = maxTags !== undefined && tags.length >= maxTags;
  const nameFor = (email: string) => suggestions.find((p) => norm(p.email) === norm(email))?.name;

  const add = (entries: string[]) => {
    const next = [...tags];
    const added: string[] = [];
    let bad = false;
    for (const raw of entries) {
      const v = raw.trim().replace(/^<|>$/g, "");
      if (!v) continue;
      if (!validate(v)) { bad = true; continue; }
      if (next.some((t) => norm(t) === norm(v))) continue;
      if (maxTags !== undefined && next.length >= maxTags) break;
      next.push(v); added.push(v);
    }
    if (added.length) { onTagsChange(next); announce(added.length === 1 ? `Added ${added[0]}` : `Added ${added.length} people`); }
    setLocalError(bad ? invalidMessage : null);
    return { added: added.length, bad };
  };
  const remove = (i: number) => {
    const t = tags[i]!;
    onTagsChange(tags.filter((_, k) => k !== i));
    announce(`Removed ${t}`);
    inputRef.current?.focus();
  };
  const setQ = (q: string) => { setQuery(q); onQueryChange?.(q); };
  const pick = (p: ComboboxSuggestion) => { add([p.email]); setQ(""); setActive(-1); inputRef.current?.focus(); };
  /** Commit what's typed; returns true when something was consumed (valid or not). */
  const commitTyped = () => {
    if (!query.trim()) return false;
    const r = add([query]);
    if (r.added || !r.bad) setQ("");
    return true;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) setOpen(true);
        setActive((a) => (matches.length ? (a + 1) % matches.length : -1));
        return;
      case "ArrowUp":
        e.preventDefault();
        if (!open) setOpen(true);
        setActive((a) => (matches.length ? (a <= 0 ? matches.length - 1 : a - 1) : -1));
        return;
      case "Escape":
        if (listOpen) { e.preventDefault(); setOpen(false); setActive(-1); }
        return;
      case "Enter":
        if (listOpen && active >= 0 && matches[active]) { e.preventDefault(); pick(matches[active]!); return; }
        if (query.trim()) { e.preventDefault(); commitTyped(); }
        return;
      case "Tab":
        // Tab keeps its job (moving on) unless there's a valid address to commit first.
        if (query.trim() && validate(query.trim())) { e.preventDefault(); commitTyped(); }
        return;
      case "Backspace":
        if (!query && tags.length) { e.preventDefault(); remove(tags.length - 1); }
        return;
      default:
        if (SEPARATORS.has(e.key) && query.trim()) { e.preventDefault(); commitTyped(); }
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    const parts = text.split(/[\s,;]+/).filter(Boolean);
    if (parts.length < 2) return;
    e.preventDefault();
    add(parts);
  };

  const shownError = error ?? localError;
  const describedBy = [shownError ? errId : hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  const activeId = listOpen && active >= 0 ? `${uid}-opt-${active}` : undefined;

  return (
    <div className={[s.combo, className].filter(Boolean).join(" ")}>
      {label && <label id={labelId} htmlFor={inputId} className="md-field__label">{label}</label>}
      <div className={[s.comboField, shownError && s.comboFieldInvalid, disabled && s.comboFieldDisabled].filter(Boolean).join(" ")}
        onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); inputRef.current?.focus(); } }}>
        {tags.map((t, i) => (
          <Tag key={t} removeLabel={`Remove ${t}`} onRemove={disabled ? undefined : () => remove(i)} className={s.comboTag}>
            <span className={s.comboTagText} title={t}>{nameFor(t) ?? t}</span>
          </Tag>
        ))}
        <input ref={inputRef} id={inputId} type="text" inputMode="email" className={s.comboInput}
          role="combobox" aria-expanded={listOpen} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={activeId}
          aria-describedby={describedBy} aria-invalid={!!shownError || undefined}
          placeholder={tags.length ? (full ? "" : "Add another") : placeholder} autoComplete="off" autoCapitalize="off" spellCheck={false}
          disabled={disabled || full} value={query}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); if (localError) setLocalError(null); }}
          onFocus={() => setOpen(true)}
          onBlur={() => { setOpen(false); setActive(-1); if (query.trim() && validate(query.trim())) commitTyped(); }}
          onKeyDown={onKeyDown} onPaste={onPaste} />
      </div>
      <ul id={listId} role="listbox" aria-labelledby={label ? labelId : undefined} aria-label={label ? undefined : "Suggestions"} className={s.comboList} hidden={!listOpen}>
        {matches.map((p, i) => (
          <li key={p.email} id={`${uid}-opt-${i}`} role="option" aria-selected={i === active}
            className={[s.comboOpt, i === active && s.comboOptActive].filter(Boolean).join(" ")}
            // mousedown, so the input doesn't blur (and commit the half-typed query) first.
            onMouseDown={(e) => { e.preventDefault(); pick(p); }}
            onMouseMove={() => { if (active !== i) setActive(i); }}>
            <Avatar name={p.name || p.email} src={p.avatarUrl} size="md" />
            <span className={s.comboOptText}>
              <span className={s.comboOptName}>{p.name || p.email}</span>
              {p.name && <span className={s.comboOptEmail}>{p.email}</span>}
            </span>
            {p.role && <span className={s.comboOptRole}>{p.role}</span>}
          </li>
        ))}
      </ul>
      {shownError ? (
        <div id={errId} className="md-field__error" role="alert"><Icon name="alertCircle" /> {shownError}</div>
      ) : hint ? (
        <div id={hintId} className="md-field__hint">{hint}</div>
      ) : null}
    </div>
  );
}

/** Alias: the same component under the name the Share dialog spec uses. */
export const TokenInput = Combobox;
export type TokenInputProps = ComboboxProps;
