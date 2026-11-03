"use client";

/**
 * A page (a document in the block editor) as readers see it: Markdown with the block syntax
 * (callouts, toggles, checklists, tables, code, math, page images, embeds and mentions of Markdrop
 * items). The same pipeline as MarkdownPreview (highlight → sanitize → heading ids → KaTeX, no raw
 * HTML), plus remark-directive and remarkPageBlocks, whose markers are the only extra attributes
 * the sanitizer lets through.
 *
 * Embeds and mentions are resolved for this viewer in one batch (usePageEmbeds); what they can't
 * open is a locked placeholder with no title. Page images come from `assets` (per-viewer URLs).
 */
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkDirective from "remark-directive";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Schema } from "hast-util-sanitize";
import "katex/dist/katex.min.css";
import { Children, createContext, isValidElement, useContext, useEffect, useMemo, useRef, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { Alert, Icon } from "@/components/ui";
import { CodeBlock } from "@/components/reading/CodeBlock";
import { DiagramFrame } from "@/components/reading/DiagramFrame";
import { Prose } from "@/components/reading/Prose";
import { ScrollBox } from "@/components/reading/ScrollBox";
import { rehypeHeadingIds, type Heading } from "@/components/reading/slug";
import { embedMode, pageRefs } from "@/lib/pageBlocks.mjs";
import { splitFrontmatter } from "@/components/docs-editor/core/frontmatter.mjs";
import type { AssetUrl, ResolvedEmbed } from "@/lib/pages";
import { remarkPageBlocks } from "./remarkPageBlocks";
import { PageEmbed, PageMention } from "./PageEmbed";
import { usePageEmbeds } from "./usePageEmbeds";
import "./pages.css";

const PB_ATTRS = ["dataPb", "dataKind", "dataLabel", "dataSrc", "dataMode", "dataAsset"];

const schema: Schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary", "kbd"],
  attributes: {
    ...defaultSchema.attributes,
    div: [...(defaultSchema.attributes?.div ?? []), ...PB_ATTRS],
    span: [["className", /^hljs-/], ...PB_ATTRS],
    details: [...PB_ATTRS],
    kbd: [["className", "md-kbd"]],
    code: [["className", /^language-/, "hljs", /^hljs-/, "math-inline", "math-display"]],
  },
};

const KATEX_OPTIONS = { errorColor: "var(--danger)" };

interface Ctx {
  embeds: Record<string, ResolvedEmbed | null>;
  signInHref?: string | null;
}
const PageCtx = createContext<Ctx>({ embeds: {} });

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}

type P<T extends keyof React.JSX.IntrinsicElements> = ComponentProps<T> & ExtraProps & Record<string, unknown>;

const TONE = { note: "info", tip: "success", warning: "warning", danger: "danger" } as const;

function Div({ node: _n, children, ...rest }: P<"div">) {
  const pb = rest["data-pb"];
  if (pb === "callout") {
    const k = (String(rest["data-kind"] ?? "note") in TONE ? String(rest["data-kind"]) : "note") as keyof typeof TONE;
    const label = typeof rest["data-label"] === "string" ? (rest["data-label"] as string) : undefined;
    return (
      <Alert tone={TONE[k]} title={label} icon={k === "tip" ? "bulb" : undefined} className={`pb-callout pb-callout--${k}`}>
        {children}
      </Alert>
    );
  }
  if (pb === "embed") return <EmbedBlock src={String(rest["data-src"] ?? "")} mode={String(rest["data-mode"] ?? "live")} label={(rest["data-label"] as string) || null} />;
  if (pb === "unknown") return <div className="pb-unknown">{children}</div>;
  const { "data-pb": _pb, "data-kind": _k, "data-label": _l, "data-src": _s, "data-mode": _m, "data-asset": _a, ...plain } = rest;
  return <div {...(plain as object)}>{children}</div>;
}

function EmbedBlock({ src, mode, label }: { src: string; mode: string; label: string | null }) {
  const { embeds, signInHref } = useContext(PageCtx);
  const slug = src || null;
  return <PageEmbed slug={slug} mode={embedMode(mode)} label={label} resolved={slug ? embeds[slug] : null} signInHref={signInHref} />;
}

function Span({ node: _n, children, ...rest }: P<"span">) {
  const pb = rest["data-pb"];
  if (pb === "mention") return <MentionChip src={String(rest["data-src"] ?? "")} />;
  if (pb === "asset") {
    return (
      <span className="pb-asset-missing not-prose" role="img" aria-label={String(rest["data-label"] || "Image")}>
        <Icon name="image" aria-hidden />
        <span>{rest["data-label"] ? String(rest["data-label"]) : "Image"} · not available</span>
      </span>
    );
  }
  const { "data-pb": _pb, "data-kind": _k, "data-label": _l, "data-src": _s, "data-mode": _m, "data-asset": _a, ...plain } = rest;
  return <span {...(plain as object)}>{children}</span>;
}

function MentionChip({ src }: { src: string }) {
  const { embeds } = useContext(PageCtx);
  const slug = src || null;
  return <PageMention slug={slug} resolved={slug ? embeds[slug] : null} />;
}

function Details({ node: _n, children, ...rest }: P<"details">) {
  const label = typeof rest["data-label"] === "string" ? (rest["data-label"] as string) : "Details";
  return (
    <details className="dx-details pb-details">
      <summary>
        <Icon name="chevronRight" className="dx-details__chev" />
        <span>{label}</span>
      </summary>
      <div className="dx-details__body">{children}</div>
    </details>
  );
}

function Pre({ children }: P<"pre">) {
  const child = Children.toArray(children)[0];
  const className = isValidElement<{ className?: string }>(child) ? child.props.className ?? "" : "";
  const language = /(?:^|\s)language-([^\s]+)/.exec(className)?.[1];
  const text = textOf(children).replace(/\n$/, "");
  if (language === "mermaid") return <DiagramFrame code={text} />;
  return (
    <CodeBlock code={text} language={language}>
      {children}
    </CodeBlock>
  );
}

function Table({ node: _n, children, ...props }: P<"table">) {
  return (
    <ScrollBox className="md-table-box" scrollClassName="md-table-wrap" label="Table">
      <table className="md-table" {...(props as object)}>
        {children}
      </table>
    </ScrollBox>
  );
}

function Img({ node: _n, alt, src, title }: P<"img">) {
  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={String(src)} alt={alt ?? ""} title={typeof title === "string" ? title : undefined} loading="lazy" decoding="async" className="pb-img" />
  );
}

function Input({ node: _n, type, checked, ...props }: P<"input">) {
  if (type !== "checkbox") return <input type={type} checked={checked} {...(props as object)} />;
  return (
    <span className="md-task-check">
      <input type="checkbox" checked={!!checked} disabled readOnly aria-label={checked ? "Completed task" : "Incomplete task"} />
      <span className="md-task-check__box" aria-hidden>
        <Icon name="check" />
      </span>
    </span>
  );
}

const COMPONENTS = { div: Div, span: Span, details: Details, pre: Pre, table: Table, img: Img, input: Input } as unknown as Components;

export interface PageRendererProps {
  /** The page's slug: embeds and mentions are resolved through it, for this viewer. */
  slug: string;
  content: string;
  /** Page images for this viewer (`asset:<id>` → URL). */
  assets?: Record<string, AssetUrl> | null;
  /** Where "Sign in" on a locked embed goes. */
  signInHref?: string | null;
  onHeadings?: (headings: Heading[]) => void;
  /** Resolved embeds from outside (the editor shares its own); else resolved here. */
  embeds?: Record<string, ResolvedEmbed | null>;
  className?: string;
}

export function PageRenderer({ slug, content: source, assets, signInHref, onHeadings, embeds: given, className }: PageRendererProps) {
  // The page's properties (icon, cover, width…) live in its front matter; the body is the rest.
  const content = useMemo(() => splitFrontmatter(source).body, [source]);
  const refs = useMemo(() => pageRefs(content), [content]);
  const own = usePageEmbeds(slug, refs.slugs, !given);
  const embeds = given ?? own;
  const collected = useRef<Heading[]>([]);
  const sent = useRef<string | null>(null);
  const onHeadingsRef = useRef(onHeadings);
  onHeadingsRef.current = onHeadings;

  const assetKey = JSON.stringify(Object.entries(assets ?? {}).map(([k, v]) => [k, v.url]).sort());
  const remarkPlugins = useMemo(
    () => [remarkGfm, remarkMath, remarkDirective, [remarkPageBlocks, { assets: assets ?? {} }]] as NonNullable<ComponentProps<typeof ReactMarkdown>["remarkPlugins"]>,
    [assetKey], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const rehypePlugins = useMemo(
    () => [rehypeHighlight, [rehypeSanitize, schema], [rehypeHeadingIds, { collect: (h: Heading[]) => (collected.current = h) }], [rehypeKatex, KATEX_OPTIONS]] as NonNullable<ComponentProps<typeof ReactMarkdown>["rehypePlugins"]>,
    [],
  );
  const tree = useMemo(
    () => (
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    ),
    [content, remarkPlugins, rehypePlugins],
  );

  useEffect(() => {
    const key = JSON.stringify(collected.current);
    if (key === sent.current) return;
    sent.current = key;
    onHeadingsRef.current?.(collected.current);
  }, [content]);

  const ctx = useMemo(() => ({ embeds, signInHref }), [embeds, signInHref]);
  return (
    <PageCtx.Provider value={ctx}>
      {/* ph-no-capture: the page body (and what it embeds) is never recorded. */}
      <Prose size="reading" className={["ph-no-capture pb-page", className].filter(Boolean).join(" ")}>
        {tree}
      </Prose>
    </PageCtx.Provider>
  );
}

export default PageRenderer;
