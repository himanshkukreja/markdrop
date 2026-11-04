"use client";

/**
 * Ask AI ✦: what AI can do with the selection. Under the format toolbar's button on wide screens,
 * in a bottom sheet on phones (aiSheet). Tone ▸ and Translate ▸ open in place (← or Back returns);
 * Translate searches its languages and takes any other typed name.
 *
 * Keys: ↑/↓ move, → or Enter opens a submenu, ← goes back, Esc goes back or closes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui";
import { cx } from "../views/shared";
import type { AiAction, AiTone } from "../types";

export type AiPick = { action: AiAction; tone?: AiTone; lang?: string } | { command: "actions" };

export const AI_ACTIONS: Record<AiAction, { label: string; icon: string }> = {
  improve: { label: "Improve writing", icon: "sparkle" },
  shorten: { label: "Make shorter", icon: "minimize" },
  fix: { label: "Fix spelling & grammar", icon: "checkCircle" },
  tone: { label: "Change tone", icon: "message" },
  translate: { label: "Translate", icon: "globe" },
  checklist: { label: "Turn into checklist", icon: "checkSquare" },
  table: { label: "Turn into table", icon: "table" },
  explain: { label: "Explain", icon: "bulb" },
};

export const TONES: Array<[AiTone, string, string]> = [
  ["professional", "Professional", "Clear and polished"],
  ["friendly", "Friendly", "Warm and approachable"],
  ["concise", "Concise", "Short and to the point"],
];

/** Translate offers these first when the host gives no list (any other can be typed). */
export const COMMON_LANGUAGES = [
  "English", "Spanish", "French", "German", "Portuguese", "Italian", "Dutch", "Japanese", "Korean", "Chinese (Simplified)",
  "Chinese (Traditional)", "Hindi", "Arabic", "Russian", "Turkish", "Polish", "Indonesian", "Vietnamese", "Thai", "Swedish",
  "Ukrainian", "Hebrew", "Greek", "Czech", "Danish", "Finnish", "Norwegian", "Romanian", "Hungarian", "Bengali", "Tamil", "Malay",
];

type View = "main" | "tone" | "lang";

interface Row {
  key: string;
  label: string;
  icon?: string;
  hint?: string;
  sub?: boolean;
  run: () => void;
}

export function AiMenu({ onPick, onClose, off, languages, legacy = false, actions = true, sheet = false }: {
  onPick: (p: AiPick) => void;
  onClose: () => void;
  /** AI can't be used here: the menu says why instead. */
  off?: string | null;
  languages?: string[];
  /** The older, non-streaming Ask AI (a host's `assist`): its four actions only. */
  legacy?: boolean;
  /** "Find action items" is offered. */
  actions?: boolean;
  sheet?: boolean;
}) {
  const [view, setView] = useState<View>("main");
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const langs = languages?.length ? languages : COMMON_LANGUAGES;
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? langs.filter((l) => l.toLowerCase().includes(t)) : langs;
  }, [langs, q]);

  // A new view: its first row (or the search) has the focus.
  useEffect(() => {
    if (view === "lang") search.current?.focus({ preventScroll: true });
    else ref.current?.querySelector<HTMLButtonElement>(".dxe-aim__item")?.focus({ preventScroll: true });
  }, [view]);

  const pick = (p: AiPick) => {
    onPick(p);
  };
  const act = (a: AiAction): Row => ({ key: a, label: AI_ACTIONS[a].label, icon: AI_ACTIONS[a].icon, run: () => pick({ action: a }) });

  const groups: Array<{ head: string; rows: Row[] }> = legacy
    ? [{ head: "Edit", rows: [act("improve"), act("shorten"), act("fix"), ...(languages?.length ? [{ ...act("translate"), sub: true, run: () => setView("lang") }] : [])] }]
    : [
        {
          head: "Edit",
          rows: [act("improve"), act("shorten"), act("fix"), { ...act("tone"), sub: true, run: () => setView("tone") }, { ...act("translate"), sub: true, run: () => setView("lang") }],
        },
        {
          head: "Transform",
          rows: [act("checklist"), act("table"), ...(actions ? [{ key: "actions", label: "Find action items", icon: "flag", run: () => pick({ command: "actions" }) }] : [])],
        },
        { head: "Understand", rows: [act("explain")] },
      ];

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(".dxe-aim__item, .dxe-aim__search input") ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const inSearch = document.activeElement === search.current;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const n = items.length;
      if (!n) return;
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + n) % n]?.focus();
    } else if (e.key === "ArrowRight" && !inSearch) {
      e.stopPropagation();
      const el = document.activeElement as HTMLElement | null;
      if (el?.dataset.sub) {
        e.preventDefault();
        el.click();
      }
    } else if ((e.key === "ArrowLeft" && !inSearch) || (e.key === "Backspace" && inSearch && !q)) {
      e.stopPropagation();
      if (view !== "main") {
        e.preventDefault();
        setView("main");
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (view !== "main") setView("main");
      else onClose();
    }
  };

  const back = (title: string) => (
    <div className="dxe-aim__back">
      <button type="button" className="dxe-aim__backbtn" aria-label="Back" onMouseDown={(e) => e.preventDefault()} onClick={() => setView("main")}>
        <Icon name="chevronLeft" size={15} />
      </button>
      <span>{title}</span>
    </div>
  );

  const item = (r: Row) => (
    <button
      key={r.key}
      type="button"
      role="menuitem"
      className="dxe-aim__item"
      data-sub={r.sub ? "" : undefined}
      aria-haspopup={r.sub ? "menu" : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={r.run}
    >
      {r.icon && <span className="dxe-aim__icon" aria-hidden><Icon name={r.icon} size={15} /></span>}
      <span className="dxe-aim__label">{r.label}</span>
      {r.hint && <span className="dxe-aim__hint">{r.hint}</span>}
      {r.sub && <Icon name="chevronRight" size={14} className="dxe-aim__chev" aria-hidden />}
    </button>
  );

  return (
    <div ref={ref} role="menu" aria-label="Ask AI" className={cx("dxe-aim", sheet && "dxe-aim--sheet")} onKeyDown={onKeyDown}>
      {off ? (
        <p className="dxe-aim__off" role="note">
          <Icon name="info" size={14} aria-hidden /> {off}
        </p>
      ) : view === "main" ? (
        <div key="main" className="dxe-aim__view">
          {groups.map((g) => (
            <div key={g.head} className="dxe-aim__group" role="group" aria-label={g.head}>
              <div className="dxe-aim__ghead" aria-hidden>{g.head}</div>
              {g.rows.map(item)}
            </div>
          ))}
        </div>
      ) : view === "tone" ? (
        <div key="tone" className="dxe-aim__view dxe-aim__view--sub">
          {back("Change tone")}
          {TONES.map(([t, label, hint]) => item({ key: t, label, hint, run: () => pick({ action: "tone", tone: t }) }))}
        </div>
      ) : (
        <div key="lang" className="dxe-aim__view dxe-aim__view--sub">
          {back("Translate to")}
          <div className="dxe-aim__search">
            <Icon name="search" size={14} aria-hidden />
            <input
              ref={search}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search or type a language"
              aria-label="Search languages"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const l = shown[0] ?? q.trim();
                  if (l) pick({ action: "translate", lang: l });
                }
              }}
            />
          </div>
          <div className="dxe-aim__list">
            {shown.map((l) => item({ key: l, label: l, run: () => pick({ action: "translate", lang: l }) }))}
            {!shown.length && q.trim() && !legacy && item({ key: "custom", label: `Translate to “${q.trim()}”`, icon: "globe", run: () => pick({ action: "translate", lang: q.trim() }) })}
            {!shown.length && (legacy || !q.trim()) && <p className="dxe-aim__none">No language matches.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
