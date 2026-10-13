"use client";
/**
 * Screen-reader plumbing (REVAMP_PLAN 8.2, 11.2).
 * - `StatusRegion`: one visually hidden polite live region. Mount it once at the root.
 * - `announce(text)`: sets that region's text. It clears first, so the same message twice in a row
 *   ("Copied", "Copied") is announced twice. Buttons never carry aria-live themselves (unreliable
 *   while they hold focus).
 * - `VisuallyHidden`, `SkipLink`.
 */
import React, { useEffect, useRef } from "react";

let region: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function fallbackRegion(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  let el = document.querySelector<HTMLElement>("[data-md-status-region]");
  if (!el) {
    // No StatusRegion mounted (a preview page, a test): make one so announcements aren't lost.
    el = document.createElement("div");
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.setAttribute("aria-atomic", "true");
    el.setAttribute("data-md-status-region", "");
    el.className = "md-visually-hidden";
    document.body.appendChild(el);
  }
  return el;
}

/** Announce `text` politely through the shared status region. Safe to call anywhere on the client. */
export function announce(text: string) {
  const el = region && region.isConnected ? region : fallbackRegion();
  if (!el) return;
  el.textContent = "";
  if (timer) clearTimeout(timer);
  // A short gap so assistive tech sees a change even when the text repeats.
  timer = setTimeout(() => { el.textContent = text; }, 60);
}

/** The one polite live region `announce()` writes to. Mount once, near the root. */
export function StatusRegion() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    region = el;
    return () => { if (region === el) region = null; };
  }, []);
  return <div ref={ref} role="status" aria-live="polite" aria-atomic="true" className="md-visually-hidden" data-md-status-region="" />;
}

export interface VisuallyHiddenProps extends React.HTMLAttributes<HTMLElement> { as?: React.ElementType; children?: React.ReactNode; }
/** Text for screen readers only. */
export function VisuallyHidden({ as: As = "span", className, ...rest }: VisuallyHiddenProps) {
  return <As className={"md-visually-hidden" + (className ? " " + className : "")} {...rest} />;
}

export interface SkipLinkProps { href?: string; children?: React.ReactNode; className?: string; }
/**
 * "Skip to content": the first focusable element of a shell, visible only on focus. It moves focus
 * to the target without touching `location.hash`, because the hash can hold an E2E key (`#k=`)
 * or a tenant token that a plain `href="#main"` navigation would wipe.
 */
export function SkipLink({ href = "#main", children = "Skip to content", className }: SkipLinkProps) {
  return (
    <a
      href={href}
      className={"md-skiplink" + (className ? " " + className : "")}
      onClick={(e) => {
        const id = href.startsWith("#") ? href.slice(1) : "";
        const target = id ? document.getElementById(id) : null;
        if (!target) return;
        e.preventDefault();
        if (!target.hasAttribute("tabindex") && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "start" });
      }}
    >
      {children}
    </a>
  );
}
