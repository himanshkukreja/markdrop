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
import { embedMode, webEmbedUrl } from "@/lib/pageBlocks.mjs";
import { pageRefs } from "@/lib/pageRefs.mjs";
import { splitFrontmatter } from "@/components/docs-editor/core/frontmatter.mjs";
import type { AssetUrl, Crumb, ResolvedEmbed } from "@/lib/pages";
import { remarkPageBlocks } from "./remarkPageBlocks";
import { LockedEmbed, PageEmbed, PageMention } from "./PageEmbed";
import { BookmarkCard } from "@/components/docs-editor/views/BookmarkCard";
import { usePageEmbeds } from "./usePageEmbeds";
import { useBlockAnchor } from "./anchors";
import { ImageLightbox } from "@/components/docs-editor/views/Lightbox";
import { SignoffCard } from "./signoff/SignoffCard";
import { usePageSignoffs, useSignoffState, type SignoffStore } from "./signoff/store";
import { signoffInfo } from "@/lib/signoff.mjs";
import "./pages.css";
import "./page-blocks.css";


const PB_ATTRS = ["dataPb", "dataKind", "dataLabel", "dataSrc", "dataMode", "dataAsset", "dataIcon", "dataColor", "dataHeading", "dataUrl", "dataTitle", "dataDesc", "dataImage", "dataSite", "dataPerson", "dataOptions", "dataLock", "dataRef"];
const PB_PROPS = ["data-pb", "data-kind", "data-label", "data-src", "data-mode", "data-asset", "data-icon", "data-color", "data-heading", "data-url", "data-title", "data-desc", "data-image", "data-site", "data-person", "data-options", "data-lock", "data-ref"];

/** Block attributes (attrs.mjs) any element may carry: anchor, colours, image and table layout. */
const BLOCK_ATTRS = ["dataBid", "dataColor", "dataBg", "dataWidth", "dataAlign", "dataWidths", "dataHcol", "dataHrow", "dataCaption", "dataBlock"];
const withBlock = (list?: NonNullable<Schema["attributes"]>[string]) => [...(list ?? []), ...BLOCK_ATTRS];

const schema: Schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary", "kbd", "u"],
  attributes: {
    ...defaultSchema.attributes,
    div: [...(defaultSchema.attributes?.div ?? []), ...PB_ATTRS, ...BLOCK_ATTRS],
    span: [["className", /^hljs-/], ...PB_ATTRS, ...BLOCK_ATTRS],
    details: [...PB_ATTRS, ...BLOCK_ATTRS],
    kbd: [["className", "md-kbd"]],
    code: [["className", /^language-/, "hljs", /^hljs-/, "math-inline", "math-display"], ...BLOCK_ATTRS],
    ...Object.fromEntries(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "table", "td", "th", "pre", "hr", "img"].map((t) => [t, withBlock(defaultSchema.attributes?.[t])])),
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
  /** The page's sign-offs for this viewer. */
  signoffs: SignoffStore | null;
  /** View mode, for people who can edit: a checklist item's box ticks (its list item's offset in the body). */
  onToggleTask?: ((offset: number) => void) | null;
}
const PageCtx = createContext<Ctx>({ embeds: {}, headings: [], crumbs: [], title: null, href: (s) => `/${encodeURIComponent(s)}`, signoffs: null });
/** The list item a checkbox belongs to: where it starts in the body (from the Markdown's positions). */
const TaskCtx = createContext<number | null>(null);

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

function Div(props: P<"div">) {
  const bid = str(props["data-bid"]);
  const out = DivInner(props);
  // A block anchor on a callout, embed, bookmark…: the wrapper carries it (scrolled to on open).
  return bid && props["data-pb"] && !["figure", "columns", "indent"].includes(String(props["data-pb"])) ? <div data-bid={bid}>{out}</div> : out;
}

function DivInner({ node: _n, children, ...rest }: P<"div">) {
  const pb = rest["data-pb"];
  if (pb === "figure") {
    return (
      <div className="pb-figure not-prose" data-align={str(rest["data-align"]) ?? "center"} data-bid={str(rest["data-bid"])} style={rest["data-width"] ? ({ "--pb-w": String(rest["data-width"]) } as React.CSSProperties) : undefined}>
        {children}
      </div>
    );
  }
  if (pb === "columns") return <div className="pb-columns" data-bid={str(rest["data-bid"])}>{children}</div>;
  if (pb === "column") return <div className="pb-column" style={rest["data-width"] ? { flexBasis: String(rest["data-width"]), flexGrow: 0 } : undefined}>{children}</div>;
  if (pb === "indent") return <div className="pb-indent" data-bid={str(rest["data-bid"])}>{children}</div>;
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
  if (pb === "signoff") return <SignoffBlock rest={rest}>{children}</SignoffBlock>;
  if (pb === "signoff-range") return <SignoffRange id={str(rest["data-ref"])}>{children}</SignoffRange>;
  if (pb === "unknown") return <div className="pb-unknown">{children}</div>;
  return <div {...(plainProps(rest) as object)}>{children}</div>;
}

/** A sign-off block: the card, its state for this viewer from the server. */
function SignoffBlock({ rest, children }: { rest: Record<string, unknown>; children?: ReactNode }) {
  const { signoffs } = useContext(PageCtx);
  const info = signoffInfo({ id: str(rest["data-bid"]), person: str(rest["data-person"]), label: str(rest["data-label"]), options: str(rest["data-options"]), lock: str(rest["data-lock"]) });
  const state = useSignoffState(signoffs, info.id);
  const body = Children.toArray(children).filter((c) => !(typeof c === "string" && !c.trim()));
  return (
    <SignoffCard info={info} state={state} loading={!!signoffs && !signoffs.loaded} onSign={state?.can_sign && signoffs && info.id ? async (o) => void (await signoffs.sign(info.id!, o)) : undefined}>
      {body.length ? body : null}
    </SignoffCard>
  );
}

/** The section a `lock=above` sign-off locks: a quiet rail once it is signed. */
function SignoffRange({ id, children }: { id?: string; children?: ReactNode }) {
  const { signoffs } = useContext(PageCtx);
  const state = useSignoffState(signoffs, id ?? null);
  const locked = !!state?.option;
  const who = state?.signed_by?.name;
  return (
    <div className={`pb-signoff-range${locked ? " is-locked" : ""}`} data-tone={state?.tone ?? undefined} title={locked ? `Locked: ${who ? `${who} signed off` : "signed off"} “${state!.label}” (${state!.option})` : undefined}>
      {locked && <span className="pb-signoff-range__lock" aria-hidden><Icon name="lock" size={10} /></span>}
      {children}
    </div>
  );
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
  if (pb === "color") return <span data-color={str(rest["data-color"])} data-bg={str(rest["data-bg"])}>{children}</span>;
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
    <details className={`dx-details pb-details${heading ? ` pb-details--h pb-details--h${heading}` : ""}`} data-bid={str(rest["data-bid"])} data-color={str(rest["data-color"])} data-bg={str(rest["data-bg"])}>
      <summary>
        <Icon name="chevronRight" className="dx-details__chev" />
        <H className={heading ? "pb-details__h" : undefined}>{label}</H>
      </summary>
      <div className="dx-details__body">{children}</div>
    </details>
  );
}

function Pre({ children, ...rest }: P<"pre">) {
  const child = Children.toArray(children)[0];
  const cp = isValidElement<Record<string, unknown>>(child) ? child.props : {};
  const className = typeof cp.className === "string" ? cp.className : "";
  const language = /(?:^|\s)language-([^\s]+)/.exec(className)?.[1];
  const text = textOf(children).replace(/\n$/, "");
  const caption = str(cp["data-caption"]);
  const bid = str(cp["data-bid"]) ?? str(rest["data-bid"]);
  const block = language === "mermaid" ? <DiagramFrame code={text} /> : (
    <CodeBlock code={text} language={language}>
      {children}
    </CodeBlock>
  );
  if (!caption && !bid) return block;
  return (
    <div className="pb-code" data-bid={bid}>
      {block}
      {caption && <p className="pb-caption">{caption}</p>}
    </div>
  );
}

function Table({ node: _n, children, ...props }: P<"table">) {
  const widths = str(props["data-widths"])?.split(",").map((w) => Number(w) || 0) ?? null;
  const own = plainBlockProps(props);
  return (
    <ScrollBox className="md-table-box" scrollClassName="md-table-wrap" label="Table">
      <table className={`md-table${widths ? " pb-table--sized" : ""}`} {...own}>
        {widths && (
          <colgroup>
            {widths.map((w, i) => (
              <col key={i} style={w ? { width: w } : undefined} />
            ))}
          </colgroup>
        )}
        {children}
      </table>
    </ScrollBox>
  );
}

/** The table's own props, without the attributes the component turned into markup. */
function plainBlockProps(props: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) if (k !== "data-widths") out[k] = v;
  return out;
}

function Img({ node: _n, alt, src, title, width, height, ...rest }: P<"img">) {
  if (!src) return null;
  // A page image's size (remarkPageBlocks, from the asset): it keeps its room while it loads.
  const size = { width: width || undefined, height: height || undefined };
  if (rest["data-block"]) return <FigureImage src={String(src)} alt={alt ?? ""} caption={typeof title === "string" ? title : undefined} size={size} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={String(src)} alt={alt ?? ""} title={typeof title === "string" ? title : undefined} {...size} loading="lazy" decoding="async" className="pb-img" />
  );
}

/** An image block: click for the full-screen view (with download), caption below. */
function FigureImage({ src, alt, caption, size }: { src: string; alt: string; caption?: string; size?: { width?: number | string; height?: number | string } }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="pb-figure__open md-focus" onClick={() => setOpen(true)} aria-label={alt ? `View ${alt} full screen` : "View image full screen"}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} {...size} loading="lazy" decoding="async" className="pb-img pb-figure__img" />
      </button>
      {caption && <span className="pb-caption pb-figure__cap">{caption}</span>}
      {open && <ImageLightbox src={src} alt={alt} caption={caption} onClose={() => setOpen(false)} />}
    </>
  );
}

function Li({ node, children, ...rest }: P<"li">) {
  const at = (node as { position?: { start?: { offset?: number } } } | undefined)?.position?.start?.offset;
  return (
    <li {...(rest as object)}>
      <TaskCtx.Provider value={typeof at === "number" ? at : null}>{children}</TaskCtx.Provider>
    </li>
  );
}

function Input({ node: _n, type, checked, ...props }: P<"input">) {
  const { onToggleTask } = useContext(PageCtx);
  const at = useContext(TaskCtx);
  if (type !== "checkbox") return <input type={type} checked={checked} {...(props as object)} />;
  // View mode, for people who can edit: ticking is a quick action that saves at once.
  const live = !!onToggleTask && at !== null;
  // (A label when it ticks: a click on the drawn box ticks the box underneath.)
  const Wrap = live ? "label" : "span";
  return (
    <Wrap className={live ? "md-task-check md-task-check--live" : "md-task-check"}>
      {live ? (
        <input type="checkbox" checked={!!checked} onChange={() => onToggleTask(at)} aria-label={checked ? "Completed task" : "Incomplete task"} />
      ) : (
        <input type="checkbox" checked={!!checked} disabled readOnly aria-label={checked ? "Completed task" : "Incomplete task"} />
      )}
      <span className="md-task-check__box" aria-hidden>
        <Icon name="check" />
      </span>
    </Wrap>
  );
}

const COMPONENTS = { div: Div, span: Span, details: Details, pre: Pre, table: Table, img: Img, input: Input, li: Li } as unknown as Components;
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
  /** Who is reading (a user id, or null): embeds are resolved again when it changes. */
  viewer?: string | null;
  /** The document's live socket (sign-offs refresh when someone signs). */
  subscribeLive?: ((fn: (msg: Record<string, unknown>) => void) => () => void) | null;
  /**
   * View mode, for people who can edit: a checklist item's box ticks. Called with the offset in the
   * page's body (after its front matter) where that item's list marker starts.
   */
  onToggleTask?: ((offset: number) => void) | null;
}

const defaultHref = (s: string) => `/${encodeURIComponent(s)}`;

export function PageRenderer({ slug, content: source, assets, signInHref, onHeadings, embeds: given, crumbs, title, href, className, viewer = null, subscribeLive = null, onToggleTask = null }: PageRendererProps) {
  // The page's properties (icon, cover, width…) live in its front matter; the body is the rest.
  const content = useMemo(() => splitFrontmatter(source).body, [source]);
  const refs = useMemo(() => pageRefs(content), [content]);
  const own = usePageEmbeds(slug, refs.slugs, !given, viewer);
  const embeds = given ?? own;
  const signoffs = usePageSignoffs(slug, content, { viewer, subscribeLive });
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

  // The latest handler, read at click time (the context stays put between renders).
  const toggleRef = useRef(onToggleTask);
  toggleRef.current = onToggleTask;
  const canToggle = !!onToggleTask;
  const toggle = useMemo(() => (canToggle ? (at: number) => toggleRef.current?.(at) : null), [canToggle]);
  const ctx = useMemo(() => ({ embeds, signInHref, headings, crumbs: crumbs ?? [], title: title ?? null, href: href ?? defaultHref, signoffs, onToggleTask: toggle }), [embeds, signInHref, headings, crumbs, title, href, signoffs, toggle]);
  const root = useRef<HTMLDivElement>(null);
  useBlockAnchor(root);
  return (
    <PageCtx.Provider value={ctx}>
      {/* ph-no-capture: the page body (and what it embeds) is never recorded. */}
      <div ref={root} className="pb-root">
        <Prose size="reading" className={["ph-no-capture pb-page", className].filter(Boolean).join(" ")}>
          {tree}
        </Prose>
      </div>
    </PageCtx.Provider>
  );
}

export default PageRenderer;
