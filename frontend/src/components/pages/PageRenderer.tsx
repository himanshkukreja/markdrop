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
import { Children, createContext, isValidElement, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { Alert, Icon } from "@/components/ui";
import { CodeBlock } from "@/components/reading/CodeBlock";
import { DiagramFrame } from "@/components/reading/DiagramFrame";
import { Prose } from "@/components/reading/Prose";
import { ScrollBox } from "@/components/reading/ScrollBox";
import { rehypeHeadingIds, type Heading } from "@/components/reading/slug";
import { embedMode, pageRefs, webEmbedUrl } from "@/lib/pageBlocks.mjs";
import { splitFrontmatter } from "@/components/docs-editor/core/frontmatter.mjs";
import type { AssetUrl, Crumb, ResolvedEmbed } from "@/lib/pages";
import { remarkPageBlocks } from "./remarkPageBlocks";
import { LockedEmbed, PageEmbed, PageMention } from "./PageEmbed";
import { BookmarkCard } from "@/components/docs-editor/views/pageLeaves";
import { usePageEmbeds } from "./usePageEmbeds";
import "./pages.css";


const PB_ATTRS = ["dataPb", "dataKind", "dataLabel", "dataSrc", "dataMode", "dataAsset", "dataIcon", "dataColor", "dataHeading", "dataUrl", "dataTitle", "dataDesc", "dataImage", "dataSite"];
const PB_PROPS = ["data-pb", "data-kind", "data-label", "data-src", "data-mode", "data-asset", "data-icon", "data-color", "data-heading", "data-url", "data-title", "data-desc", "data-image", "data-site"];

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
  headings: Heading[];
  crumbs: Crumb[];
  title: string | null;
  href: (slug: string, ancestors: string[]) => string;
}
const PageCtx = createContext<Ctx>({ embeds: {}, headings: [], crumbs: [], title: null, href: (s) => `/${encodeURIComponent(s)}` });

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}

type P<T extends keyof React.JSX.IntrinsicElements> = ComponentProps<T> & ExtraProps & Record<string, unknown>;

const TONE = { note: "info", tip: "success", warning: "warning", danger: "danger" } as const;
const COLORS = new Set(["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]);

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function plainProps(rest: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (!PB_PROPS.includes(k)) out[k] = v;
  return out;
}

function Div({ node: _n, children, ...rest }: P<"div">) {
  const pb = rest["data-pb"];
  if (pb === "callout") {
    const k = (String(rest["data-kind"] ?? "note") in TONE ? String(rest["data-kind"]) : "note") as keyof typeof TONE;
    const label = str(rest["data-label"]);
    const emoji = str(rest["data-icon"]);
    const color = COLORS.has(String(rest["data-color"])) ? String(rest["data-color"]) : null;
    if (emoji || color) {
      // A page's callout with its own icon or colour.
      return (
        <div className={`md-alert md-alert--${TONE[k]} pb-callout pb-callout--${k}${color ? ` pb-bg-${color}` : ""}`}>
          {emoji ? <span className="pb-callout__emoji" aria-hidden>{emoji}</span> : <Icon name={k === "tip" ? "bulb" : k === "note" ? "info" : k === "warning" ? "alert" : "alertCircle"} />}
          <div className="md-alert__main">
            {label && <div className="md-alert__title">{label}</div>}
            <div className="md-alert__body">{children}</div>
          </div>
        </div>
      );
    }
    return (
      <Alert tone={TONE[k]} title={label} icon={k === "tip" ? "bulb" : undefined} className={`pb-callout pb-callout--${k}`}>
        {children}
      </Alert>
    );
  }
  if (pb === "embed") return <EmbedBlock src={String(rest["data-src"] ?? "")} mode={String(rest["data-mode"] ?? "live")} label={str(rest["data-label"]) ?? null} />;
  if (pb === "bookmark") return <BookmarkCard a={{ url: str(rest["data-url"]), title: str(rest["data-title"]), description: str(rest["data-desc"]), image: str(rest["data-image"]), site: str(rest["data-site"]) }} />;
  if (pb === "toc") return <TocBlock />;
  if (pb === "breadcrumb") return <CrumbBlock />;
  if (pb === "subpage") return <SubPageBlock src={String(rest["data-src"] ?? "")} />;
  if (pb === "webembed") return <WebEmbedBlock url={str(rest["data-url"]) ?? ""} title={str(rest["data-title"])} />;
  if (pb === "unknown") return <div className="pb-unknown">{children}</div>;
  return <div {...(plainProps(rest) as object)}>{children}</div>;
}

function EmbedBlock({ src, mode, label }: { src: string; mode: string; label: string | null }) {
  const { embeds, signInHref } = useContext(PageCtx);
  const slug = src || null;
  return <PageEmbed slug={slug} mode={embedMode(mode)} label={label} resolved={slug ? embeds[slug] : null} signInHref={signInHref} />;
}

function SubPageBlock({ src }: { src: string }) {
  const { embeds, signInHref } = useContext(PageCtx);
  const slug = src || null;
  return <PageEmbed slug={slug} mode="card" resolved={slug ? embeds[slug] : null} signInHref={signInHref} />;
}

function TocBlock() {
  const { headings } = useContext(PageCtx);
  const list = headings.filter((h) => h.depth >= 1 && h.depth <= 3);
  if (!list.length) return null;
  const min = Math.min(...list.map((h) => h.depth));
  return (
    <nav className="pb-toc not-prose" aria-label="On this page">
      <ul>
        {list.map((h) => (
          <li key={h.id} style={{ paddingLeft: (h.depth - min) * 16 }}>
            <a href={`#${h.id}`} className="md-focus">{h.text}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function CrumbBlock() {
  const { crumbs, title, href } = useContext(PageCtx);
  return (
    <nav className="pb-crumbs pb-crumbs--block not-prose" aria-label="Breadcrumb">
      {crumbs.map((c, i) => (
        <span key={c.slug} className="pb-crumbs__item">
          <a href={href(c.slug, crumbs.slice(0, i).map((x) => x.slug))}>{c.title || "Untitled"}</a> <Icon name="chevronRight" size={12} aria-hidden />
        </span>
      ))}
      <span aria-current="page">{title || "Untitled"}</span>
    </nav>
  );
}

function WebEmbedBlock({ url, title }: { url: string; title?: string }) {
  const src = webEmbedUrl(url);
  if (!src) return <LockedEmbed state="missing" />;
  return (
    <div className="pb-webembed not-prose">
      <iframe src={src} title={title || "Embedded content"} sandbox="allow-scripts allow-same-origin allow-popups allow-presentation allow-forms" allow="fullscreen; picture-in-picture; encrypted-media" referrerPolicy="strict-origin-when-cross-origin" loading="lazy" />
    </div>
  );
}

function Span({ node: _n, children, ...rest }: P<"span">) {
  const pb = rest["data-pb"];
  if (pb === "mention") return <MentionChip src={String(rest["data-src"] ?? "")} />;
  if (pb === "date") {
    const iso = String(rest["data-label"] ?? "");
    const d = new Date(`${iso}T12:00:00`);
    return (
      <time className="pb-mention pb-mention--date" dateTime={iso}>
        <Icon name="calendar" size={13} aria-hidden />
        <span>{Number.isFinite(d.getTime()) ? d.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" }) : iso}</span>
      </time>
    );
  }
  if (pb === "person") {
    return (
      <span className="pb-mention pb-mention--person">
        <span aria-hidden>@</span>
        <span className="ph-mask">{String(rest["data-label"] ?? "")}</span>
      </span>
    );
  }
  if (pb === "asset") {
    return (
      <span className="pb-asset-missing not-prose" role="img" aria-label={String(rest["data-label"] || "Image")}>
        <Icon name="image" aria-hidden />
        <span>{rest["data-label"] ? String(rest["data-label"]) : "Image"} · not available</span>
      </span>
    );
  }
  return <span {...(plainProps(rest) as object)}>{children}</span>;
}

function MentionChip({ src }: { src: string }) {
  const { embeds } = useContext(PageCtx);
  const slug = src || null;
  return <PageMention slug={slug} resolved={slug ? embeds[slug] : null} />;
}

function Details({ node: _n, children, ...rest }: P<"details">) {
  const label = str(rest["data-label"]) ?? "Details";
  const heading = /^[123]$/.test(String(rest["data-heading"] ?? "")) ? Number(rest["data-heading"]) : null;
  const H = heading ? (`h${heading}` as "h1" | "h2" | "h3") : "span";
  return (
    <details className={`dx-details pb-details${heading ? ` pb-details--h pb-details--h${heading}` : ""}`}>
      <summary>
        <Icon name="chevronRight" className="dx-details__chev" />
        <H className={heading ? "pb-details__h" : undefined}>{label}</H>
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
  /** The breadcrumb block: this page's readable ancestors and title, and how to link a page. */
  crumbs?: Crumb[];
  title?: string | null;
  href?: (slug: string, ancestors: string[]) => string;
  className?: string;
}

const defaultHref = (s: string) => `/${encodeURIComponent(s)}`;

export function PageRenderer({ slug, content: source, assets, signInHref, onHeadings, embeds: given, crumbs, title, href, className }: PageRendererProps) {
  // The page's properties (icon, cover, width…) live in its front matter; the body is the rest.
  const content = useMemo(() => splitFrontmatter(source).body, [source]);
  const refs = useMemo(() => pageRefs(content), [content]);
  const own = usePageEmbeds(slug, refs.slugs, !given);
  const embeds = given ?? own;
  const collected = useRef<Heading[]>([]);
  const sent = useRef<string | null>(null);
  const onHeadingsRef = useRef(onHeadings);
  onHeadingsRef.current = onHeadings;
  const [headings, setHeadings] = useState<Heading[]>([]);

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
    setHeadings(collected.current);
    onHeadingsRef.current?.(collected.current);
  }, [content]);

  const ctx = useMemo(() => ({ embeds, signInHref, headings, crumbs: crumbs ?? [], title: title ?? null, href: href ?? defaultHref }), [embeds, signInHref, headings, crumbs, title, href]);
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
