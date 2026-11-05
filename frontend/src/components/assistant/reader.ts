"use client";

/**
 * Where a reader is in a doc (no editor): the heading of the section in view and the last text they
 * selected in it. The selection is remembered when focus moves to the assistant's question box (a
 * textarea takes the page's selection away), and forgotten when they click elsewhere in the doc.
 */
import { useCallback, useEffect, useRef } from "react";
import type { AssistantReader } from "@/lib/ask";
import { useAssistantReader } from "./store";

const TOP = 140;

export function headingInView(root: HTMLElement | null): string | null {
  if (!root) return null;
  let heading: string | null = null;
  for (const h of Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4"))) {
    if (h.getBoundingClientRect().top > TOP) break;
    heading = (h.textContent || "").replace(/\s+/g, " ").trim() || heading;
  }
  return heading;
}

/** Registers the reader's place for the assistant while `root` is on screen (and `on`). */
export function useDocReader(root: React.RefObject<HTMLElement | null>, on: boolean) {
  const sel = useRef<string>("");
  useEffect(() => {
    if (!on) return;
    const onChange = () => {
      const s = window.getSelection();
      const el = root.current;
      if (!s || !el || !s.anchorNode || !el.contains(s.anchorNode)) return; // focus went elsewhere: keep it
      sel.current = s.isCollapsed ? "" : s.toString().trim().slice(0, 1500);
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [on, root]);
  const read = useCallback((): AssistantReader | null => ({ heading: headingInView(root.current), selection: sel.current || null }), [root]);
  useAssistantReader(on ? read : null);
}
