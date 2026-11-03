"use client";

/**
 * "✦ Use title ‘X’ · 🚀 · description": AI's suggestion for a page's title, icon and description,
 * near the title. One click uses all of it (through the page's own title and properties path);
 * × dismisses it. Never applied by itself.
 *
 * Asked from the ⋯ menu ("Suggest title & icon"), or once on its own when an untitled page first
 * has about 80 words (once per page in this browser).
 */
import { useEffect, useRef, useState } from "react";
import { Icon, Spinner, cx } from "@/components/ui";
import type { PageMeta } from "@/lib/pages-ai/client";
import "./pageAi.css";

export type MetaState = { phase: "loading" } | { phase: "ready"; meta: PageMeta } | { phase: "error"; message: string };

export function MetaChip({ state, onUse, onDismiss, hasIcon }: { state: MetaState; onUse: (m: PageMeta) => void; onDismiss: () => void; hasIcon: boolean }) {
  const use = useRef<HTMLButtonElement>(null);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => setLeaving(false), [state]);
  const go = (fn: () => void) => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return fn();
    setLeaving(true);
    window.setTimeout(fn, 110);
  };
  if (state.phase === "loading") {
    return (
      <div className="pb-aimeta pb-aimeta--loading no-print" role="status">
        <Spinner size={12} /> Suggesting a title…
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="pb-aimeta pb-aimeta--error no-print" role="status">
        <Icon name="alertCircle" size={13} aria-hidden /> <span>{state.message}</span>
        <button type="button" className="pb-aimeta__x md-focus" aria-label="Dismiss" onClick={onDismiss}>
          <Icon name="x" size={13} />
        </button>
      </div>
    );
  }
  const m = state.meta;
  const title = m.title?.trim();
  const icon = !hasIcon && m.icon?.trim() ? m.icon.trim() : null;
  const desc = m.description?.trim();
  if (!title && !icon && !desc) return null;
  return (
    <div className={cx("pb-aimeta no-print", leaving && "pb-aimeta--leaving")}>
      <button ref={use} type="button" className="pb-aimeta__use md-focus" onClick={() => go(() => onUse({ title: title || null, icon, description: desc || null }))} title={desc || undefined}>
        <Icon name="sparkle" size={13} className="pb-aimeta__spark" aria-hidden />
        <span className="pb-aimeta__verb">Use</span>
        {title && <span className="pb-aimeta__title ph-mask">title ‘{title}’</span>}
        {icon && <><span className="pb-aimeta__dot" aria-hidden>·</span><span className="pb-aimeta__icon" aria-label={`icon ${icon}`}>{icon}</span></>}
        {desc && <><span className="pb-aimeta__dot" aria-hidden>·</span><span className="pb-aimeta__desc ph-mask">description</span></>}
      </button>
      <button type="button" className="pb-aimeta__x md-focus" aria-label="Dismiss the suggestion" onClick={() => go(onDismiss)}>
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}
