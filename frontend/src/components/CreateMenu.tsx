"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The four creation surfaces behind one entry point.
 *
 * They used to sit in the header as four peer links — "Share file", "Artifacts",
 * "Builder", "+ New" — which read as equally-weighted navigation even though
 * they do very different things. Grouping them under one labelled trigger, each
 * with a one-line description, makes the difference legible instead of leaving
 * the visitor to infer it from a single word.
 */
const ITEMS = [
  {
    href: "/new",
    label: "Markdown document",
    desc: "Write or paste markdown, publish a link",
    tint: "text-blue-500 bg-blue-500/10",
    d: "M4 6h16M4 12h10M4 18h13",
  },
  {
    href: "/upload",
    label: "Artifact",
    desc: "PDF, spreadsheet, Word doc or web page",
    tint: "text-orange-500 bg-orange-500/10",
    d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
    isNew: true,
  },
  {
    href: "/builder",
    label: "README builder",
    desc: "Assemble a README from ready-made blocks",
    tint: "text-teal-500 bg-teal-500/10",
    d: "M4 5h16M4 10h16M4 15h10M4 20h7",
  },
  {
    href: "/share",
    label: "Send a file",
    desc: "Peer-to-peer, nothing stored on our servers",
    tint: "text-violet-500 bg-violet-500/10",
    d: "M12 16V4m0 0L8 8m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
  },
];

export default function CreateMenu() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
        Create
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-[19rem] max-w-[calc(100vw-2rem)] z-50 rounded-xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-white dark:bg-gray-900 vscode:bg-[#252526] shadow-xl shadow-black/10 dark:shadow-black/40 overflow-hidden p-1.5"
        >
          {ITEMS.map((it) => (
            <a
              key={it.href}
              href={it.href}
              role="menuitem"
              className="flex items-start gap-3 rounded-lg px-2.5 py-2.5 hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] transition-colors"
            >
              <span className={`shrink-0 grid place-items-center w-8 h-8 rounded-lg ${it.tint}`}>
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d={it.d} />
                </svg>
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4]">
                    {it.label}
                  </span>
                  {it.isNew && (
                    <span className="rounded px-1 py-px text-[9px] font-bold uppercase tracking-wide bg-amber-400/20 text-amber-600 dark:text-amber-400">
                      New
                    </span>
                  )}
                </span>
                <span className="block text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] leading-snug">
                  {it.desc}
                </span>
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
