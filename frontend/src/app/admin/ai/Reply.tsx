"use client";

/**
 * A logged reply, rendered the way the person saw it: GFM Markdown (headings, lists, tables, code),
 * no raw HTML (react-markdown drops it), no images (their alt text instead), http(s) and site-relative
 * links only. Citation markers ([1], [S3], [3-s2], [M2-s14]) that match a citation's label, n or id
 * become small numbered chips linking to the source (a new tab). Numbers follow the order the reply
 * first cites them, like the chats do (components/chat, docs Ask), and the sources list uses the same.
 */
import { memo, useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PhrasingContent, Root, RootContent } from "mdast";
import type { Citation } from "./requestsShared";
import s from "./reply.module.css";

const CITE = /\[((?:[A-Za-z]?\d{1,4}(?:-[A-Za-z]\d{1,5})?)|(?:[A-Za-z]\d{1,5}))\]/g;
const HAS_CITE = new RegExp(CITE.source);
const CITE_HREF = "#air-cite-";

const keysOf = (c: Citation) => [c.label, c.n === undefined ? undefined : String(c.n), c.id]
  .filter((k): k is string => typeof k === "string" && k !== "").map((k) => k.toUpperCase());

/** Each citation's number: the order the text first cites it, then the uncited ones. */
export function citationNumbers(text: string, cites: Citation[]): { byKey: Map<string, number>; byIndex: number[] } {
  const keyToIndex = new Map<string, number>();
  cites.forEach((c, i) => keysOf(c).forEach((k) => { if (!keyToIndex.has(k)) keyToIndex.set(k, i); }));
  const byIndex: number[] = new Array(cites.length).fill(0);
  let next = 1;
  for (const m of (text || "").matchAll(CITE)) {
    const i = keyToIndex.get(m[1].toUpperCase());
    if (i !== undefined && !byIndex[i]) byIndex[i] = next++;
  }
  cites.forEach((_, i) => { if (!byIndex[i]) byIndex[i] = next++; });
  const byKey = new Map<string, number>();
  for (const [k, i] of keyToIndex) byKey.set(k, i);
  return { byKey, byIndex };
}

export const citationHref = (c: Citation) => safeHref(c.web_url || c.url || "");

function safeHref(href: string): string | null {
  if (!href) return null;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** remark plugin: [3-s2] in text → a link node the `a` renderer draws as a chip; unknown markers are
 *  dropped (as the chats drop them) when the reply has sources, and a run of the same marker collapses to one chip. */
function remarkCitations(known: Set<string>) {
  return () => (tree: Root) => {
    if (!known.size) return; // no sources: the text stays exactly as logged
    const visit = (node: { children?: RootContent[] | PhrasingContent[] }) => {
      if (!node.children) return;
      const out: RootContent[] = [];
      for (const child of node.children as RootContent[]) {
        if (child.type === "text" && HAS_CITE.test(child.value)) {
          let last = 0;
          let prev: { end: number; key: string } | null = null;
          for (const m of child.value.matchAll(CITE)) {
            const at = m.index ?? 0;
            const key = m[1].toUpperCase();
            if (at > last) out.push({ type: "text", value: child.value.slice(last, at) });
            const dup = prev && prev.end === at && prev.key === key;
            if (known.has(key) && !dup) out.push({ type: "link", url: CITE_HREF + encodeURIComponent(key), children: [{ type: "text", value: m[1] }] });
            prev = { end: at + m[0].length, key };
            last = at + m[0].length;
          }
          if (last < child.value.length) out.push({ type: "text", value: child.value.slice(last) });
          continue;
        }
        if (child.type !== "link" && child.type !== "code" && child.type !== "inlineCode" && "children" in child) visit(child as { children: RootContent[] });
        out.push(child);
      }
      (node as { children: RootContent[] }).children = out;
    };
    visit(tree);
  };
}

type AProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown };

export const Reply = memo(function Reply({ text, format, citations }: { text: string; format: "markdown" | "text" | "json"; citations: Citation[] }) {
  const nums = useMemo(() => citationNumbers(text, citations), [text, citations]);
  const known = useMemo(() => new Set(nums.byKey.keys()), [nums]);
  const plugins = useMemo(() => [remarkGfm, remarkCitations(known)], [known]);
  const components = useMemo<Components>(() => ({
    a: ({ href, children }: AProps) => {
      const h = typeof href === "string" ? href : "";
      if (h.startsWith(CITE_HREF)) {
        const i = nums.byKey.get(decodeURIComponent(h.slice(CITE_HREF.length)));
        if (i === undefined) return null;
        const c = citations[i];
        const n = nums.byIndex[i];
        const label = `Source ${n}: ${[c.title, c.subtitle, c.moment].filter(Boolean).join(" · ") || "untitled"}`;
        const url = citationHref(c);
        if (!url) return <span className={s.cite} data-nolink="" title={label} aria-label={label}>{n}</span>;
        return <a className={s.cite} href={url} target="_blank" rel="noopener noreferrer nofollow" title={label} aria-label={label}>{n}</a>;
      }
      const safe = safeHref(h);
      if (!safe) return <span>{children}</span>;
      return <a href={safe} target="_blank" rel="noopener noreferrer nofollow">{children}</a>;
    },
    img: ({ alt }) => <span className={s.img}>[image{alt ? `: ${alt}` : ""}]</span>,
    table: ({ children }) => <div className={s.table}><table>{children}</table></div>,
  }), [nums, citations]);

  if (format === "json") {
    let pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* as logged */ }
    return <pre className={s.json}>{pretty}</pre>;
  }
  if (format === "text") return <p className={s.plain}>{text}</p>;
  return (
    <div className={s.md}>
      <Markdown remarkPlugins={plugins} components={components}>{text}</Markdown>
    </div>
  );
});
