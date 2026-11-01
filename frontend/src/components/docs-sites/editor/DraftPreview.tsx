"use client";

/**
 * The editor's Preview: the page's draft drawn the way the published guide draws it, in the guide's
 * SAVED design (Design › Save design, not the live build's): the engine's own theme tokens
 * (guideTheme.ts), its preset styles (themes.css on .dx-root[data-preset]) and its block classes
 * (docs.css), with the engine's Markdown pipeline (remark-directive + remarkDocs / rehypeDocs).
 * Images come from the studio's asset previews; a link to another page of the guide opens that
 * page in the editor (with the preview still open), so cards and links are clickable here too.
 *
 * Not the engine itself (that is a server renderer reading the published content): videos show as
 * their title, embeds as a link, and an ::api chip without the reference's lookup.
 */
import { Children, isValidElement, useEffect, useId, useMemo, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkDirective from "remark-directive";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import "@/docs/docs.css";
import "@/docs/themes.css";
import { Alert, Icon, Kbd, SegmentedControl } from "@/components/ui";
import { CodeBlock } from "@/components/reading/CodeBlock";
import { DocsTabs } from "@/docs/client/Tabs";
import { rehypeDocs, remarkDocs } from "@/docs/render/plugins";
import { cardColumns } from "@/docs/render/rules.mjs";
import { presetName, type SiteTheme } from "@/lib/docsSites";
import { guideLook } from "../guideTheme";
import { previewLinkTarget } from "./pageChecks";
import { PREVIEW_FONTS_HREF } from "../presets";

type P = Record<string, unknown> & { children?: ReactNode; node?: unknown };

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

function textOf(n: ReactNode): string {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  if (isValidElement(n)) return textOf((n.props as { children?: ReactNode }).children);
  return "";
}

function makeComponents(resolve: (src: string) => string): Components {
  const img = (src: unknown) => (typeof src === "string" && src ? (/^\/docs-assets\//.test(src) ? resolve(src) : /^https:\/\//.test(src) ? src : "") : "");
  const CALLOUT_TONE = { note: "info", tip: "success", warning: "warning", danger: "danger" } as const;
  const map = {
    pre({ children }: P) {
      const child = Children.toArray(children)[0];
      const props = (isValidElement(child) ? child.props : {}) as { className?: string; "data-title"?: string; children?: ReactNode };
      const lang = /(?:^|\s)language-([^\s]+)/.exec(props.className ?? "")?.[1];
      return <CodeBlock code={textOf(props.children).replace(/\n$/, "")} language={props["data-title"] || lang}>{children}</CodeBlock>;
    },
    img({ src, alt }: P) {
      const s = img(src);
      // eslint-disable-next-line @next/next/no-img-element
      return s ? <img src={s} alt={typeof alt === "string" ? alt : ""} loading="lazy" /> : null;
    },
    table({ children }: P) {
      return <div className="md-table-wrap"><table className="md-table">{children}</table></div>;
    },
    "docs-figure"({ src, alt, caption }: P) {
      const s = img(src);
      if (!s) return null;
      return (
        <figure className="dx-fig not-prose">
          <span className="dx-fig__frame">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={s} alt={typeof alt === "string" ? alt : ""} loading="lazy" className="dx-fig__img" />
          </span>
          {typeof caption === "string" && caption && <figcaption className="dx-fig__cap">{caption}</figcaption>}
        </figure>
      );
    },
    "docs-callout"({ kind, label, children }: P) {
      const k = (typeof kind === "string" && kind in CALLOUT_TONE ? kind : "note") as keyof typeof CALLOUT_TONE;
      return <Alert tone={CALLOUT_TONE[k]} title={typeof label === "string" ? label : undefined} icon={k === "tip" ? "bulb" : undefined} className={cx("dx-callout", `dx-callout--${k}`)}>{children}</Alert>;
    },
    "docs-steps"({ children }: P) {
      return <ol className="dx-steps">{children}</ol>;
    },
    "docs-step"({ n, children }: P) {
      return <li className="dx-step"><span className="dx-step__n" aria-hidden>{String(n ?? "")}</span><div className="dx-step__body">{children}</div></li>;
    },
    "docs-tabs"({ labels, sync, children }: P) {
      return <DocsTabs labels={typeof labels === "string" ? labels : "[]"} sync={typeof sync === "string" ? sync : undefined}>{Children.toArray(children).filter(isValidElement)}</DocsTabs>;
    },
    "docs-tab"({ children }: P) {
      return <div className="dx-tab">{children}</div>;
    },
    "docs-cards"({ cols, children }: P) {
      const kids = Children.toArray(children).filter(isValidElement);
      const n = cardColumns(kids.length, cols);
      return <div className="dx-cards" data-cols={n} style={{ "--dx-cols": n } as CSSProperties}>{kids}</div>;
    },
    "docs-card"({ label, href, icon, cover, children }: P) {
      const h = typeof href === "string" ? href : "";
      const title = typeof label === "string" ? label : h;
      const c = img(cover);
      return (
        <div className={cx("dx-card", h && "dx-card--link", c && "dx-card--cover")}>
          {c && (
            <span className="dx-card__cover" aria-hidden>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={c} alt="" loading="lazy" />
            </span>
          )}
          {typeof icon === "string" && <span className="dx-card__icon" aria-hidden><Icon name={icon} /></span>}
          <strong className="dx-card__title">{h ? <a href={h} className="dx-card__link">{title}</a> : <span>{title}</span>}</strong>
          <div className="dx-card__body">{children}</div>
        </div>
      );
    },
    "docs-details"({ label, children }: P) {
      return (
        <details className="dx-details">
          <summary><Icon name="chevronRight" className="dx-details__chev" /><span>{typeof label === "string" ? label : "Details"}</span></summary>
          <div className="dx-details__body">{children}</div>
        </details>
      );
    },
    "docs-clip"({ src, alt, caption }: P) {
      const base = typeof src === "string" ? src.replace(/\.(mp4|webm|webp)$/i, "") : "";
      if (!/^\/docs-assets\//.test(base)) return null;
      return (
        <figure className="dx-fig not-prose">
          <video src={resolve(`${base}.mp4`)} poster={resolve(`${base}.webp`)} muted loop autoPlay playsInline aria-label={typeof alt === "string" ? alt : undefined} style={{ maxWidth: "100%" }} />
          {typeof caption === "string" && caption && <figcaption className="dx-fig__cap">{caption}</figcaption>}
        </figure>
      );
    },
    "docs-video"({ label }: P) {
      return (
        <div className="dx-card not-prose" style={{ margin: "16px 0" }}>
          <span className="dx-card__icon" aria-hidden><Icon name="film" /></span>
          <strong className="dx-card__title">{typeof label === "string" && label ? label : "Video"}</strong>
          <div className="dx-card__body">Plays on the published guide.</div>
        </div>
      );
    },
    "docs-embed"({ src, label }: P) {
      const url = typeof src === "string" && /^https:\/\//.test(src) ? src : null;
      if (!url) return null;
      return <p><a href={url}>{typeof label === "string" && label ? label : url}</a></p>;
    },
    "docs-api"({ op, label }: P) {
      return <code className="dx-apiop">{typeof label === "string" && label ? `${label} · ` : ""}{String(op ?? "")}</code>;
    },
    "docs-kbd"({ children }: P) {
      return <Kbd>{children}</Kbd>;
    },
    input({ type, checked }: P) {
      return type === "checkbox" ? <input type="checkbox" checked={!!checked} disabled readOnly /> : null;
    },
  };
  return map as unknown as Components;
}

export interface DraftPreviewProps {
  /** The guide's saved theme (site.settings.theme). */
  theme: SiteTheme;
  title: string;
  description?: string;
  markdown: string;
  dark: boolean;
  onDark: (dark: boolean) => void;
  /** An asset path (/docs-assets/…) → a URL the studio can show. */
  resolveAsset: (src: string) => string;
  /** A click on a link to a page of the guide (path without .md or a trailing slash). */
  onOpenPath: (path: string, hash: string) => void;
}

export function DraftPreview({ theme, title, description, markdown, dark, onDark, resolveAsset, onOpenPath }: DraftPreviewProps) {
  // The root's own name: the theme's scoped rules (and custom CSS) reach this preview and nothing else.
  const scopeId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const look = useMemo(() => guideLook(theme, dark, `[data-dx-preview="${scopeId}"]`), [theme, dark, scopeId]);
  const components = useMemo(() => makeComponents(resolveAsset), [resolveAsset]);
  const forced = theme.mode === "light" || theme.mode === "dark";

  // The theme fonts (the Design panel loads the same sheet).
  useEffect(() => {
    if (document.querySelector("link[data-docs-preview-fonts]")) return;
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = PREVIEW_FONTS_HREF;
    l.dataset.docsPreviewFonts = "";
    document.head.appendChild(l);
  }, []);

  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || !e.currentTarget.contains(a)) return;
    const target = previewLinkTarget(a.getAttribute("href") ?? "");
    if (target.kind === "page") {
      e.preventDefault();
      onOpenPath(target.path, target.hash);
    } else if (target.kind === "hash") {
      e.preventDefault();
      e.currentTarget.querySelector(`[id="${CSS.escape(target.hash)}"]`)?.scrollIntoView({ block: "start" });
    } else {
      // Another site (or a file): never navigate the studio away from the editor.
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-muted">
        <span className="min-w-0 flex-1">Your saved design: <strong className="text-text">{presetName(theme.preset)}{"data-custom" in look.attrs ? ", customised" : ""}</strong>. Unsaved changes in Design don&apos;t show here.</span>
        {!forced && (
          <SegmentedControl
            size="sm"
            aria-label="Light or dark"
            value={dark ? "dark" : "light"}
            onChange={(v: string) => onDark(v === "dark")}
            options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
          />
        )}
      </div>
      {/* data-theme on an ancestor too, as <html> carries it on a site, so the theme's [data-theme] rules match. */}
      <div data-theme={dark ? "dark" : "light"} className="contents">
      {look.css && <style dangerouslySetInnerHTML={{ __html: look.css }} />}
      <div
        // ph-no-capture: the customer's content stays out of session replays.
        className="dx-root ph-no-capture overflow-hidden rounded-xl border"
        // The published layout's root attributes (theme.mjs themeAttrs): data-preset, data-layout and
        // one per custom-theme choice (cards, callouts, links, icons…), which themes.css styles.
        {...look.attrs}
        data-dx-preview={scopeId}
        data-theme={dark ? "dark" : "light"}
        data-testid="draft-preview"
        style={{ ...(look.vars as CSSProperties), background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-sans)", borderColor: "var(--border)", padding: "28px 28px 36px" }}
        onClickCapture={onClickCapture}
      >
        <h1 className="dx-title" style={{ fontFamily: "var(--dx-font-heading)", fontWeight: "var(--dx-heading-weight)" as unknown as number, margin: 0 }}>{title || "Untitled"}</h1>
        {description && <p className="dx-lede" style={{ color: "var(--text-secondary)" }}>{description}</p>}
        <div className="prose md-prose md-prose--reading dx-prose">
          <Markdown
            remarkPlugins={[remarkGfm, remarkMath, remarkDirective, remarkDocs]}
            rehypePlugins={[[rehypeHighlight, { detect: false }], [rehypeDocs, {}], [rehypeKatex, { errorColor: "var(--danger)" }]]}
            components={components}
            urlTransform={defaultUrlTransform}
          >
            {markdown}
          </Markdown>
        </div>
      </div>
      </div>
    </div>
  );
}
