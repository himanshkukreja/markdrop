"use client";

import { useEffect, useState } from "react";

/** A spread of hues that read as brand colours rather than as a rainbow. */
const SWATCHES = [
  "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#ec4899",
  "#ef4444", "#f97316", "#f59e0b", "#10b981", "#14b8a6",
  "#06b6d4", "#0ea5e9", "#64748b", "#111827",
];

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Accent colour, as a swatch grid plus the OS colour picker plus a hex field.
 *
 * Three affordances rather than one because they serve different people: most
 * users want a decent colour in one click, a designer wants the exact brand hex,
 * and the native picker covers everything in between.
 *
 * The typed hex is held in local state while it is being edited and only pushed
 * up once it parses. Without that, typing "#1" over a selection would commit an
 * invalid colour on the first keystroke and the server would reject the save.
 */
export default function ColorPicker({
  value,
  disabled,
  onChange,
}: {
  value: string | null;
  disabled?: boolean;
  onChange: (hex: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");

  // Re-sync when the value changes from outside (a swatch click, or a reload).
  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  const current = value && HEX.test(value) ? value : "#3b82f6";
  const invalid = draft.trim() !== "" && !HEX.test(draft.trim());

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <span className="text-[13px] font-medium text-gray-700 dark:text-gray-300">Accent colour</span>
        {value && !disabled && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-[11px] text-gray-400 hover:text-red-500 transition-colors"
          >
            Reset
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5 mb-2.5">
        {SWATCHES.map((hex) => {
          const active = value?.toLowerCase() === hex;
          return (
            <button
              key={hex}
              type="button"
              disabled={disabled}
              title={hex}
              aria-label={`Use ${hex}`}
              aria-pressed={active}
              onClick={() => onChange(hex)}
              style={{ background: hex }}
              className={`w-7 h-7 rounded-lg transition-transform disabled:opacity-50 disabled:cursor-not-allowed ${
                active
                  ? "ring-2 ring-offset-2 ring-gray-900 dark:ring-white ring-offset-white dark:ring-offset-gray-950 scale-105"
                  : "hover:scale-110"
              }`}
            />
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <label
          className={`relative w-9 h-9 shrink-0 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden ${
            disabled ? "opacity-50" : "cursor-pointer"
          }`}
          style={{ background: current }}
          title="Pick any colour"
        >
          <input
            type="color"
            value={current}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 opacity-0 w-full h-full cursor-pointer disabled:cursor-not-allowed"
          />
        </label>
        <input
          value={draft}
          disabled={disabled}
          placeholder="#3b82f6"
          spellCheck={false}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            const trimmed = next.trim();
            if (trimmed === "") onChange(null);
            else if (HEX.test(trimmed)) onChange(trimmed);
          }}
          className={`flex-1 min-w-0 bg-gray-50 dark:bg-gray-900 border rounded-lg px-3 py-2 text-sm font-mono outline-none transition-colors ${
            invalid
              ? "border-red-400 focus:border-red-500"
              : "border-gray-200 dark:border-gray-700 focus:border-blue-500"
          }`}
        />
      </div>
      {invalid && <p className="text-[11px] text-red-500 mt-1.5">Use a hex colour like #3b82f6.</p>}
    </div>
  );
}
