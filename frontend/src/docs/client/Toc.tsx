"use client";

import { useState } from "react";
import { Badge, Drawer, Icon, cx } from "@/components/ui";
import { useActiveHeading } from "@/components/reading/useActiveHeading";
import { useDocPage } from "./page";
import { useChangedSections } from "./state";

export interface TocEntry {
  id: string;
  text: string;
  depth: number;
}

const NO_HASHES: Record<string, string> = {};

function useChanged(): Set<string> {
  const page = useDocPage();
  return new Set(useChangedSections(page?.path ?? "", page?.hashes ?? NO_HASHES));
}

function jump(id: string, e?: React.MouseEvent) {
  const el = document.getElementById(id);
  if (!el) return;
  e?.preventDefault();
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  history.replaceState(history.state, "", `#${id}`);
  // Move focus for keyboard and screen-reader users without a second scroll.
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

function TocList({ entries, active, changed, onPick, sheet }: { entries: TocEntry[]; active: string | null; changed: Set<string>; onPick?: () => void; sheet?: boolean }) {
  const min = Math.min(...entries.map((h) => h.depth));
  return (
    <ol className={cx("dx-toc__list", sheet && "dx-toc__list--sheet")}>
      {entries.map((h) => (
        <li key={h.id}>
          <a
            href={`#${h.id}`}
            className="dx-toc__item"
            data-level={h.depth - min}
            aria-current={h.id === active ? "location" : undefined}
            onClick={(e) => {
              jump(h.id, e);
              onPick?.();
            }}
          >
            <span className="dx-toc__text">{h.text}</span>
            {changed.has(h.id) && <span className="dx-toc__dot" title="Changed since you last read it" aria-label="Changed since you last read it" role="img" />}
          </a>
        </li>
      ))}
    </ol>
  );
}

/** The right rail's "On this page" with scroll-spy and changed dots. */
export function DocsToc({ entries }: { entries: TocEntry[] }) {
  const active = useActiveHeading(entries.map((e) => e.id), { offset: 0.25 });
  const changed = useChanged();
  if (!entries.length) return null;
  return (
    <nav aria-labelledby="dx-toc-title" className="dx-toc">
      <p id="dx-toc-title" className="dx-eyebrow">On this page</p>
      <TocList entries={entries} active={active} changed={changed} />
    </nav>
  );
}

/** "2 sections changed since you last read this" in the meta row (nothing on a first visit). */
export function ChangedBadge() {
  const changed = useChanged();
  if (!changed.size) return null;
  const n = changed.size;
  return (
    <Badge tone="info" size="sm" icon="bulb">
      {n === 1 ? "1 section changed since you last read this" : `${n} sections changed since you last read this`}
    </Badge>
  );
}

/** Below the header on narrow screens: the current section, opening a contents sheet. */
export function OnThisPageBar({ entries }: { entries: TocEntry[] }) {
  const active = useActiveHeading(entries.map((e) => e.id), { offset: 0.25 });
  const changed = useChanged();
  const [open, setOpen] = useState(false);
  if (!entries.length) return null;
  const current = entries.find((e) => e.id === active) ?? entries[0];
  return (
    <>
      <button type="button" className="dx-otp no-print" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <span className="dx-otp__label">
          On this page · <strong>{current.text}</strong>
        </span>
        <Icon name="chevronDown" />
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} side="bottom" title="On this page">
        <TocList entries={entries} active={active} changed={changed} onPick={() => setOpen(false)} sheet />
      </Drawer>
    </>
  );
}
