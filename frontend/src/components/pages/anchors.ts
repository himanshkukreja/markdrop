"use client";

/**
 * Block anchors: a page opened at `#b-xxxx` scrolls to that block and highlights it (Notion's
 * "Copy link to block"). The block carries `data-bid` in the reader and in the editor.
 */
import { useEffect, type RefObject } from "react";

const HASH = /^#(b-[a-z0-9]{4,12})$/;

/** Scrolls to the block with this anchor under `root` and flashes it; false when it isn't there. */
export function revealBlock(root: ParentNode, id: string): boolean {
  const el = root.querySelector<HTMLElement>(`[data-bid="${CSS.escape(id)}"]`);
  if (!el) return false;
  // An anchor inside a closed toggle: open it first.
  for (let p = el.parentElement; p; p = p.parentElement) if (p instanceof HTMLDetailsElement && !p.open) p.open = true;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("pb-flash");
  void el.offsetWidth;
  el.classList.add("pb-flash");
  window.setTimeout(() => el.classList.remove("pb-flash"), 2400);
  return true;
}

/** On open and on hash changes: find `#b-…` under `root` (retrying while the page still renders). */
export function useBlockAnchor(root: RefObject<HTMLElement | null>, ready = true) {
  useEffect(() => {
    if (!ready) return;
    let timer = 0;
    const go = () => {
      const m = HASH.exec(window.location.hash);
      if (!m || !root.current) return;
      let tries = 0;
      const attempt = () => {
        if (!root.current) return;
        if (revealBlock(root.current, m[1]) || ++tries > 20) return;
        timer = window.setTimeout(attempt, 150);
      };
      attempt();
    };
    go();
    window.addEventListener("hashchange", go);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("hashchange", go);
    };
  }, [root, ready]);
}

/** The page's address with `#b-…` (what "Copy link to block" copies). */
export function blockLink(id: string): string {
  return `${window.location.origin}${window.location.pathname.replace(/\/$/, "")}#${id}`;
}
