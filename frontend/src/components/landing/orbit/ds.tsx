/**
 * Server-safe mirrors of the few design-system pieces the hero draws: same markup, same `md-*`
 * classes (markdrop.css), so they look identical to `@/components/ui/primitives` / `markdrop`.
 *
 * Why local: primitives.tsx and markdrop.tsx call `createContext` / hooks at module scope without
 * "use client", so a server component cannot import them (the poster is server HTML). Swap these for
 * the real components once the design system ships a server-safe entry.
 */
import type { CSSProperties, ReactNode } from "react";
import { ICONS } from "@/components/ui/icons";
import type { Tone } from "./data";

const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(" ");

export function Icon({ name, size, className, style }: { name: string; size?: number; className?: string; style?: CSSProperties }) {
  const d = (ICONS as Record<string, string>)[name] ?? "";
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={cx("md-icon", className)} style={size ? { fontSize: size, ...style } : style}>
      <path d={d} />
    </svg>
  );
}

export function Badge({ tone = "neutral", icon, className, title, children }: { tone?: Tone; icon?: string; className?: string; title?: string; children: ReactNode }) {
  return <span className={cx("md-badge", `md-badge--${tone}`, className)} title={title}>{icon && <Icon name={icon} />}{children}</span>;
}

export function ButtonLink({ href, variant = "primary", size = "lg", iconLeft, iconRight, block, className, children, target, rel, ...data }: {
  href: string; variant?: "primary" | "secondary" | "ghost"; size?: "md" | "lg"; iconLeft?: string; iconRight?: string; block?: boolean; className?: string; children: ReactNode;
  target?: string; rel?: string; "data-cta"?: string;
}) {
  return (
    <a href={href} target={target} rel={rel} className={cx("md-btn", `md-btn--${variant}`, `md-btn--${size}`, block && "md-btn--block", className)} {...data}>
      {iconLeft && <Icon name={iconLeft} />}{children}{iconRight && <Icon name={iconRight} />}
    </a>
  );
}

/** The mark, drawn exactly as app/icon.svg (logo colours are fixed in both themes). */
export function MarkdropMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={className}>
      <rect width="32" height="32" rx="8" fill="var(--logo-ground)" />
      <text x="3" y="23" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" fontSize="18" fontWeight="700" fill="var(--logo-ink)">m</text>
      <circle cx="27" cy="20" r="4" fill="var(--logo-dot)" />
    </svg>
  );
}

export function VSCodeIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" className={className}>
      <path d="M17.583 2.25 9.21 10.313 4.2 6.52 2 7.58v8.84l2.2 1.06 5.01-3.793 8.373 8.063L22 19.79V4.21l-4.417-1.96zM4.2 13.98V10.02L6.6 12l-2.4 1.98zm13.383 2.19L12.28 12l5.303-4.17v8.34z" />
    </svg>
  );
}

/** The boards' paper-plane send glyph (the DS `send` icon has a different shape). */
export function SendGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M4 12 20 4l-5 16-3.5-6.5z" /><path d="m11.5 13.5 3-3" />
    </svg>
  );
}

/** Docs Studio: a docs site (frame, sidebar, page lines), drawn with the DS icon stroke. */
const STUDIO_D = "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9.5 4v16M13 9h4.5M13 12.5h4.5M13 16h2.5M5.75 8.5h1.25M5.75 11.5h1.25";
export function StudioGlyph({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={cx("md-icon", className)} style={{ fontSize: size }}>
      <path d={STUDIO_D} />
    </svg>
  );
}

/** Moon, card and stamp glyphs: the DS icon, or the VS Code mark, or the send glyph, or Docs Studio. */
export function Glyph({ icon, size }: { icon: string; size: number }) {
  if (icon === "vscode") return <VSCodeIcon size={size - 2} />;
  if (icon === "send") return <SendGlyph size={size} />;
  if (icon === "studio") return <StudioGlyph size={size} />;
  return <Icon name={icon} size={size} />;
}

function kind(name: string, mime: string): { icon: string; tint: string } {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (mime.startsWith("video/")) return { icon: "film", tint: "var(--cat-share)" };
  if (ext === "pdf" || mime === "application/pdf") return { icon: "doc", tint: "var(--danger)" };
  if (/^(zip|gz|tar|rar|7z)$/.test(ext) || mime.includes("zip")) return { icon: "archive", tint: "var(--cat-artifact)" };
  if (/^(csv|xlsx?|tsv)$/.test(ext)) return { icon: "table", tint: "var(--success)" };
  if (/^(md|markdown|txt|docx?)$/.test(ext)) return { icon: "lines", tint: "var(--cat-document)" };
  if (/^(js|ts|tsx|jsx|py|go|rs|json|html|css|sh)$/.test(ext)) return { icon: "code", tint: "var(--cat-sync)" };
  return { icon: "doc", tint: "var(--text-muted)" };
}
export function FileIcon({ name, mime, size = 20 }: { name: string; mime: string; size?: number }) {
  const k = kind(name, mime);
  return <Icon name={k.icon} size={size} style={{ color: k.tint }} />;
}

export function RouteBadge({ route }: { route: "direct" | "relay" }) {
  const relay = route === "relay";
  return <Badge tone={relay ? "info" : "success"} icon={relay ? "wave" : "arrowRight"}>{relay ? "Relayed" : "Direct"}</Badge>;
}

export function Progress({ value, max, label, className }: { value: number; max: number; label: string; className?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={cx("md-progress", "md-progress--sm", className)}>
      <div className="md-progress__track" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
        <div className="md-progress__bar" style={{ width: pct + "%" }} />
      </div>
    </div>
  );
}

/** The courier drop, with or without eyes. `blink` marks the eyes as an ambient loop. */
export function DropSvg({ w, h, eyes, blinkCls, pathCls, eyeCls }: { w: number; h: number; eyes?: boolean; blinkCls?: string; pathCls: string; eyeCls?: string }) {
  return (
    <svg viewBox="0 0 14 18" width={w} height={h} aria-hidden="true" focusable="false">
      <path className={pathCls} d="M7 0.5c0 0 6 7.4 6 10.6a6 6 0 0 1-12 0C1 7.9 7 0.5 7 0.5z" />
      {eyes && <circle className={cx(eyeCls, blinkCls)} cx="5.1" cy="11.2" r="0.95" />}
      {eyes && <circle className={cx(eyeCls, blinkCls)} cx="8.9" cy="11.2" r="0.95" />}
    </svg>
  );
}
