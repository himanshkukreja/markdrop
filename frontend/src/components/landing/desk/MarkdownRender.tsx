"use client";

import { useEffect, useState } from "react";
import MarkdownPreview from "@/components/MarkdownPreview";
import { MARKDOWN_SRC } from "./samples";
import s from "./Desk.module.css";

/**
 * notes.md, rendered by the same component that renders every Markdrop document (MarkdownPreview:
 * GFM tables, task lists, highlighted code, KaTeX, and the ```mermaid fence as a live diagram). The
 * sample is the real file (scripts/landing-samples/launch-notes.md, served from /landing-demo/files).
 * Its own chunk: the landing loads it only when a card needs it.
 */
export default function MarkdownRender({ onReady }: { onReady: () => void }) {
  const [md, setMd] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(MARKDOWN_SRC)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => live && setMd(text))
      .catch(() => {
        /* the poster stays */
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (md === null) return;
    // Mermaid draws after the first paint; give it a moment before the poster leaves.
    const t = window.setTimeout(onReady, 600);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [md]);

  return <div className={s.doc}>{md !== null && <MarkdownPreview content={md} size="compact" />}</div>;
}
