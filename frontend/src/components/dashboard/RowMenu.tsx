"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The overflow menu on a document row.
 *
 * Every row used to carry six buttons. At twenty documents that is a hundred and
 * twenty controls competing with the content they act on, and the content loses.
 * One or two live on the row; the rest live here.
 *
 * The trigger is **always visible**, never hover-only. Hover does not exist on a
 * phone, and an action reachable only by hovering is an action a phone user does
 * not have.
 */

export interface MenuItem {
  label: string;
  onClick?: () => void;
  href?: string;
  /** Opens in a new tab; only meaningful with `href`. */
  external?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** Renders a hairline above this item. */
  separated?: boolean;
  busy?: boolean;
}

export default function RowMenu({ items, label = "More actions" }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Rows near the bottom of a long list would otherwise open a menu that runs
  // off the viewport, so it flips above the trigger instead.
  useEffect(() => {
    if (!open || !wrap.current) return;
    const r = wrap.current.getBoundingClientRect();
    setFlip(window.innerHeight - r.bottom < 300);
  }, [open]);

  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        className={`grid h-8 w-8 place-items-center rounded-lg border text-lg leading-none transition-colors ${
          open
            ? "border-blue-500/50 bg-blue-500/10 text-blue-300"
            : "border-gray-200 dark:border-white/[0.09] text-gray-400 hover:border-gray-300 dark:hover:border-white/20 hover:bg-gray-100 dark:hover:bg-white/[0.06] hover:text-gray-700 dark:hover:text-gray-200"
        }`}
      >
        <span className="-mt-1">⋯</span>
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute right-0 z-40 w-56 overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] bg-white dark:bg-gray-900 vscode:bg-[#252526] py-1 shadow-2xl ${
            flip ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]"
          }`}
        >
          {items.map((it) => {
            const cls = `flex w-full items-center gap-2 px-3.5 py-2 text-left text-[13px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              it.danger
                ? "text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
                : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
            }`;
            const body = (
              <>
                {it.label}
                {it.busy && <span className="ml-auto h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />}
              </>
            );
            return (
              <div key={it.label} className={it.separated ? "mt-1 border-t border-gray-100 dark:border-white/[0.07] pt-1" : ""}>
                {it.href ? (
                  <a
                    role="menuitem"
                    href={it.href}
                    target={it.external ? "_blank" : undefined}
                    rel={it.external ? "noopener noreferrer" : undefined}
                    className={cls}
                    onClick={() => setOpen(false)}
                  >
                    {body}
                  </a>
                ) : (
                  <button
                    role="menuitem"
                    type="button"
                    disabled={it.disabled}
                    className={cls}
                    onClick={() => { setOpen(false); it.onClick?.(); }}
                  >
                    {body}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
