"use client";

/**
 * The PDF export: the page (and the sub-pages asked for) drawn by the reader's own renderer in a
 * print-only layer, always in the light theme, then the browser's print dialog ("Save as PDF").
 * No chrome: while it's up, printing shows this layer and nothing else (export.css). Each page
 * starts on a new sheet with its cover as a header; blocks don't split across sheets.
 *
 * It waits for what the page loads on its own (embeds, images, diagrams, fonts) before printing,
 * up to a limit, so the PDF doesn't catch it half drawn.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ThemeScope } from "@/components/ui";
import { assetId } from "@/lib/pageAddress.mjs";
import type { AssetUrl, Crumb } from "@/lib/pages";
import { PageFrame } from "../PageChrome";
import { PageHead } from "../PageHead";
import { PageRenderer } from "../PageRenderer";
import { readPageProps } from "../pageProps";
import "./export.css";

export interface PrintPage {
  slug: string;
  title: string | null;
  content: string;
  assets: Record<string, AssetUrl> | null;
  crumbs: Crumb[];
}

const BUSY = ".pb-embed--loading, .md-diagram__loading, [aria-busy='true']";
const MAX_WAIT_MS = 12_000;

/** Every image eager, and whether they've all finished (loaded or failed). */
function imagesSettled(root: HTMLElement): boolean {
  let ok = true;
  root.querySelectorAll("img").forEach((img) => {
    if (img.loading === "lazy") img.loading = "eager";
    if (!img.complete) ok = false;
  });
  return ok;
}

export function PrintPages({ pages, viewer = null, onReady }: { pages: PrintPage[]; viewer?: string | null; onReady: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  useEffect(() => {
    const el = document.createElement("div");
    el.className = "pbx-print-host";
    document.body.appendChild(el);
    document.documentElement.classList.add("pbx-printing");
    setHost(el);
    return () => {
      document.documentElement.classList.remove("pbx-printing");
      el.remove();
    };
  }, []);

  useEffect(() => {
    if (!host) return;
    const start = performance.now();
    let timer = 0;
    let done = false;
    const tick = () => {
      const el = root.current;
      const waited = performance.now() - start;
      const settled = !!el && waited > 400 && !el.querySelector(BUSY) && imagesSettled(el);
      if (settled || waited > MAX_WAIT_MS) {
        const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready ?? Promise.resolve();
        void fonts.then(() => requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!done) {
            done = true;
            readyRef.current();
          }
        })));
        return;
      }
      timer = window.setTimeout(tick, 150);
    };
    timer = window.setTimeout(tick, 150);
    return () => {
      done = true;
      window.clearTimeout(timer);
    };
  }, [host, pages]);

  if (!host) return null;
  return createPortal(
    <div ref={root} className="pbx-print" aria-hidden>
      <ThemeScope theme="light" className="pbx-print__scope">
        {pages.map((p) => {
          const props = readPageProps(p.content);
          const resolve = (src: string) => {
            const id = assetId(src);
            return id ? p.assets?.[id]?.url ?? "" : src;
          };
          const layout = [props.smallText && "pb-small", props.font !== "default" && `pb-font-${props.font}`].filter(Boolean).join(" ");
          return (
            <section key={p.slug} className="pbx-print__page" data-cover={props.cover ? "" : undefined}>
              <PageFrame bar={null} layout={layout} full={props.fullWidth} head={<PageHead title={p.title} props={props} resolve={resolve} />}>
                <PageRenderer slug={p.slug} content={p.content} assets={p.assets} crumbs={p.crumbs} title={p.title} viewer={viewer} />
              </PageFrame>
            </section>
          );
        })}
      </ThemeScope>
    </div>,
    host,
  );
}

export default PrintPages;
