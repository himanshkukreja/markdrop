"use client";

import { navigateToHeading } from "./navigate";
import { tocHeadings, type Heading } from "./slug";
import { useActiveHeading } from "./useActiveHeading";

export interface TocTicksProps {
  headings: Heading[];
  /** Controlled active id. Omit to let the ticks run their own scroll-spy. */
  activeId?: string | null;
  /** Encrypted document: navigation never touches the hash. */
  encrypted?: boolean;
  /** Fewest entries before the ticks show (default 3, REVAMP_PLAN 7.6). */
  min?: number;
  className?: string;
}

/**
 * Immersive reader ticks (REVAMP_PLAN 7.6): fixed at left 32px, one 12px `border-strong` tick per
 * heading, the active one wider in `accent-text`. Each tick is a button named by its heading;
 * hover OR keyboard focus expands the column into a `surface-raised` panel with the titles.
 * Hidden below 768px (phones use the Contents sheet) and in print.
 */
export function TocTicks({ headings, activeId, encrypted, min = 3, className }: TocTicksProps) {
  const entries = tocHeadings(headings);
  const spy = useActiveHeading(activeId === undefined ? entries.map((h) => h.id) : []);
  const active = activeId === undefined ? spy : activeId;
  if (entries.length < min) return null;
  const top = Math.min(...entries.map((h) => h.depth));
  return (
    <nav aria-label="Contents" className={["md-ticks no-print", className].filter(Boolean).join(" ")}>
      <ol className="md-ticks__list">
        {entries.map((h) => {
          const current = h.id === active;
          return (
            <li key={h.id}>
              <button
                type="button"
                className="md-ticks__item"
                data-level={h.depth - top}
                aria-label={h.text}
                aria-current={current ? "location" : undefined}
                onClick={() => navigateToHeading(h.id, { encrypted })}
              >
                <span className="md-ticks__tick" aria-hidden />
                <span className="md-ticks__label" aria-hidden>{h.text}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
