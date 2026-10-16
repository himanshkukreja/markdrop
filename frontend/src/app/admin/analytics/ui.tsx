"use client";

/** Shared building blocks for the analytics pages (Overview, Product health), on DS tokens. */

import { Alert, Button } from "@/components/ui";
import type { DeltaValue } from "@/components/kit/StatTile";
import { LoadingBlock } from "../shared";

/** A card: `surface`, hairline, radius-xl. Titles are h2 (the page h1 sits above). */
export function Card({ children, className = "", ...rest }: { children: React.ReactNode; className?: string } & React.HTMLAttributes<HTMLElement>) {
  return <section className={`min-w-0 rounded-xl border border-border bg-surface p-4 sm:p-5 ${className}`} {...rest}>{children}</section>;
}

export function CardTitle({ title, sub, right, id }: { title: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode; id?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
      <div className="min-w-0">
        <h2 id={id} className="text-h4 text-text">{title}</h2>
        {sub && <p className="mt-0.5 text-caption text-text-secondary">{sub}</p>}
      </div>
      {right && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

/** A small uppercase label above a list or chart inside a card. */
export function Eyebrow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <h3 className={`mb-2 text-eyebrow uppercase text-text-muted ${className}`}>{children}</h3>;
}

/**
 * Per-card loading state: the card's title and the Markdrop loader in the space the chart will
 * take (`height`), so the page doesn't jump when it lands.
 */
export function CardSkeleton({ title, height = 220, className = "" }: { title?: string; height?: number; className?: string }) {
  return (
    <Card className={className}>
      {title && <h2 className="mb-4 text-h4 text-text">{title}</h2>}
      <LoadingBlock label={title ? `Loading ${title.toLowerCase()}` : "Loading"} minHeight={height} className="py-0" />
    </Card>
  );
}

/** Per-card error: what failed and a Retry that refetches just that card. */
export function CardError({ title, onRetry, className = "" }: { title: string; onRetry: () => void; className?: string }) {
  return (
    <Card className={className}>
      <h2 className="mb-3 text-h4 text-text">{title}</h2>
      <Alert tone="danger" actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={onRetry}>Retry</Button>}>
        Couldn&apos;t load this card. The rest of the page is unaffected.
      </Alert>
    </Card>
  );
}

/**
 * The change against the previous period, for the kit `Delta` (always an arrow plus words).
 * `lowerIsBetter` flips the tone (a falling bounce rate is good).
 */
export function deltaOf(now: number, prev: number, vs: string, lowerIsBetter = false): DeltaValue | undefined {
  if (!prev && !now) return undefined;
  if (!prev) return { value: "New", direction: "up", tone: "neutral", text: `New: none in the previous ${vs}` };
  const pct = Math.round(((now - prev) / prev) * 100);
  if (pct === 0) return { value: "0%", direction: "flat", text: `No change vs the previous ${vs}` };
  const up = pct > 0;
  const good = lowerIsBetter ? !up : up;
  return {
    value: `${Math.abs(pct)}%`,
    direction: up ? "up" : "down",
    tone: good ? "success" : "danger",
    text: `${up ? "Up" : "Down"} ${Math.abs(pct)}% vs the previous ${vs}`,
  };
}

/** A labelled figure inside a card; `accent` marks the one number a section is about. */
export function Figure({ label, value, foot, accent }: { label: string; value: string; foot?: string; accent?: boolean }) {
  return (
    <div className={`min-w-0 rounded-lg border p-3.5 ${accent ? "border-accent bg-accent-soft" : "border-border bg-surface-inset"}`}>
      <p className={`text-caption font-medium ${accent ? "text-accent-text" : "text-text-secondary"}`}>{label}</p>
      <p className="mt-1 text-h3 tabular-nums text-text">{value}</p>
      {foot && <p className="mt-0.5 text-micro text-text-secondary">{foot}</p>}
    </div>
  );
}
