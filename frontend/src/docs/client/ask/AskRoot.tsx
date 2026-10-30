"use client";

/**
 * Mounted once by the docs layout. Picks how the conversation shows (docked panel ≥1024px, right
 * drawer on tablets, bottom sheet on phones), loads the panel on first open, pushes the page over
 * while the docked panel is open (html[data-docs-ask]), and owns the shortcuts: ⌘I or ⌘/ toggles,
 * Esc closes.
 */
import dynamic from "next/dynamic";
import { useEffect, useState, useSyncExternalStore } from "react";
import { closeAsk, configureAsk, ensureStatus, toggleAsk, useAsk } from "./store";

const AskPanel = dynamic(() => import("./AskPanel"), { ssr: false });

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function AskRoot({ siteUrl, suggestions = [] }: { siteUrl: string; suggestions?: string[] }) {
  const s = useAsk();
  const wide = useMedia("(min-width: 1024px)");
  const phone = useMedia("(max-width: 639px)");
  const mode = wide ? "docked" : phone ? "sheet" : "drawer";
  const [loaded, setLoaded] = useState(false);

  useEffect(() => configureAsk(siteUrl), [siteUrl]);

  useEffect(() => {
    if (!s.open) return;
    setLoaded(true);
    void ensureStatus();
  }, [s.open]);

  useEffect(() => {
    const d = document.documentElement;
    if (s.open && mode === "docked") d.setAttribute("data-docs-ask", s.full ? "full" : "open");
    else d.removeAttribute("data-docs-ask");
    return () => d.removeAttribute("data-docs-ask");
  }, [s.open, s.full, mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === "i" || e.key === "/")) {
        e.preventDefault();
        toggleAsk();
        return;
      }
      // Esc anywhere outside a field or overlay closes the docked panel.
      if (e.key === "Escape" && !e.defaultPrevented) {
        const t = e.target as HTMLElement | null;
        const inField = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
        if (!inField && document.documentElement.hasAttribute("data-docs-ask") && !document.querySelector("[aria-modal='true']")) closeAsk();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!loaded) return null;
  if (mode === "docked" && !s.open) return null;
  return <AskPanel mode={mode} suggestions={suggestions} />;
}
