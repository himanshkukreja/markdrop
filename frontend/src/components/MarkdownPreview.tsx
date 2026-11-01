"use client";

import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Schema } from "hast-util-sanitize";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { Children, createContext, isValidElement, useContext, useEffect, useMemo, useRef } from "react";
// KaTeX styles + fonts are bundled by the Next build (imported from a client component so they
// only load on pages that render markdown). Token overrides live in styles/prose.css.
import "katex/dist/katex.min.css";
import { Icon } from "@/components/ui";
import { CodeBlock } from "@/components/reading/CodeBlock";
import { DiagramFrame } from "@/components/reading/DiagramFrame";
import { HeadingAnchor } from "@/components/reading/HeadingAnchor";
import { Prose, type ProseSize } from "@/components/reading/Prose";
import { ScrollBox } from "@/components/reading/ScrollBox";
import { isHashSensitive, navigateToHeading, scrollToInitialHash } from "@/components/reading/navigate";
import { rehypeHeadingIds, type Heading } from "@/components/reading/slug";

// Extend the default sanitize schema to allow the class names our rehype plugins depend on.
// Pipeline order: highlight → sanitize → heading ids → katex. Sanitize must PRESERVE the hljs
// classes and the `math-inline` / `math-display` / `language-math` placeholders (added by
// remark-math) so rehype-katex finds them afterwards. The heading-id plugin and KaTeX run after
// sanitize: their output is generated from the markdown, never raw author HTML. No rehype-raw:
// raw HTML in markdown is dropped, so no author `style`/`class`/`color` attribute reaches the page.
const sanitizeSchema: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // rehype-highlight wraps tokens in <span class="hljs-...">
    span: [["className", /^hljs-/]],
    // language-* for fenced blocks (incl. language-mermaid), hljs for highlighted
    // blocks, and the remark-math placeholder classes so KaTeX can render them.
    code: [["className", /^language-/, "hljs", /^hljs-/, "math-inline", "math-display"]],
  },
};

// KaTeX writes its error colour inline; a token keeps it on-theme (REVAMP_PLAN 5.4).
const KATEX_OPTIONS = { errorColor: "var(--danger)" };
const REMARK_PLUGINS = [remarkGfm, remarkMath];

/* ── Helpers ─────────────────────────────────────────────────────────────────── */

/** Extract the raw text content of react-markdown children. */
function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as ReactElement<{ children?: ReactNode }>).props.children);
  }
  return "";
}

/** Per-render settings the (module-level, stable) markdown components read. */
interface ReadingSettings {
  anchors: boolean;
  encrypted: boolean;
  sectionBaseUrl?: string;
  onCodeCopy?: (code: string, block: HTMLElement | null) => void;
  /** Images from other sites wait for a click (an encrypted document, until the reader allows them). */
  blockRemoteImages?: boolean;
  onAllowRemoteImages?: () => void;
}
const ReadingContext = createContext<ReadingSettings>({ anchors: false, encrypted: false });

const API_HOST = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL || "https://api.markdrop.in").host;
  } catch {
    return "api.markdrop.in";
  }
})();

/**
 * An image address on someone else's server. Our own hosts (this origin, markdrop.in and its
 * subdomains, the API) and inline data are not: loading those tells no third party anything.
 */
export function isRemoteImage(src: unknown): boolean {
  if (typeof src !== "string" || !src.trim()) return false;
  const v = src.trim();
  if (/^(data|blob):/i.test(v)) return false;
  if (!/^([a-z][a-z0-9+.-]*:)?\/\//i.test(v)) return false; // relative: this origin
  try {
    const u = new URL(v, typeof window === "undefined" ? "https://markdrop.in" : window.location.href);
    const here = typeof window === "undefined" ? "" : window.location.host;
    if (u.host === here || u.host === API_HOST) return false;
    return !/(^|\.)markdrop\.in$/i.test(u.hostname);
  } catch {
    return true;
  }
}

/** Inline images (`![alt](https://…)`) whose address is remote. Reference-style images still get their own button. */
function hasRemoteImages(content: string): boolean {
  const re = /!\[[^\]]*\]\(\s*<?([^)\s>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) if (isRemoteImage(m[1])) return true;
  return false;
}

function hostOf(src: string): string {
  try {
    return new URL(src, "https://markdrop.in").hostname;
  } catch {
    return "another site";
  }
}

/* ── Markdown components (module-level so a parent re-render never remounts them) ── */

function MdPre({ children }: ComponentProps<"pre"> & ExtraProps) {
  const { onCodeCopy } = useContext(ReadingContext);
  const child = Children.toArray(children)[0];
  const className = isValidElement<{ className?: string }>(child) ? child.props.className ?? "" : "";
  const language = /(?:^|\s)language-([^\s]+)/.exec(className)?.[1];
  const text = extractText(children).replace(/\n$/, "");
  // A ```mermaid fence renders as a diagram (no <pre>, no copy strip).
  if (language === "mermaid") return <DiagramFrame code={text} />;
  return (
    <CodeBlock code={text} language={language} onCopy={onCodeCopy}>
      {children}
    </CodeBlock>
  );
}

// A CSS colour token, on its own, inside an inline `code` span → we prepend a swatch (matches
// GitHub's Color Reference behaviour). Regex-validated, so the value is safe to hand to an inline
// `style` background. The colour is the author's content, so it is shown as written.
const COLOR_RE =
  /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgb\(\s*[\d.]+%?(?:\s*[,\s]\s*[\d.]+%?){2}\s*\)|rgba\(\s*[\d.]+%?(?:\s*[,\s]\s*[\d.]+%?){2,3}\s*[,/]?\s*[\d.]*%?\s*\)|hsla?\(\s*[\d.]+(?:deg)?(?:\s*[,\s]\s*[\d.]+%?){2,3}\s*[,/]?\s*[\d.]*%?\s*\))$/i;

function MdCode({ node: _node, className, children, ...props }: ComponentProps<"code"> & ExtraProps) {
  // Inline colour swatch: only a bare inline span (fenced blocks always end with a newline).
  if (!className) {
    const value = extractText(children);
    if (!value.endsWith("\n") && COLOR_RE.test(value.trim())) {
      return (
        <code {...props}>
          <span className="md-swatch" style={{ backgroundColor: value.trim() }} aria-hidden />
          {children}
        </code>
      );
    }
  }
  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

/** In-document links (`#section`, footnotes) scroll without touching a sensitive hash. */
function MdLink({ node: _node, href, children, ...props }: ComponentProps<"a"> & ExtraProps) {
  const { encrypted } = useContext(ReadingContext);
  if (!href || !href.startsWith("#") || href.length < 2) {
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  }
  return (
    <a
      href={href}
      {...props}
      onClick={(e) => {
        // Modified clicks open a new tab: the current address (and its key) is untouched.
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (navigateToHeading(href, { encrypted })) e.preventDefault();
        // No target: still never let the browser rewrite a hash that holds a key or token.
        else if (encrypted || isHashSensitive()) e.preventDefault();
      }}
    >
      {children}
    </a>
  );
}

function makeHeading(Tag: "h1" | "h2" | "h3" | "h4") {
  function MdHeading({ node: _node, id, children, ...props }: ComponentProps<"h1"> & ExtraProps) {
    const { anchors, encrypted, sectionBaseUrl } = useContext(ReadingContext);
    const heading = (
      <Tag id={id} {...props}>
        {children}
      </Tag>
    );
    if (!anchors || encrypted || !id) return heading;
    // The anchor is a sibling, so the heading's accessible name stays its text.
    return (
      <div className="md-heading-wrap">
        {heading}
        <HeadingAnchor id={id} label={extractText(children)} encrypted={encrypted} baseUrl={sectionBaseUrl} />
      </div>
    );
  }
  MdHeading.displayName = `Md${Tag.toUpperCase()}`;
  return MdHeading;
}

function MdTable({ node: _node, children, ...props }: ComponentProps<"table"> & ExtraProps) {
  return (
    <ScrollBox className="md-table-box" scrollClassName="md-table-wrap" label="Table">
      <table className="md-table" {...props}>
        {children}
      </table>
    </ScrollBox>
  );
}

function MdImg({ node: _node, alt, ...props }: ComponentProps<"img"> & ExtraProps) {
  const { blockRemoteImages, onAllowRemoteImages } = useContext(ReadingContext);
  if (blockRemoteImages && isRemoteImage(props.src)) {
    // Not loaded: the other site would learn the reader's IP address and that this was opened.
    return (
      <span className="not-prose my-2 inline-flex max-w-full flex-wrap items-center gap-2 rounded-lg border border-dashed border-border-strong bg-surface-inset px-3 py-2 align-middle text-caption text-text-secondary">
        <Icon name="image" aria-hidden />
        <span className="min-w-0 break-words">
          {alt ? <><span className="text-text">{alt}</span> · </> : null}
          Image from {hostOf(String(props.src))}, not loaded
        </span>
        {onAllowRemoteImages && (
          <button type="button" onClick={onAllowRemoteImages}
            className="md-focus rounded-md px-1.5 py-0.5 font-semibold text-accent-text underline underline-offset-4">
            Load images
          </button>
        )}
      </span>
    );
  }
  // #gh-dark-mode-only / #gh-light-mode-only suffixes are handled in CSS by [data-theme] (D15).
  // eslint-disable-next-line @next/next/no-img-element
  return <img alt={alt ?? ""} loading="lazy" decoding="async" {...props} />;
}

/** GFM task-list checkboxes: disabled Checkbox visuals over the real (disabled) input. */
function MdInput({ node: _node, type, checked, ...props }: ComponentProps<"input"> & ExtraProps) {
  if (type !== "checkbox") return <input type={type} checked={checked} {...props} />;
  return (
    <span className="md-task-check">
      <input type="checkbox" checked={!!checked} disabled readOnly aria-label={checked ? "Completed task" : "Incomplete task"} />
      <span className="md-task-check__box" aria-hidden>
        <Icon name="check" />
      </span>
    </span>
  );
}

const COMPONENTS: Components = {
  pre: MdPre,
  code: MdCode,
  a: MdLink,
  h1: makeHeading("h1"),
  h2: makeHeading("h2"),
  h3: makeHeading("h3"),
  h4: makeHeading("h4"),
  table: MdTable,
  img: MdImg,
  input: MdInput,
};

/* ── MarkdownPreview ─────────────────────────────────────────────────────────── */

export interface MarkdownPreviewProps {
  content: string;
  /** "compact" (default; 14/22 for previews) or "reading" (17/28, the viewer). */
  size?: ProseSize;
  /** Heading anchor buttons (copy a section link). Default off; the viewer turns them on. */
  anchors?: boolean;
  /** End-to-end encrypted document: no anchors, and in-page navigation never touches the hash. */
  encrypted?: boolean;
  /** Base for copied section links (default origin + pathname). */
  sectionBaseUrl?: string;
  /** Receives the h1–h4 list (ids match the DOM) after each render that changes it. */
  onHeadings?: (headings: Heading[]) => void;
  /**
   * A code block's Copy was used: its code and the block element (the viewer counts copies for the
   * owner's analytics by a hash of the code, lib/engage.ts). Off unless given.
   */
  onCodeCopy?: (code: string, block: HTMLElement | null) => void;
  /**
   * "ask": images from other sites stay unloaded until the reader clicks "Load images from other
   * sites" (`onAllowRemoteImages`). The viewer asks for encrypted documents. Default "allow".
   */
  remoteImages?: "allow" | "ask";
  onAllowRemoteImages?: () => void;
  className?: string;
}

export default function MarkdownPreview({
  content,
  size = "compact",
  anchors = false,
  encrypted = false,
  sectionBaseUrl,
  onHeadings,
  onCodeCopy,
  remoteImages = "allow",
  onAllowRemoteImages,
  className,
}: MarkdownPreviewProps) {
  const blockRemoteImages = remoteImages === "ask";
  const collected = useRef<Heading[]>([]);
  const sent = useRef<string | null>(null);
  const onHeadingsRef = useRef(onHeadings);
  useEffect(() => {
    onHeadingsRef.current = onHeadings;
  });

  const rehypePlugins = useMemo(
    () => [
      // Order matters: highlight FIRST, then sanitize (so hljs/math classes aren't stripped),
      // then heading ids (trusted, generated), then katex LAST (renders the preserved math nodes;
      // its trusted output is intentionally not re-sanitized).
      rehypeHighlight,
      [rehypeSanitize, sanitizeSchema],
      [rehypeHeadingIds, { collect: (h: Heading[]) => (collected.current = h) }],
      [rehypeKatex, KATEX_OPTIONS],
    ] as NonNullable<ComponentProps<typeof ReactMarkdown>["rehypePlugins"]>,
    [],
  );

  // Memoised on the content: a parent re-render (live refresh state, theme, immersive toggle)
  // never re-runs the pipeline, and the rendered nodes (KaTeX included) are never re-created.
  const tree = useMemo(
    () => (
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={rehypePlugins} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    ),
    [content, rehypePlugins],
  );

  const settings = useMemo(
    () => ({ anchors, encrypted, sectionBaseUrl, onCodeCopy, blockRemoteImages, onAllowRemoteImages }),
    [anchors, encrypted, sectionBaseUrl, onCodeCopy, blockRemoteImages, onAllowRemoteImages],
  );
  const remoteNotice = useMemo(() => blockRemoteImages && hasRemoteImages(content), [blockRemoteImages, content]);

  useEffect(() => {
    const key = JSON.stringify(collected.current);
    if (key === sent.current) return;
    sent.current = key;
    onHeadingsRef.current?.(collected.current);
  }, [content]);

  // A shared section link (/slug#intro) can't scroll natively: the id is user-content-intro.
  const scrolled = useRef(false);
  useEffect(() => {
    if (!anchors || encrypted || scrolled.current || !content) return;
    scrolled.current = true;
    scrollToInitialHash();
  }, [anchors, encrypted, content]);

  return (
    <ReadingContext.Provider value={settings}>
      {remoteNotice && (
        <div role="note" className="no-print mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-surface px-4 py-3 text-caption text-text-secondary">
          <Icon name="image" aria-hidden className="text-text-muted" />
          <span className="min-w-0 flex-1 basis-60">
            This document has images from other sites. Loading them tells those sites your IP address and that you opened it.
          </span>
          {onAllowRemoteImages && (
            <button type="button" onClick={onAllowRemoteImages}
              className="md-focus rounded-md border border-border-strong bg-surface-raised px-3 py-1.5 text-caption-strong text-text hover:bg-surface-inset">
              Load images from other sites
            </button>
          )}
        </div>
      )}
      {/* ph-no-capture: rendered documents and previews are never recorded (lib/thirdPartyAnalytics). */}
      <Prose size={size} className={["ph-no-capture", className].filter(Boolean).join(" ")}>
        {tree}
      </Prose>
    </ReadingContext.Provider>
  );
}
