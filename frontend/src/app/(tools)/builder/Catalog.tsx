"use client";

import { useId, useMemo, useState } from "react";
import { Badge, Icon, Input, cx } from "@/components/ui";
import { GROUP_ORDER, SECTION_TEMPLATES, type SectionGroup, type SectionTemplate } from "@/lib/readmeSections";
import { SectionIcon } from "@/lib/readmeSectionIcons";
import styles from "./builder.module.css";

interface Props {
  /** How many times each template is already in the README. */
  usedCounts: Record<string, number>;
  onAdd: (tpl: SectionTemplate) => void;
  query: string;
  onQueryChange: (q: string) => void;
  /** "rail": the desktop left column. "sheet": the phone bottom sheet (adds group chips, 52px rows). */
  variant?: "rail" | "sheet";
  className?: string;
}

/** "Add a section": search + the grouped template catalog. One click (or tap) adds. */
export default function Catalog({ usedCounts, onAdd, query, onQueryChange, variant = "rail", className }: Props) {
  const id = useId();
  const [group, setGroup] = useState<SectionGroup | "all">("all");
  const sheet = variant === "sheet";

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return GROUP_ORDER.filter((g) => !sheet || group === "all" || g === group)
      .map((g) => ({
        group: g,
        items: SECTION_TEMPLATES.filter((t) => t.group === g && (!q || t.name.toLowerCase().includes(q))),
      }))
      .filter((g) => g.items.length > 0);
  }, [query, group, sheet]);

  return (
    <div className={cx("flex min-h-0 min-w-0 flex-col", sheet && styles.sheet, className)}>
      <div className={cx("shrink-0", sheet && "px-4")}>
        <Input
          type="search"
          prefix="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search sections"
          aria-label="Search sections"
          className={sheet ? "h-11" : undefined}
        />
      </div>
      {sheet && (
        <div role="group" aria-label="Filter by group" className={cx(styles.chips, "mt-3 shrink-0")}>
          {(["all", ...GROUP_ORDER] as const).map((g) => {
            const on = group === g;
            return (
              <button
                key={g}
                type="button"
                aria-pressed={on}
                onClick={() => setGroup(g)}
                className={cx(
                  "md-focus h-11 shrink-0 whitespace-nowrap rounded-full border px-4 text-body-strong transition-colors",
                  on ? "border-accent bg-accent-soft text-accent-text" : "border-border-strong bg-surface text-text-secondary hover:bg-surface-hover",
                )}
              >
                {g === "all" ? "All" : g}
              </button>
            );
          })}
        </div>
      )}
      <div className={cx("min-h-0 flex-1", sheet ? "border-t border-border pb-4" : "mt-2 -mx-1 overflow-y-auto px-1 pb-2")}>
        {groups.map(({ group: g, items }) => {
          const headingId = `${id}-${g.replace(/\W+/g, "-")}`;
          return (
            <div key={g} role="group" aria-labelledby={headingId} className="mt-3 first:mt-1">
              <h3 id={headingId} className={cx("text-eyebrow text-text-muted", sheet ? "px-4 pt-3 pb-1" : "px-2 pb-1")}>
                {g}
              </h3>
              <ul className="flex flex-col">
                {items.map((tpl) => {
                  const n = usedCounts[tpl.id] ?? 0;
                  return (
                    <li key={tpl.id}>
                      <button
                        type="button"
                        className={cx(styles.add, "md-focus")}
                        onClick={() => onAdd(tpl)}
                        aria-label={n ? `${tpl.name}, already in your README. Add another` : `Add ${tpl.name}`}
                      >
                        <span className={styles.tile} aria-hidden="true">
                          <SectionIcon id={tpl.id} size={16} />
                        </span>
                        <span className={cx("min-w-0 flex-1 truncate", sheet ? "text-body" : "text-body")}>{tpl.name}</span>
                        {n > 0 && (
                          <Badge tone="success" size="sm" icon="check" aria-hidden>
                            {n === 1 ? "Added" : `Added ×${n}`}
                          </Badge>
                        )}
                        <span className={styles.plus} aria-hidden="true">
                          <Icon name="plus" size={sheet ? 18 : 16} />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
        {groups.length === 0 && (
          <p className={cx("py-6 text-center text-body text-text-muted", sheet && "px-4")} role="status">
            No sections match “{query.trim()}”. Try another word, or add a Custom section.
          </p>
        )}
      </div>
    </div>
  );
}
