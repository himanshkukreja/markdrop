"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Spinner, cx } from "@/components/ui";
import { engineTheme } from "@/lib/guideThemes";
import type { SiteTheme } from "@/lib/docsSites";
import { PREVIEW_PATH, isPreviewReady, type PreviewPage, type PreviewState } from "./protocol";

/**
 * The builder's live preview: /guides/theme-preview in a same-origin iframe, sent the design on
 * every change (no reload). "Phone" is a 390px-wide frame, so the engine's own breakpoints apply.
 */
export function LivePreview({ theme, name, logo, dark, page, device, className }: {
  theme: SiteTheme;
  name: string;
  logo: string | null;
  dark: boolean;
  page: PreviewPage;
  device: "desktop" | "phone";
  className?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const latest = useRef<PreviewState | null>(null);
  const { theme: t, brand } = engineTheme(theme);
  const state: PreviewState = { type: "guide-theme-preview:state", theme: t, brand, name, logo, dark, page };
  latest.current = state;
  const key = JSON.stringify(state);

  const post = useCallback(() => {
    const w = frame.current?.contentWindow;
    if (w && latest.current) w.postMessage(latest.current, window.location.origin);
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== frame.current?.contentWindow || !isPreviewReady(e.data)) return;
      setReady(true);
      post();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [post]);

  useEffect(() => {
    if (ready) post();
  }, [key, ready, post]);

  return (
    <div className={cx("relative flex min-h-0 flex-1 justify-center overflow-auto", className)}>
      <div
        className={cx(
          "relative flex min-h-0 overflow-hidden bg-surface shadow-lg transition-[width] duration-200",
          device === "phone" ? "my-2 w-[390px] shrink-0 rounded-[28px] border-[6px] border-text" : "w-full rounded-xl border border-border",
        )}
      >
        {!ready && (
          <div className="absolute inset-0 grid place-items-center bg-surface" aria-hidden>
            <Spinner size={20} />
          </div>
        )}
        <iframe
          ref={frame}
          src={PREVIEW_PATH}
          title={`Live preview of ${name}, ${page === "home" ? "home page" : "an article"}, ${dark ? "dark" : "light"}`}
          className="ph-no-capture block h-full min-h-[480px] w-full flex-1 border-0"
          // Same origin (the preview reads nothing of the studio's): scripts for the engine's islands only.
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
    </div>
  );
}
