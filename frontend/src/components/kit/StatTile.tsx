/**
 * StatTile + Delta (K2 link & frames kit; REVAMP_PLAN 7.10, 8.2).
 *
 * StatTile: label, a tabular-nums value (never counts up; a changed value crossfades in 150ms), an
 * optional Delta, caption and chart slot. States: loading (skeleton, aria-busy), error (danger icon +
 * words, never colour alone), selected (accent edge; with `onSelect` the tile is a toggle button with
 * aria-pressed, as in the admin KPI row). Sizes: sm (analytics drawer) and md (admin KPI).
 *
 * Delta: always an arrow plus words. The visible value ("12%") is backed by a screen-reader sentence
 * ("Up 12% vs the previous 30 days"). Tone defaults to success for up, danger for down, neutral for
 * flat (override with `tone`, e.g. "warning" for a soft drop).
 *
 * Server-compatible (no hooks); `onSelect` requires a client caller.
 */
import type { ReactNode } from "react";
import { KitIcon } from "./DeviceGlyph";
import styles from "./StatTile.module.css";

export type DeltaDirection = "up" | "down" | "flat";
export type DeltaTone = "success" | "warning" | "danger" | "neutral";

export interface DeltaValue {
  /** Visible value: "12%", "3 pts", "64 more than the 30 days before". */
  value: string;
  direction: DeltaDirection;
  /** The full sentence for screen readers and the tooltip, e.g. "Up 12% vs the previous 30 days". */
  text?: string;
  tone?: DeltaTone;
}

export interface DeltaProps extends DeltaValue {
  /** "inline" (micro text) or "badge" (a soft pill). */
  variant?: "inline" | "badge";
  className?: string;
}

const ARROW: Record<DeltaDirection, string> = { up: "arrowUp", down: "arrowDown", flat: "minus" };
const WORD: Record<DeltaDirection, string> = { up: "Up", down: "Down", flat: "No change," };
const TONE: Record<DeltaDirection, DeltaTone> = { up: "success", down: "danger", flat: "neutral" };

export function Delta({ value, direction, text, tone, variant = "inline", className }: DeltaProps) {
  const sentence = text ?? `${WORD[direction]} ${value}`;
  return (
    <span
      className={[styles.delta, className ?? ""].join(" ")}
      data-tone={tone ?? TONE[direction]}
      data-variant={variant}
      title={sentence}
    >
      <KitIcon name={ARROW[direction]} size={variant === "badge" ? 12 : 12} className={styles.deltaIcon} />
      <span aria-hidden="true">{value}</span>
      <span className="md-visually-hidden">{sentence}</span>
    </span>
  );
}

export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  delta?: DeltaValue;
  /** Quiet line under the value ("Unique, vs 1,204 before"). */
  caption?: ReactNode;
  /** Icon name before the label (md). */
  icon?: string;
  /** A sparkline or mini chart (decorative; give it aria-hidden). */
  chart?: ReactNode;
  selected?: boolean;
  /** Makes the tile a toggle button (aria-pressed = selected). */
  onSelect?: () => void;
  loading?: boolean;
  /** true or a message ("Couldn't load views"). */
  error?: boolean | string;
  size?: "sm" | "md";
  className?: string;
}

export function StatTile({
  label,
  value,
  delta,
  caption,
  icon,
  chart,
  selected,
  onSelect,
  loading,
  error,
  size = "sm",
  className,
}: StatTileProps) {
  const errText = typeof error === "string" ? error : "Couldn't load";
  const body = (
    <>
      <span className={styles.head}>
        <span className={styles.label}>
          {icon && <KitIcon name={icon} size={16} />}
          {label}
        </span>
        {size === "md" && delta && !loading && !error && <Delta {...delta} variant="badge" />}
      </span>
      <span className={styles.main}>
        <span className={styles.figures}>
          {loading ? (
            <span className={`md-skeleton ${styles.skel}`} aria-hidden="true" />
          ) : error ? (
            <span className={styles.error}>
              <KitIcon name="alertCircle" size={14} />
              {errText}
            </span>
          ) : (
            <span key={String(value)} className={styles.value}>
              {value}
            </span>
          )}
          {loading && <span className="md-visually-hidden">Loading</span>}
          {size === "sm" && delta && !loading && !error && <Delta {...delta} variant="inline" />}
          {caption && !loading && <span className={styles.caption}>{caption}</span>}
        </span>
        {chart && !loading && !error && (
          <span className={styles.chart} aria-hidden="true">
            {chart}
          </span>
        )}
      </span>
    </>
  );

  const common = {
    className: [styles.tile, className ?? ""].join(" "),
    "data-size": size,
    "data-selected": selected || undefined,
    "aria-busy": loading || undefined,
  };

  if (onSelect) {
    return (
      <button type="button" {...common} className={`${common.className} md-focus`} aria-pressed={!!selected} onClick={onSelect}>
        {body}
      </button>
    );
  }
  return <div {...common}>{body}</div>;
}

export default StatTile;
