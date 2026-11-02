"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/lib/theme";
import type { DeskFile } from "./samples";
import s from "./Hero.module.css";

/**
 * A real viewer page in a sandboxed frame (the artifact Worker's PDF / spreadsheet / video viewers
 * and the HTML sample, under /landing-demo/), laid out at the screen's own width, so its text is at
 * its real size. Frames are sandboxed like Markdrop's own embeds: sandbox="allow-scripts", no
 * allow-same-origin (the pages repeat it as a CSP header, next.config.ts).
 */
export default function FrameRender({ file, onReady }: { file: DeskFile; onReady: () => void }) {
  const { resolved } = useTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [mounted, setMounted] = useState(false);
  const theme = resolved === "dark" ? "dark" : "light";
  const src = (file.frame ?? "").replace("{theme}", theme);
  const doneRef = useRef(false);
  const done = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onReady();
  };

  useEffect(() => setMounted(true), []);

  // The PDF viewer says when the document is laid out (its analytics bridge: {md:1, ev:"pdf"}).
  useEffect(() => {
    if (file.id !== "pdf") return;
    const on = (e: MessageEvent) => {
      if (e.source === frame.current?.contentWindow && e.data && e.data.md === 1 && e.data.ev === "pdf") window.setTimeout(done, 400);
    };
    window.addEventListener("message", on);
    const t = window.setTimeout(done, 6000);
    return () => {
      window.removeEventListener("message", on);
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  if (!mounted) return null;
  return (
    <iframe
      ref={frame}
      key={src}
      src={src}
      title={`${file.name}, rendered by Markdrop`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className={s.frame}
      onLoad={() => {
        if (file.id !== "pdf") window.setTimeout(done, file.id === "sheet" ? 700 : 250);
      }}
    />
  );
}
