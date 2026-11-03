"use client";

import { useId, type ReactNode } from "react";
import { navigateToHeading } from "./navigate";
import { tocHeadings, type Heading } from "./slug";
import { useActiveHeading } from "./useActiveHeading";

export interface TocProps {
  /** All headings (from MarkdownPreview `onHeadings` or `extractHeadings`); the Toc picks its entries with `tocHeadings`. */
  headings: Heading[];
  /** Controlled active id. Omit to let the Toc run its own scroll-spy. */
  activeId?: string | null;
  /** Encrypted document: navigation never touches the hash. */
  encrypted?: boolean;
  /** Visible title, also the nav's name (default "Contents"). */
  title?: string;
  /** "rail" (desktop left column) or "sheet" (44px rows for the mobile Contents sheet). */
  variant?: "rail" | "sheet";
  /** Under the list, e.g. "6 min read, 38% done". */
  footer?: ReactNode;
  /** Called after a jump (close the sheet, etc.). */
  onNavigate?: (id: string) => void;
  /** Who else is in each section (heading id → their colours and names): small dots beside it. */
  markers?: Record<string, { color: string; name: string; away?: boolean }[]>;
  className?: string;
}

/**
 * The Contents list (REVAMP_PLAN 7.6; Viewer board rail, MobileReading contents sheet). Entries
 * are buttons: a jump never navigates, it scrolls (navigateToHeading), so `#k=` survives.
 */
export function Toc({ headings, activeId, encrypted, title = "Contents", variant = "rail", footer, onNavigate, markers, className }: TocProps) {
  const entries = tocHeadings(headings);
  const spy = useActiveHeading(activeId === undefined ? entries.map((h) => h.id) : []);
  const active = activeId === undefined ? spy : activeId;
  const titleId = useId();
  if (!entries.length) return null;
  const min = Math.min(...entries.map((h) => h.depth));
  return (
    <nav aria-labelledby={titleId} className={["md-toc", `md-toc--${variant}`, "no-print", className].filter(Boolean).join(" ")}>
      <p id={titleId} className="md-toc__title">{title}</p>
      {/* ph-no-capture: the entries are the document's own headings, never recorded. */}
      <ol className="ph-no-capture md-toc__list">
        {entries.map((h) => {
          const current = h.id === active;
          return (
            <li key={h.id}>
              <button
                type="button"
                className="md-toc__item"
                data-level={h.depth - min}
                aria-current={current ? "location" : undefined}
                onClick={() => {
                  navigateToHeading(h.id, { encrypted });
                  onNavigate?.(h.id);
                }}
              >
                <span className="md-toc__text">{h.text}</span>
                {markers?.[h.id]?.length ? (
                  <span className="md-toc__presence">
                    {markers[h.id]!.slice(0, 3).map((m, i) => (
                      <span key={i} className={`md-toc__dot${m.away ? " md-toc__dot--away" : ""}`} style={{ background: m.color }} aria-hidden />
                    ))}
                    <span className="ph-mask md-visually-hidden">, {markers[h.id]!.map((m) => m.name).join(", ")} here</span>
                  </span>
                ) : null}
                {variant === "sheet" && current && <span className="md-toc__here">Reading</span>}
              </button>
            </li>
          );
        })}
      </ol>
      {footer && <div className="md-toc__footer">{footer}</div>}
    </nav>
  );
}
