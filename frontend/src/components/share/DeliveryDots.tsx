"use client";

/**
 * DeliveryDots (REVAMP_PLAN 7.16): one dot per recipient for a file — filled success = has it,
 * accent ring = receiving, border-strong ring = doesn't have it. Never status alone: every dot has
 * an aria-label naming the person and state, and the row always shows the text summary
 * ("Delivered to 2 · sending to 1").
 *
 * lib/p2p reports per-file COUNTS (`delivered`, `sending`), not who. A dot is only given a name when
 * the snapshot proves it: the person currently receiving this file (`currentName`), someone who has
 * every file, or someone who hasn't asked for anything. Counts that can't be attributed are labelled
 * "Someone" rather than guessed.
 */
import { memo } from "react";
import { cx } from "@/components/ui";
import type { RecipientView, SenderFileView } from "@/lib/p2p/sender";

export type DotState = "has" | "receiving" | "waiting";
export interface Dot { state: DotState; label: string }

export function dotsFor(f: SenderFileView, recipients: RecipientView[], totalFiles: number): Dot[] {
  let has = f.delivered;
  let rx = f.sending;
  const named: Dot[] = [];
  const rest: RecipientView[] = [];
  for (const r of recipients) {
    if (rx > 0 && r.state === "downloading" && r.currentName === f.file.name) {
      named.push({ state: "receiving", label: `${r.label}: receiving` });
      rx--;
    } else if (has > 0 && totalFiles > 0 && r.filesWanted === totalFiles && r.filesDone === totalFiles) {
      named.push({ state: "has", label: `${r.label}: has it` });
      has--;
    } else {
      rest.push(r);
    }
  }
  const anon: Dot[] = [
    ...Array.from({ length: has }, () => ({ state: "has" as const, label: "Someone: has it" })),
    ...Array.from({ length: rx }, () => ({ state: "receiving" as const, label: "Someone: receiving" })),
  ];
  const unknown = has + rx > 0;
  const waiting: Dot[] = rest.slice(anon.length).map((r) => ({
    state: "waiting",
    label: unknown
      ? "Someone: doesn't have it yet"
      : r.filesWanted === 0 ? `${r.label}: hasn't asked for it` : `${r.label}: doesn't have it yet`,
  }));
  const order: Record<DotState, number> = { has: 0, receiving: 1, waiting: 2 };
  return [...named, ...anon, ...waiting].sort((a, b) => order[a.state] - order[b.state]);
}

export function deliverySummary(f: Pick<SenderFileView, "delivered" | "sending">): string {
  const parts: string[] = [];
  if (f.delivered > 0) parts.push(`Delivered to ${f.delivered}`);
  if (f.sending > 0) parts.push(`${parts.length ? "sending" : "Sending"} to ${f.sending}`);
  return parts.length ? parts.join(" · ") : "Ready to send";
}

const MAX = 10;

function DeliveryDotsImpl({ dots, className }: { dots: Dot[]; className?: string }) {
  if (!dots.length) return null;
  const shown = dots.slice(0, MAX);
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-[5px]", className)}>
      {shown.map((d, i) => (
        <span
          key={i}
          role="img"
          aria-label={d.label}
          title={d.label}
          className={cx(
            "box-border size-2.5 rounded-full border-2",
            d.state === "has" && "border-success-fill bg-success-fill",
            d.state === "receiving" && "border-accent bg-transparent",
            d.state === "waiting" && "border-border-strong bg-transparent",
          )}
        />
      ))}
      {dots.length > MAX && <span className="text-micro text-text-muted">+{dots.length - MAX}</span>}
    </span>
  );
}

export const DeliveryDots = memo(DeliveryDotsImpl, (a, b) =>
  a.className === b.className && a.dots.length === b.dots.length && a.dots.every((d, i) => d.state === b.dots[i].state && d.label === b.dots[i].label));
export default DeliveryDots;
