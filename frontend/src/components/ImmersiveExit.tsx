"use client";

import { useEffect, useState } from "react";
import { ImmersiveExit as DSImmersiveExit } from "@/components/ui";
import s from "./ImmersiveExit.module.css";

/**
 * The one control visible while a document or artifact is shown full-bleed.
 *
 * Shown to everyone, not just owners: the framed view is where Report, Edit and
 * the rest of the chrome live, so a visitor who couldn't leave immersive mode
 * would have no way to flag abusive content.
 *
 * It never fades by opacity (45% failed contrast in light). Instead, after 2s
 * without a scroll up or pointer movement it "quietens" to a `surface` chip with
 * a muted icon, and comes back on scroll-up, pointer movement or keyboard focus
 * (REVAMP_PLAN 7.6). The DS component ignores `quiet` under reduced motion.
 *
 * The corner is the caller's choice because the safe corner depends on what the
 * framed content puts at its own edges, and the iframe is cross-origin so we
 * cannot measure it. Bottom-right is the default: PDF.js, SheetJS and plenty of
 * user-authored pages anchor toolbars top-right. The video player is the
 * exception -- its transport bar owns the bottom edge, fullscreen and PiP
 * included -- so video asks for top-right instead.
 *
 * Hidden while a modal Dialog/Drawer is open (it sits above dialog scrims).
 */
export default function ImmersiveExit({
  onExit,
  placement = "bottom-right",
  label = "Show details",
  className,
}: {
  onExit: () => void;
  placement?: "bottom-right" | "top-right";
  label?: string;
  className?: string;
}) {
  const [quiet, setQuiet] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const lastTop = new WeakMap<EventTarget, number>();
    const wake = () => {
      setQuiet(false);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setQuiet(true), 2000);
    };
    const onScroll = (e: Event) => {
      const t = e.target;
      const el = t instanceof Element ? t : document.scrollingElement;
      if (!el || !t) return;
      const top = el.scrollTop;
      const prev = lastTop.get(t) ?? top;
      lastTop.set(t, top);
      if (top < prev) wake();
    };
    wake();
    window.addEventListener("pointermove", wake, { passive: true });
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, []);

  return (
    <DSImmersiveExit
      onExit={onExit}
      placement={placement}
      quiet={quiet}
      label={label}
      className={["no-print", s.exit, className].filter(Boolean).join(" ")}
    />
  );
}
