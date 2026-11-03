"use client";

/**
 * Notion's colours as menus: the text colour or the background colour of a run of text, a block,
 * a table cell or a selection of blocks. `ColorList` is the format toolbar's list (names, a sample,
 * the current one checked); `ColorGrid` is the compact two-row version for the block menu.
 */
import { useEffect, useRef } from "react";
import { COLORS } from "../core/attrs.mjs";

export type ColorChoice = { color: string } | { bg: string } | null;

export const COLOR_NAMES: Record<string, string> = {
  gray: "Gray", brown: "Brown", orange: "Orange", yellow: "Yellow", green: "Green", blue: "Blue", purple: "Purple", pink: "Pink", red: "Red",
};

const same = (a: ColorChoice, b: ColorChoice) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** "Red", "Red background", "Default". */
export function colorLabel(c: ColorChoice): string {
  if (!c) return "Default";
  if ("color" in c) return `${COLOR_NAMES[c.color] ?? c.color} text`;
  return `${COLOR_NAMES[c.bg] ?? c.bg} background`;
}

function Chip({ c }: { c: ColorChoice }) {
  return (
    <span className="pb-colors__chip" data-color={c && "color" in c ? c.color : undefined} data-bg={c && "bg" in c ? c.bg : undefined} aria-hidden>
      A
    </span>
  );
}

/** The list: Default, the nine text colours, then the nine backgrounds. */
export function ColorList({ current, onPick, onClose, textOnly = false, bgOnly = false, label = "Colour" }: {
  current: ColorChoice;
  onPick: (c: ColorChoice) => void;
  onClose?: () => void;
  textOnly?: boolean;
  bgOnly?: boolean;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? ref.current?.querySelector<HTMLButtonElement>("button");
    el?.focus({ preventScroll: true });
  }, []);
  const row = (c: ColorChoice, name: string) => (
    <button
      key={name}
      type="button"
      role="menuitemradio"
      aria-checked={same(c, current)}
      className="pb-colors__row"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onPick(c);
        onClose?.();
      }}
    >
      <Chip c={c} />
      {name}
    </button>
  );
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="pb-colors"
      onKeyDown={(e) => {
        const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose?.();
        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.stopPropagation();
      }}
    >
      {!bgOnly && <div className="pb-colors__head">Text colour</div>}
      {!bgOnly && row(null, "Default")}
      {!bgOnly && COLORS.map((c) => row({ color: c }, COLOR_NAMES[c]))}
      {!textOnly && <div className="pb-colors__head">Background</div>}
      {!textOnly && bgOnly && row(null, "Default background")}
      {!textOnly && COLORS.map((c) => row({ bg: c }, `${COLOR_NAMES[c]} background`))}
    </div>
  );
}

/** Two compact rows of swatches (for a menu's custom row). */
export function ColorGrid({ current, onPick, bgOnly = false }: { current: ColorChoice; onPick: (c: ColorChoice) => void; bgOnly?: boolean }) {
  const cell = (c: ColorChoice, key: string) => (
    <button
      key={key}
      type="button"
      className="pb-colorgrid__cell md-focus"
      aria-label={c ? colorLabel(c) : bgOnly ? "Default background" : "Default colour"}
      aria-pressed={same(c, current)}
      title={c ? colorLabel(c) : "Default"}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(c)}
    >
      <Chip c={c} />
    </button>
  );
  return (
    <div className="pb-colorgrid dxe-swatches" role="group" aria-label="Colour">
      {!bgOnly && (
        <div className="pb-colorgrid__row">
          {cell(null, "default")}
          {COLORS.map((c) => cell({ color: c }, `c-${c}`))}
        </div>
      )}
      <div className="pb-colorgrid__row">
        {bgOnly && cell(null, "default")}
        {!bgOnly && <span className="pb-colorgrid__gap" aria-hidden />}
        {COLORS.map((c) => cell({ bg: c }, `b-${c}`))}
      </div>
    </div>
  );
}
