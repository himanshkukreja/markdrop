"use client";

import { Icon } from "@/components/ui";
import { useComments } from "./context";
import "./comments.css";

/** The top bar's button: the open count, opens / closes the panel. */
export function CommentsButton({ className }: { className?: string }) {
  const c = useComments();
  // Anonymous readers of an item that keeps its comments private see a clean page (selecting text still
  // offers "Sign in to comment").
  if (!c || !c.enabled || (!c.user && !c.isPublic)) return null;
  const n = c.counts.open;
  return (
    <button type="button" className={`mdc-topbtn${c.panelOpen ? " is-on" : ""} ${className ?? ""}`}
      aria-pressed={c.panelOpen} aria-label={`Comments${n ? `, ${n} open` : ""}`} title="Comments"
      onClick={() => (c.panelOpen ? c.closePanel() : c.openPanel())}>
      <Icon name="message" />
      {n > 0 && <span className="mdc-topbtn__n">{n}</span>}
    </button>
  );
}
