"use client";

/**
 * One Markdrop item on a page, resolved for the person viewing it (POST /documents/{slug}/embeds):
 *
 *   image                      <img>
 *   video, audio               the player
 *   pdf, sheet, docx, pptx, text  Markdrop's viewer, in the sandboxed frame (ArtifactView's sandbox)
 *   html, bundle               the author's page, in the sandboxed frame (opaque origin)
 *   a Markdrop document        a preview card (title, excerpt, link)
 *
 * mode=card shows the card for anything; mode=preview a cover until the reader asks for it.
 * Anything the viewer can't open is a locked placeholder that never names the item (the API sends
 * no title, excerpt or address for those either). Mentions are inline chips (PageMention).
 */
import { useState } from "react";
import { Button, FileIcon, Icon, Skeleton, cx, type FileRenderer } from "@/components/ui";
import { useTheme } from "@/lib/theme";
import { lockedOf, type PageEmbedMode } from "@/lib/pageBlocks.mjs";
import type { ResolvedEmbed } from "@/lib/pages";
import { isPrimaryHost } from "@/components/tenant/hosts";

/** ArtifactView's sandbox: scripts and forms in an opaque origin; never allow-same-origin. */
export const EMBED_SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

const TYPE_LABEL: Record<string, string> = {
  html: "Interactive page",
  bundle: "Website",
  pdf: "PDF",
  sheet: "Spreadsheet",
  docx: "Word document",
  pptx: "PowerPoint deck",
  text: "Text file",
  image: "Image",
  video: "Video",
  audio: "Audio",
  markdown: "Document",
};

const FRAME_HEIGHT: Record<string, number> = { html: 560, bundle: 560, pdf: 720, sheet: 520, docx: 720, pptx: 600, text: 480 };

function fileRenderer(r?: string | null): FileRenderer | null {
  if (r === "bundle") return "zip";
  if (r === "markdown") return null;
  return (["pdf", "sheet", "docx", "pptx", "text", "video", "audio", "html", "image"].includes(r ?? "") ? r : null) as FileRenderer | null;
}

/** Only http(s) addresses are framed or loaded; anything else is dropped. */
function safeUrl(u?: string | null): string | null {
  if (!u) return null;
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:" ? x.toString() : null;
  } catch {
    return null;
  }
}

/** Where an embedded item opens: on markdrop.in its page here (never its workspace's own domain,
 *  owner 2026-11-10); on a workspace's domain the address the server gave. */
function itemUrl(u?: string | null, slug?: string | null): string | null {
  const safe = safeUrl(u);
  if (safe && slug && typeof window !== "undefined" && isPrimaryHost(window.location.host)) return `/${encodeURIComponent(slug)}`;
  return safe;
}

/** A Worker viewer page (`/v/…`) follows the app theme; a raw page (`/r/…`) is left alone. */
function themed(u: string, theme: "light" | "dark"): string {
  try {
    const x = new URL(u);
    if (x.pathname.startsWith("/v/")) x.searchParams.set("theme", theme);
    return x.toString();
  } catch {
    return u;
  }
}

/** An author page with `sb=1`: the Worker then repeats the sandbox as a CSP header. */
function sandboxed(u: string): string {
  try {
    const x = new URL(u);
    x.searchParams.set("sb", "1");
    return x.toString();
  } catch {
    return u;
  }
}

function ago(iso?: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d < 31 ? `${d} d ago` : new Date(t).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
}

export function LockedEmbed({ state, slug, signInHref, inline = false }: { state: string; slug?: string | null; signInHref?: string | null; inline?: boolean }) {
  const l = lockedOf(state);
  const action =
    l.action === "signin" && signInHref ? <Button size="sm" variant="secondary" href={signInHref}>Sign in</Button>
      : l.action === "open" && slug ? <Button size="sm" variant="secondary" href={`/${encodeURIComponent(slug)}`} iconLeft="external">Open</Button>
        : null;
  return (
    <div className={cx("pb-locked not-prose", inline && "pb-locked--inline")} data-state={state} role="note">
      <span className="pb-locked__icon" aria-hidden>
        <Icon name={state === "missing" ? "eyeOff" : "lock"} />
      </span>
      <div className="pb-locked__text">
        <strong>{l.title}</strong>
        <span>{l.body}</span>
      </div>
      {action}
    </div>
  );
}

function Chrome({ r, label, children, open }: { r: ResolvedEmbed; label?: string | null; children?: React.ReactNode; open?: string | null }) {
  const title = label || r.title || "Untitled";
  return (
    <figure className="pb-embed not-prose" data-renderer={r.renderer ?? ""}>
      {children}
      <figcaption className="pb-embed__bar">
        <FileIcon renderer={fileRenderer(r.renderer)} size={16} />
        <span className="pb-embed__title ph-sensitive" dir="auto">{title}</span>
        <span className="pb-embed__type">{TYPE_LABEL[r.renderer ?? ""] ?? "File"}</span>
        {open && (
          <a className="pb-embed__open md-focus" href={open} target="_blank" rel="noopener noreferrer">
            Open <Icon name="external" size={14} />
          </a>
        )}
      </figcaption>
    </figure>
  );
}

function Card({ r, label }: { r: ResolvedEmbed; label?: string | null }) {
  const title = label || r.title || "Untitled";
  const href = itemUrl(r.url, r.slug);
  const meta = [TYPE_LABEL[r.renderer ?? ""] ?? (r.kind === "document" ? "Document" : "File"), r.preview?.author_name, ago(r.preview?.updated_at)].filter(Boolean).join(" · ");
  const body = (
    <>
      <span className="pb-card__icon" aria-hidden>
        {r.kind === "document" || r.renderer === "markdown" ? <Icon name="lines" /> : <FileIcon renderer={fileRenderer(r.renderer)} size={20} />}
      </span>
      <span className="pb-card__main">
        <strong className="pb-card__title ph-sensitive" dir="auto">{title}</strong>
        {r.preview?.excerpt && <span className="pb-card__excerpt ph-no-capture" dir="auto">{r.preview.excerpt}</span>}
        <span className="pb-card__meta">{meta}</span>
      </span>
      <Icon name="arrowRight" className="pb-card__go" />
    </>
  );
  return href ? (
    <a className="pb-card not-prose md-focus" href={href}>
      {body}
    </a>
  ) : (
    <div className="pb-card not-prose">{body}</div>
  );
}

function Live({ r, label }: { r: ResolvedEmbed; label?: string | null }) {
  const { resolved: theme } = useTheme();
  const open = itemUrl(r.url, r.slug);
  const renderer = r.renderer ?? "";
  const raw = safeUrl(r.artifact_url);
  const title = label || r.title || "Untitled";
  if (renderer === "image" && raw) {
    return (
      <Chrome r={r} label={label} open={open}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="pb-embed__img ph-no-capture" src={raw} alt={title} loading="lazy" decoding="async" />
      </Chrome>
    );
  }
  if (renderer === "video" && raw && !new URL(raw).pathname.startsWith("/v/")) {
    return (
      <Chrome r={r} label={label} open={open}>
        <video className="pb-embed__video ph-no-capture" controls preload="metadata" playsInline src={raw} poster={safeUrl(r.poster_url) ?? undefined} aria-label={title} />
      </Chrome>
    );
  }
  if (renderer === "audio" && raw) {
    return (
      <Chrome r={r} label={label} open={open}>
        <audio className="pb-embed__audio" controls preload="metadata" src={raw} aria-label={title} />
      </Chrome>
    );
  }
  if (renderer === "markdown" || r.kind === "document") return <Card r={r} label={label} />;
  const author = renderer === "html" || renderer === "bundle";
  const base = author ? raw : safeUrl(r.viewer_url) ?? raw;
  if (!base) return <Card r={r} label={label} />;
  const src = author ? sandboxed(base) : themed(base, theme === "dark" ? "dark" : "light");
  return (
    <Chrome r={r} label={label} open={open}>
      <iframe
        className={cx("pb-embed__frame ph-no-capture", author && "pb-embed__frame--paper")}
        src={src}
        sandbox={EMBED_SANDBOX}
        referrerPolicy="no-referrer"
        loading="lazy"
        title={title}
        style={{ height: FRAME_HEIGHT[renderer] ?? 560, colorScheme: author ? "light" : theme === "dark" ? "dark" : "light" }}
      />
    </Chrome>
  );
}

function Cover({ r, label, onShow }: { r: ResolvedEmbed; label?: string | null; onShow: () => void }) {
  const title = label || r.title || "Untitled";
  return (
    <div className="pb-cover not-prose">
      <span className="pb-cover__icon" aria-hidden>
        <FileIcon renderer={fileRenderer(r.renderer)} size={28} />
      </span>
      <strong className="pb-cover__title ph-sensitive" dir="auto">{title}</strong>
      <span className="pb-cover__type">{TYPE_LABEL[r.renderer ?? ""] ?? "File"}</span>
      <Button size="sm" variant="secondary" iconLeft="play" onClick={onShow}>Show</Button>
    </div>
  );
}

export interface PageEmbedProps {
  slug: string | null;
  mode: PageEmbedMode;
  /** The author's title for the block (else the item's own). */
  label?: string | null;
  /** undefined while resolving; null when resolving failed. */
  resolved: ResolvedEmbed | null | undefined;
  signInHref?: string | null;
}

export function PageEmbed({ slug, mode, label, resolved, signInHref }: PageEmbedProps) {
  const [shown, setShown] = useState(false);
  if (!slug) return <LockedEmbed state="missing" />;
  if (resolved === undefined) {
    return (
      <div className="pb-embed pb-embed--loading not-prose" aria-busy="true">
        <span className="md-visually-hidden" role="status">Loading an embedded item</span>
        <Skeleton variant="rect" height={mode === "card" ? 72 : 220} />
      </div>
    );
  }
  if (!resolved || resolved.state !== "ok") return <LockedEmbed state={resolved?.state ?? "missing"} slug={slug} signInHref={signInHref} />;
  if (mode === "card") return <Card r={resolved} label={label} />;
  if (mode === "preview" && !shown && resolved.kind !== "document" && resolved.renderer !== "markdown") {
    return <Cover r={resolved} label={label} onShow={() => setShown(true)} />;
  }
  return <Live r={resolved} label={label} />;
}

/** `:markdrop[Title]{src}`: an inline chip; a locked one says "Restricted item" and nothing else. */
export function PageMention({ slug, resolved }: { slug: string | null; label?: string | null; resolved: ResolvedEmbed | null | undefined }) {
  if (!slug || resolved === null || (resolved && resolved.state !== "ok")) {
    return (
      <span className="pb-mention pb-mention--locked" title={resolved ? lockedOf(resolved.state).title : "Not available"}>
        <Icon name="lock" size={13} aria-hidden />
        <span>Restricted item</span>
      </span>
    );
  }
  if (resolved === undefined) {
    return (
      <span className="pb-mention pb-mention--loading" aria-busy="true">
        <Icon name="layers" size={13} aria-hidden />
        <span>Loading…</span>
      </span>
    );
  }
  // The title is the item's own, as this viewer may see it (never the label written in the page,
  // which an author could have typed for an item this viewer can't open).
  const title = resolved.title || "Untitled";
  const href = itemUrl(resolved.url, slug) ?? `/${encodeURIComponent(slug)}`;
  return (
    <a className="pb-mention md-focus" href={href}>
      {resolved.kind === "document" || resolved.renderer === "markdown" ? <Icon name="lines" size={13} aria-hidden /> : <FileIcon renderer={fileRenderer(resolved.renderer)} size={13} />}
      <span className="ph-sensitive" dir="auto">{title}</span>
    </a>
  );
}
