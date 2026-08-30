"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { adminListUsers, type AdminUserListItem } from "@/lib/api";

/**
 * Address field with type-ahead over real accounts, chosen addresses held as
 * pills.
 *
 * The previous free-text textarea made a typo silently become "nobody" — the
 * address just fails to match a user and is dropped from the audience. Picking
 * from the account list makes the common case unmissable, while still allowing
 * a typed address for anyone not yet in the suggestions.
 */
export default function RecipientPicker({
  token,
  value,
  onChange,
}: {
  token: string;
  value: string[];
  onChange: (emails: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AdminUserListItem[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);

  // One character is too little to be useful and floods the endpoint; two is
  // where a suggestion starts to mean something.
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await adminListUsers(token, 1, query.trim());
        if (!cancelled) {
          setResults(r.users);
          setActive(0);
          setOpen(true);
        }
      } catch {
        /* suggestions are a convenience, not a requirement */
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, token]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const suggestions = useMemo(
    () => results.filter((u) => !value.includes(u.email)).slice(0, 6),
    [results, value]
  );

  function add(email: string) {
    const e = email.trim().toLowerCase();
    if (!e || value.includes(e)) return;
    onChange([...value, e]);
    setQuery("");
    setResults([]);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" && suggestions.length) {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp" && suggestions.length) {
      e.preventDefault();
      setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (open && suggestions[active]) add(suggestions[active].email);
      else if (query.includes("@")) add(query);
    } else if (e.key === "Backspace" && !query && value.length) {
      // Emptying the field then pressing backspace removes the last pill —
      // the behaviour every mail client has trained people to expect.
      onChange(value.slice(0, -1));
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={wrap} className="relative">
      <div
        onClick={() => wrap.current?.querySelector("input")?.focus()}
        className="flex flex-wrap items-center gap-1.5 min-h-[42px] rounded-lg border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] px-2 py-1.5 focus-within:border-blue-500 transition-colors cursor-text"
      >
        {value.map((email) => (
          <span
            key={email}
            className="inline-flex items-center gap-1 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 ring-1 ring-blue-500/25 pl-2 pr-1 py-0.5 text-xs"
          >
            {email}
            <button
              onClick={(e) => { e.stopPropagation(); onChange(value.filter((v) => v !== email)); }}
              aria-label={`Remove ${email}`}
              className="rounded p-0.5 hover:bg-blue-500/20"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </span>
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => suggestions.length && setOpen(true)}
          placeholder={value.length ? "" : "Start typing a name or email…"}
          className="flex-1 min-w-[10rem] bg-transparent text-sm outline-none py-1 text-gray-700 dark:text-gray-300"
        />
      </div>

      {open && suggestions.length > 0 && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-white dark:bg-gray-900 vscode:bg-[#252526] shadow-xl overflow-hidden">
          {suggestions.map((u, i) => (
            <button
              key={u.id}
              onMouseEnter={() => setActive(i)}
              onClick={() => add(u.email)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                i === active ? "bg-blue-500/10" : "hover:bg-gray-100 dark:hover:bg-gray-800"
              }`}
            >
              <span className="shrink-0 grid place-items-center w-7 h-7 rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-400 text-xs font-semibold">
                {(u.name || u.email)[0]?.toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className="block text-sm text-gray-900 dark:text-gray-100 truncate">
                  {u.name || u.email}
                </span>
                {u.name && (
                  <span className="block text-xs text-gray-500 truncate">{u.email}</span>
                )}
              </span>
              <span className="ml-auto shrink-0 text-[10px] text-gray-400">
                {u.document_count} doc{u.document_count === 1 ? "" : "s"}
              </span>
            </button>
          ))}
        </div>
      )}

      <p className="mt-1.5 text-[11px] text-gray-400">
        Pick from your accounts, or type a full address and press Enter. Anyone
        who has unsubscribed is skipped even if listed here.
      </p>
    </div>
  );
}
