"use client";

/**
 * Phones: Ask AI ✦ as a bottom sheet (the format toolbar's button, ⌘J, a page's phone bar). It
 * slides up over a scrim; tap the scrim, drag the handle down or press Esc to close. Transform and
 * opacity only; instant with reduced motion.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { Icon } from "@/components/ui";
import type { AssistStore } from "./assist";
import { AiMenu, type AiPick } from "./aiMenu";
import { useHost } from "../host";
import { reducedMotion } from "./motion";
import { cx } from "../views/shared";

export function AiSheet({ editor, store }: { editor: Editor; store: AssistStore }) {
  useSyncExternalStore(store.subscribe, store.get, store.get);
  const host = useHost();
  const open = store.sheet;
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number; id: number } | null>(null);
  // The selection when the sheet opened (tapping the sheet can blur the page on some phones).
  const sel = useRef<{ from: number; to: number } | null>(null);

  useEffect(() => {
    if (open) {
      const { from, to } = editor.state.selection;
      sel.current = from !== to ? { from, to } : null;
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const t = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, reducedMotion() ? 0 : 160);
    return () => window.clearTimeout(t);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!mounted || typeof document === "undefined") return null;
  const close = () => store.openSheet(false);
  const pick = (p: AiPick) => {
    close();
    const r = sel.current;
    if (r && !editor.isDestroyed && editor.state.selection.empty) editor.commands.setTextSelection(r);
    if (r && "command" in p) store.actions(editor, "selection");
    else if (r && !("command" in p)) store.start(editor, p.action, { tone: p.tone, lang: p.lang });
    else store.openPrompt(editor);
  };

  return createPortal(
    <div className={cx("dxe-aisheet", closing && "dxe-aisheet--closing")} onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="dxe-aisheet__scrim" onClick={close} aria-hidden />
      <div
        ref={panel}
        className="dxe-aisheet__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Ask AI"
        onPointerDown={(e) => {
          if (!(e.target as HTMLElement).closest(".dxe-aisheet__grab")) return;
          drag.current = { y: e.clientY, dy: 0, id: e.pointerId };
          panel.current?.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || !panel.current) return;
          d.dy = Math.max(0, e.clientY - d.y);
          panel.current.style.transition = "none";
          panel.current.style.transform = `translate3d(0, ${d.dy}px, 0)`;
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (!d || !panel.current) return;
          panel.current.style.transition = "";
          panel.current.style.transform = "";
          if (d.dy > 80) close();
        }}
      >
        <div className="dxe-aisheet__grab" aria-hidden />
        <div className="dxe-aisheet__title">
          <Icon name="sparkle" size={16} aria-hidden /> Ask AI
        </div>
        {sel.current ? (
          <AiMenu sheet onPick={pick} onClose={close} off={host.ai?.off} languages={host.ai ? host.ai.languages : host.assistLanguages} legacy={!host.ai} actions={!!host.ai?.actionItems} />
        ) : (
          <div className="dxe-aim dxe-aim--sheet">
            {host.ai?.off ? (
              <p className="dxe-aim__off" role="note"><Icon name="info" size={14} aria-hidden /> {host.ai.off}</p>
            ) : (
              <button type="button" className="dxe-aim__item" onClick={() => pick({ action: "improve" })}>
                <span className="dxe-aim__icon" aria-hidden><Icon name="edit" size={15} /></span>
                <span className="dxe-aim__label">Ask AI to write…</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
