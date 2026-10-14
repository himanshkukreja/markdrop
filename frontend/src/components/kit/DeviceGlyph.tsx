/**
 * DeviceGlyph and KitIcon (K2 link & frames kit).
 *
 * Server-compatible (no "use client", no hooks): icon geometry comes from the plain ICONS data module,
 * drawn with the DS `.md-icon` class (24px grid, 1.8 stroke, currentColor), so the frames kit can render
 * on the server without a client boundary.
 */
import type { CSSProperties } from "react";
import { ICONS } from "@/components/ui/icons";
import styles from "./DeviceGlyph.module.css";

export interface KitIconProps {
  name: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/** The DS icon set drawn without a client component. Always decorative (aria-hidden). */
export function KitIcon({ name, size = 16, className, style }: KitIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={className ? `md-icon ${className}` : "md-icon"}
      style={{ fontSize: size, ...style }}
    >
      <path d={ICONS[name] ?? ""} />
    </svg>
  );
}

export type DeviceKind = "laptop" | "phone" | "tablet" | "terminal" | "monitor";

export interface DeviceGlyphProps {
  kind: DeviceKind;
  /** Glyph size in px (default 24). */
  size?: number;
  /** Draw the glyph inside a round node of this diameter (true = size × 2). */
  framed?: boolean | number;
  /** Node fill when framed: neutral (surface, border-strong) or accent (the "This device" node). */
  tone?: "neutral" | "accent";
  /** Accessible name. Without it the glyph is decorative. */
  label?: string;
  className?: string;
}

/** A device glyph (laptop, phone, tablet, terminal, monitor), optionally on a round node. */
export function DeviceGlyph({ kind, size = 24, framed, tone = "neutral", label, className }: DeviceGlyphProps) {
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
  const glyph = <KitIcon name={kind} size={size} />;
  if (!framed) {
    return (
      <span {...a11y} className={className ? `${styles.bare} ${className}` : styles.bare}>
        {glyph}
      </span>
    );
  }
  const d = typeof framed === "number" ? framed : size * 2;
  return (
    <span
      {...a11y}
      data-tone={tone}
      className={className ? `${styles.node} ${className}` : styles.node}
      style={{ width: d, height: d }}
    >
      {glyph}
    </span>
  );
}

export default DeviceGlyph;
