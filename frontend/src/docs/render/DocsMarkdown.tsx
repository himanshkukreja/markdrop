/**
 * The docs renderer: a server component, so pages ship as HTML and only the interactive islands
 * (tabs, copy buttons, diagrams, heading actions) hydrate. Content is Markdown + remark-directive
 * syntax, never MDX: no author code runs, raw HTML is not rendered, and directive attributes are
 * whitelisted by remarkDocs.
 *
 * Pipeline: gfm → math → directive → remarkDocs | highlight → rehypeDocs (ids, code lines) → katex.
 */
import Link from "next/link";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkDirective from "remark-directive";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { Alert, Icon, Kbd } from "@/components/ui";
import { cx } from "../cx";
import { CodeBlock } from "@/components/reading/CodeBlock";
import { DiagramFrame } from "@/components/reading/DiagramFrame";
import { ScrollBox } from "@/components/reading/ScrollBox";
import { getMedia, getSite, getVideos } from "../content";
import { assetPath, clipVariants, imageVariants, readVttCues } from "../media";
import { DocsTabs } from "../client/Tabs";
import { ClipPlayer, VideoPlayer } from "../client/Media";
import { HeadingActions } from "../client/PageActions";
import { rehypeDocs, remarkDocs } from "./plugins";
import { isAppPath } from "../markdown";

/* ── helpers ─────────────────────────────────────────────────────────────── */

type P = Record<string, unknown> & { children?: ReactNode; node?: unknown };

function textOf(n: ReactNode): string {
  if (typeof n === "string") return n;
  if (typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  if (isValidElement(n)) return textOf((n as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}

const isLine = (n: ReactNode): n is ReactElement<{ className?: string; children?: ReactNode }> =>
  isValidElement(n) && /(^|\s)dx-line(\s|$)/.test(String((n.props as { className?: string }).className ?? ""));

function codeText(children: ReactNode): string {
  const kids = Children.toArray(children);
  if (kids.some(isLine)) return kids.filter(isLine).map((l) => textOf(l.props.children)).join("\n");
  return textOf(children).replace(/\n$/, "");
}


function safeUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/* ── standard elements ───────────────────────────────────────────────────── */

function Pre({ children }: P) {
  const child = Children.toArray(children)[0];
  const props = (isValidElement(child) ? child.props : {}) as { className?: string; "data-title"?: string; children?: ReactNode };
  const lang = /(?:^|\s)language-([^\s]+)/.exec(props.className ?? "")?.[1];
  const text = codeText(props.children);
  if (lang === "mermaid") return <DiagramFrame code={text} />;
  return (
    <CodeBlock code={text} language={props["data-title"] || lang} className={props["data-title"] ? "dx-code--titled" : undefined}>
      {children}
    </CodeBlock>
  );
}

function Code({ node: _n, children, ...rest }: P) {
  return <code {...(rest as React.HTMLAttributes<HTMLElement>)}>{children}</code>;
}

function A({ node: _n, href, children, ...rest }: P) {
  const h = typeof href === "string" ? href : "";
  const attrs = rest as React.AnchorHTMLAttributes<HTMLAnchorElement>;
  if (isAppPath(h))
    return (
      <Link href={h} {...attrs}>
        {children}
      </Link>
    );
  return (
    <a href={h} {...attrs}>
      {children}
    </a>
  );
}

function heading(Tag: "h2" | "h3") {
  function H({ node: _n, id, children, ...rest }: P) {
    const hid = typeof id === "string" ? id : undefined;
    if (!hid) return <Tag {...(rest as object)}>{children}</Tag>;
    return (
      <div className={cx("dx-h", `dx-h--${Tag}`)}>
        <Tag id={hid} {...(rest as object)}>
          {children}
        </Tag>
        <HeadingActions id={hid} label={textOf(children)} />
      </div>
    );
  }
  H.displayName = `Docs${Tag.toUpperCase()}`;
  return H;
}

function Table({ node: _n, children, ...rest }: P) {
  return (
    <ScrollBox className="md-table-box" scrollClassName="md-table-wrap" label="Table">
      <table className="md-table" {...(rest as object)}>
        {children}
      </table>
    </ScrollBox>
  );
}

/** An image inside a line of text (a badge, an icon): sized from the manifest, never zoomable. */
function Img({ node: _n, alt, src, ...rest }: P) {
  const s = typeof src === "string" ? src : undefined;
  const a = s ? assetPath(s) : null;
  const v = a ? imageVariants(getMedia(), a) : null;
  const size = v?.cssW && v.w && v.h ? { width: v.cssW, height: Math.round((v.h * v.cssW) / v.w) } : {};
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={s} alt={typeof alt === "string" ? alt : ""} loading="lazy" decoding="async" {...size} {...(rest as object)} />;
}

/** Root-relative or https image addresses; anything else (javascript:, data:) is dropped. */
function imageUrl(u: unknown): string | null {
  if (typeof u !== "string" || !u) return null;
  if (u.startsWith("/") && !u.startsWith("//")) return u;
  return safeUrl(u);
}

/**
 * A paragraph that is just `![alt](src "caption")`: a figure at most as wide as the column (and
 * never wider than the image at its capture density), its dark variant beside it when the manifest
 * has `<name>.dark.<ext>` (CSS shows the one matching the theme), click to open the lightbox.
 */
export function Figure({ src, alt, caption }: P) {
  const url = imageUrl(src);
  if (!url) return null;
  const text = typeof alt === "string" ? alt : "";
  const cap = typeof caption === "string" && caption ? caption : undefined;
  const a = assetPath(url);
  const v = a ? imageVariants(getMedia(), a) : { src: url };
  const style = { "--dx-w": "cssW" in v && v.cssW ? `${v.cssW}px` : undefined } as React.CSSProperties;
  const imgs: Array<[string, string | undefined]> = v.dark ? [[v.src, "dx-themed-light"], [v.dark, "dx-themed-dark"]] : [[v.src, undefined]];
  return (
    <figure className="dx-fig not-prose">
      <button
        type="button"
        className="dx-fig__frame"
        style={style}
        data-dx-zoom=""
        data-src={v.src}
        data-dark={v.dark}
        data-alt={text}
        data-caption={cap}
        data-w={"w" in v ? v.w : undefined}
        data-h={"h" in v ? v.h : undefined}
        aria-label={text ? `Enlarge image: ${text}` : "Enlarge image"}
        aria-haspopup="dialog"
      >
        {imgs.map(([s, cls]) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={s} src={s} alt={text} width={"w" in v ? v.w : undefined} height={"h" in v ? v.h : undefined} loading="lazy" decoding="async" className={cx("dx-fig__img", cls)} />
        ))}
        <span className="dx-fig__zoom" aria-hidden>
          <Icon name="zoomIn" />
        </span>
      </button>
      {cap && <figcaption className="dx-fig__cap">{cap}</figcaption>}
    </figure>
  );
}

function Input({ node: _n, type, checked }: P) {
  if (type !== "checkbox") return null;
  return (
    <span className="md-task-check">
      <input type="checkbox" checked={!!checked} disabled readOnly aria-label={checked ? "Completed task" : "Incomplete task"} />
      <span className="md-task-check__box" aria-hidden>
        <Icon name="check" />
      </span>
    </span>
  );
}

/* ── directive components ────────────────────────────────────────────────── */

const CALLOUT_TONE = { note: "info", tip: "success", warning: "warning", danger: "danger" } as const;

function Callout({ kind, label, children }: P) {
  const k = (typeof kind === "string" && kind in CALLOUT_TONE ? kind : "note") as keyof typeof CALLOUT_TONE;
  return (
    <Alert tone={CALLOUT_TONE[k]} title={typeof label === "string" ? label : undefined} icon={k === "tip" ? "bulb" : undefined} className={cx("dx-callout", `dx-callout--${k}`)}>
      {children}
    </Alert>
  );
}

function Steps({ children }: P) {
  return <ol className="dx-steps">{children}</ol>;
}

function Step({ n, children }: P) {
  return (
    <li className="dx-step">
      <span className="dx-step__n" aria-hidden>
        {String(n ?? "")}
      </span>
      <div className="dx-step__body">{children}</div>
    </li>
  );
}

function TabsC({ labels, sync, children }: P) {
  return (
    <DocsTabs labels={typeof labels === "string" ? labels : "[]"} sync={typeof sync === "string" ? sync : undefined}>
      {Children.toArray(children).filter(isValidElement)}
    </DocsTabs>
  );
}

function Tab({ children }: P) {
  return <div className="dx-tab">{children}</div>;
}

function Cards({ children }: P) {
  return <div className="dx-cards">{Children.toArray(children).filter(isValidElement)}</div>;
}

function Card({ label, href, icon, children }: P) {
  const h = typeof href === "string" ? href : "";
  const title = typeof label === "string" ? label : h;
  const link = h ? (
    isAppPath(h) ? (
      <Link href={h} className="dx-card__link">
        {title}
      </Link>
    ) : (
      <a href={h} className="dx-card__link">
        {title}
      </a>
    )
  ) : (
    <span>{title}</span>
  );
  return (
    <div className={cx("dx-card", h && "dx-card--link")}>
      {typeof icon === "string" && (
        <span className="dx-card__icon" aria-hidden>
          <Icon name={icon} />
        </span>
      )}
      <strong className="dx-card__title">{link}</strong>
      <div className="dx-card__body">{children}</div>
    </div>
  );
}

function Details({ label, children }: P) {
  return (
    <details className="dx-details">
      <summary>
        <Icon name="chevronRight" className="dx-details__chev" />
        <span>{typeof label === "string" ? label : "Details"}</span>
      </summary>
      <div className="dx-details__body">{children}</div>
    </details>
  );
}

/** `::clip{src alt caption theme}`: a short silent loop (see ClipPlayer). */
function Clip({ src, alt, caption, theme }: P) {
  const base = assetPath(src);
  if (!base) return null;
  const c = clipVariants(getMedia(), base, theme === "both" ? "both" : "light");
  const cssW = c.w ? Math.round(c.w / 2) : undefined;
  return <ClipPlayer light={c.light} dark={c.dark} w={c.w} h={c.h} cssW={cssW} alt={typeof alt === "string" ? alt : ""} caption={typeof caption === "string" && caption ? caption : undefined} />;
}

/**
 * `::video{id title duration}`. Filled from videos.json: a Markdrop link (`markdrop`, or the older
 * `url`) is framed; a self-hosted `src` plays in the docs player with its poster, chapters and
 * captions. Unfilled, it stays the "coming soon" slot.
 */
export function VideoSlot({ vid, label, duration }: P) {
  const id = typeof vid === "string" ? vid : "";
  const ref = id ? getVideos()[id] : undefined;
  const title = (typeof label === "string" && label) || ref?.title || "Video";
  const src = safeUrl(ref?.markdrop ?? ref?.url);
  const dur = (typeof duration === "string" && duration) || ref?.duration;
  const file = !src ? assetPath(ref?.src) : null;
  if (file && ref) {
    const m = getMedia()[file];
    const poster = assetPath(ref.poster) ?? undefined;
    return (
      <VideoPlayer
        src={file}
        poster={poster}
        w={m?.w}
        h={m?.h}
        title={title}
        duration={dur}
        chapters={readVttCues(ref.chapters)}
        chaptersSrc={assetPath(ref.chapters) ?? undefined}
        captionsSrc={assetPath(ref.captions) ?? undefined}
      />
    );
  }
  return (
    <figure className="dx-video not-prose" data-video={id || undefined}>
      <div className="dx-video__frame">
        {src ? (
          <iframe src={src} title={title} loading="lazy" allow="fullscreen; picture-in-picture" allowFullScreen />
        ) : (
          <>
            <span className="dx-video__play" aria-hidden>
              <Icon name="film" />
            </span>
            <span className="dx-video__soon">Video coming soon</span>
          </>
        )}
        {dur && !src && <span className="dx-video__chip">{dur}</span>}
      </div>
      <figcaption className="dx-video__cap">{src ? title : `${title}. A short screen recording will play here.`}</figcaption>
    </figure>
  );
}

function Embed({ src, label }: P) {
  const url = safeUrl(src);
  const title = typeof label === "string" && label ? label : url ?? "Embedded page";
  if (!url) return null;
  const host = new URL(url).hostname;
  const allowed = (getSite().embedHosts ?? []).includes(host);
  return (
    <figure className="dx-embed not-prose">
      <figcaption className="dx-embed__bar">
        <Icon name="globe" />
        <span className="dx-embed__title">{title}</span>
        <a href={url} target="_blank" rel="noopener noreferrer" className="dx-embed__open">
          Open
          <Icon name="external" />
        </a>
      </figcaption>
      {allowed ? <iframe src={url} title={title} loading="lazy" className="dx-embed__frame" /> : null}
    </figure>
  );
}

function KbdC({ children }: P) {
  return <Kbd>{children}</Kbd>;
}

const COMPONENTS = {
  pre: Pre,
  code: Code,
  a: A,
  h2: heading("h2"),
  h3: heading("h3"),
  table: Table,
  img: Img,
  input: Input,
  "docs-callout": Callout,
  "docs-steps": Steps,
  "docs-step": Step,
  "docs-tabs": TabsC,
  "docs-tab": Tab,
  "docs-cards": Cards,
  "docs-card": Card,
  "docs-details": Details,
  "docs-video": VideoSlot,
  "docs-figure": Figure,
  "docs-clip": Clip,
  "docs-embed": Embed,
  "docs-kbd": KbdC,
} as unknown as Components;

const KATEX = { errorColor: "var(--danger)" };

/** react-markdown's safe-URL rule, plus the editors' "install this MCP server" links. */
const APP_LINK = /^(cursor|vscode|vscode-insiders):\/\//i;
function urlTransform(url: string): string {
  return APP_LINK.test(url) ? url : defaultUrlTransform(url);
}

export function DocsMarkdown({ source, className }: { source: string; className?: string }) {
  return (
    <div className={cx("prose md-prose md-prose--reading dx-prose", className)}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath, remarkDirective, remarkDocs]}
        rehypePlugins={[[rehypeHighlight, { detect: false }], rehypeDocs, [rehypeKatex, KATEX]]}
        components={COMPONENTS}
        urlTransform={urlTransform}
      >
        {source}
      </Markdown>
    </div>
  );
}
