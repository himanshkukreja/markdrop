"use client";
/**
 * QRFrame (K2 link & frames kit): a QR code on the always-white `--qr-ground` (scanners need a light
 * quiet zone), with a hairline border in light so the tile doesn't melt into a pale card
 * (REVAMP_PLAN 5.4). Modules are drawn in the constant `--logo-ground` ink (#0f172a, ~17:1 on white).
 *
 * The tile is `role="img"` with an aria-label naming the link. `expandable` adds a ghost IconButton
 * "Show QR full screen" that opens a DS Dialog (size xl) with a 320px code. The tile fades in once
 * (150ms) when it mounts or the value changes; nothing under reduced motion.
 */
import { useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Dialog, IconButton } from "@/components/ui";
import styles from "./QRFrame.module.css";

export interface QRFrameProps {
  /** The URL (or text) to encode. */
  value: string;
  /** Tile size in px, white margin included (default 152). */
  size?: number;
  /** Visible label next to / under the code, e.g. "Scan to open". Also titles the full-screen dialog. */
  label?: string;
  /** Quieter second line under the label, e.g. "Point a phone camera at it." */
  caption?: ReactNode;
  /** Accessible name of the code. Default "QR code for <value without https://>". */
  ariaLabel?: string;
  /** Show the expand IconButton that opens the full-screen dialog. */
  expandable?: boolean;
  /** Where the label block sits: beside the tile (default) or below it. */
  layout?: "row" | "stack";
  className?: string;
}

const pretty = (v: string) => v.replace(/^https?:\/\//i, "");

function Code({ value, size, ariaLabel, fluid }: { value: string; size: number; ariaLabel: string; fluid?: boolean }) {
  const pad = Math.max(6, Math.round(size * 0.05));
  // fluid: never wider than its container (the 320px dialog code on a 320px-wide phone).
  const box = fluid ? { width: `min(${size}px, 100%)`, padding: pad } : { width: size, height: size, padding: pad };
  return (
    <div role="img" aria-label={ariaLabel} className={styles.tile} data-fluid={fluid || undefined} style={box}>
      <QRCodeSVG
        value={value}
        size={size - pad * 2}
        level="M"
        marginSize={2}
        bgColor="transparent"
        fgColor="currentColor"
        aria-hidden="true"
        focusable="false"
        className={styles.svg}
      />
    </div>
  );
}

export function QRFrame({ value, size = 152, label, caption, ariaLabel, expandable, layout = "row", className }: QRFrameProps) {
  const [open, setOpen] = useState(false);
  const name = ariaLabel ?? `QR code for ${pretty(value)}`;
  const hasSide = !!(label || caption || expandable);

  return (
    <div className={[styles.frame, className ?? ""].join(" ")} data-layout={layout}>
      <Code key={value} value={value} size={size} ariaLabel={name} />
      {hasSide && (
        <div className={styles.side}>
          {label && <span className={styles.label}>{label}</span>}
          {caption && <span className={styles.caption}>{caption}</span>}
          {expandable && (
            <IconButton icon="expand" label="Show QR full screen" size="sm" variant="secondary" onClick={() => setOpen(true)} className={styles.expand} />
          )}
        </div>
      )}
      {expandable && (
        <Dialog open={open} onClose={() => setOpen(false)} title={label ?? "Scan to open"} description={pretty(value)} size="xl">
          <div className={styles.full}>
            <div className={styles.fullBox}>
              <Code value={value} size={320} ariaLabel={name} fluid />
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export default QRFrame;
