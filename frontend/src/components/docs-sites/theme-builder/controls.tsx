"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Button, Icon, IconButton, SegmentedControl, Tooltip, cx } from "@/components/ui";
import { parseHex } from "@/docs/theme.mjs";

/** The browser's eyedropper (Chromium), when it has one. */
interface EyeDropperApi { open: () => Promise<{ sRGBHex: string }> }
function eyeDropper(): EyeDropperApi | null {
  if (typeof window === "undefined" || !("EyeDropper" in window)) return null;
  const Ctor = (window as unknown as { EyeDropper: new () => EyeDropperApi }).EyeDropper;
  return new Ctor();
}

const normal = (v: string) => {
  const c = parseHex(v.startsWith("#") ? v : `#${v}`);
  return c ? "#" + c.map((x) => x.toString(16).padStart(2, "0")).join("") : null;
};

/** A section heading in the builder's panel, with "Reset" for what it holds. */
export function SectionHead({ title, hint, onReset, canReset }: { title: string; hint?: ReactNode; onReset?: () => void; canReset?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h3 className="text-[15px] font-semibold text-text">{title}</h3>
        {hint && <p className="text-[12.5px] leading-[18px] text-text-muted">{hint}</p>}
      </div>
      {onReset && (
        <Button variant="ghost" size="sm" iconLeft="rotate" disabled={!canReset} onClick={onReset}>
          Reset
        </Button>
      )}
    </div>
  );
}

/** A labelled group inside a section. */
export function Group({ label, children, aside }: { label: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[12px] font-bold uppercase tracking-[0.08em] text-text-muted">{label}</span>
        {aside}
      </div>
      {children}
    </div>
  );
}

/**
 * One colour: a swatch (the system picker), the hex, the eyedropper where the browser has one,
 * and "Use theme default". Unset shows the colour the guide uses now, marked as the default.
 */
export function ColorField({ label, value, fallback, onChange, warning, disabled }: {
  label: string;
  value: string | null;
  fallback: string;
  onChange: (hex: string | null) => void;
  warning?: { ratio: number; onFix: () => void } | null;
  disabled?: boolean;
}) {
  const id = useId();
  const shown = value ?? fallback;
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = (v: string) => {
    const hex = normal(v.trim());
    if (hex) onChange(hex);
    else setText(shown);
  };
  const dropper = typeof window !== "undefined" && "EyeDropper" in window;
  return (
    <div className="flex items-center gap-2.5 py-1">
      <label className="relative size-8 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border-strong has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-border-focus" style={{ background: shown }} title={`Pick ${label.toLowerCase()}`}>
        <input
          type="color"
          aria-label={`${label}: pick a colour`}
          value={shown}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </label>
      <div className="flex min-w-0 flex-1 flex-col">
        <label htmlFor={id} className="truncate text-[13px] font-medium leading-[18px] text-text">{label}</label>
        {!value && !warning && <span className="text-[12px] leading-[14px] text-text-muted">Theme default</span>}
        {warning && (
          <span className="flex items-center gap-1 text-[12px] text-warning">
            <Icon name="alert" size={12} /> {warning.ratio.toFixed(1)}:1, below 4.5:1
            <button type="button" className="md-focus ml-1 rounded font-semibold text-accent-text underline" onClick={warning.onFix} disabled={disabled}>
              Fix
            </button>
          </span>
        )}
      </div>
      <input
        id={id}
        value={text}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
          if (e.key === "Escape") setText(shown);
        }}
        aria-label={`${label}, hex`}
        className="md-input h-8 w-[88px] shrink-0 px-2 font-mono text-[12.5px] uppercase"
      />
      {dropper && (
        <IconButton
          icon="pipette"
          label={`Pick ${label.toLowerCase()} from the screen`}
          size="sm"
          disabled={disabled}
          onClick={() => {
            const d = eyeDropper();
            void d?.open().then((r) => {
              const hex = normal(r.sRGBHex);
              if (hex) onChange(hex);
            }).catch(() => {});
          }}
        />
      )}
      <Tooltip content="Use the theme's colour">
        <IconButton icon="x" label={`${label}: use the theme's colour`} size="sm" disabled={disabled || !value} onClick={() => onChange(null)} className={cx(!value && "invisible")} />
      </Tooltip>
    </div>
  );
}

/** Radio cards with a small drawing of each choice. null = the theme's default (no card checked). */
export function OptionCards<V extends string>({ label, value, options, onChange, columns = 3, disabled }: {
  label: string;
  value: V | null;
  options: Array<{ value: V; label: string; draw?: ReactNode; hint?: string }>;
  onChange: (v: V | null) => void;
  columns?: 2 | 3 | 4 | 5;
  disabled?: boolean;
}) {
  const cols = { 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5" }[columns];
  return (
    <div role="radiogroup" aria-label={label} className={cx("grid gap-2", cols)}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.hint}
            disabled={disabled}
            onClick={() => onChange(on ? null : o.value)}
            className={cx(
              "md-focus flex min-w-0 flex-col items-stretch gap-1.5 rounded-lg bg-surface p-2 text-left text-[12px] font-medium text-text transition-colors",
              on ? "border-[1.5px] border-accent bg-accent-soft/40" : "border border-border hover:bg-surface-hover",
            )}
          >
            {o.draw && <span aria-hidden className="grid h-10 place-items-center rounded-md bg-bg">{o.draw}</span>}
            <span className="truncate text-center">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A slider with its value, a note when it is the theme's default, and "Use theme default". */
export function SliderField({ label, value, fallback, min, max, step, unit = "", format, onChange, disabled }: {
  label: string;
  value: number | null;
  fallback: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  format?: (n: number) => string;
  onChange: (v: number | null) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const shown = value ?? fallback;
  const show = format ?? ((n: number) => `${n}${unit}`);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="flex-1 text-[13px] font-medium text-text">{label}</label>
        {value === null ? <span className="text-[12px] text-text-muted">Theme default</span> : (
          <button type="button" className="md-focus rounded text-[12px] font-medium text-accent-text hover:underline" onClick={() => onChange(null)} disabled={disabled}>
            Use default
          </button>
        )}
        <output htmlFor={id} className="min-w-[52px] text-right font-mono text-[12.5px] text-text-secondary">{show(shown)}</output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--accent)]"
      />
    </div>
  );
}

/** Three-way switch for a yes/no choice with "theme default" (null). */
export function TriState({ label, value, onChange, yes = "Show", no = "Hide", disabled }: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
  yes?: string;
  no?: string;
  disabled?: boolean;
}) {
  const v = value === null ? "default" : value ? "yes" : "no";
  return (
    <div className="flex items-center gap-3">
      <span className="flex-1 text-[13px] font-medium text-text">{label}</span>
      <SegmentedControl
        aria-label={label}
        size="sm"
        disabled={disabled}
        value={v}
        onChange={(n) => onChange(n === "default" ? null : n === "yes")}
        options={[{ value: "default", label: "Default" }, { value: "yes", label: yes }, { value: "no", label: no }]}
      />
    </div>
  );
}

/** A choice from a short list as a segmented control, plus "Default" (null). */
export function Choice<V extends string>({ label, value, options, onChange, disabled, defaultLabel = "Default" }: {
  label: string;
  defaultLabel?: string;
  value: V | null;
  options: Array<{ value: V; label: string }>;
  onChange: (v: V | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="min-w-[96px] flex-1 text-[13px] font-medium text-text">{label}</span>
      <SegmentedControl<string>
        aria-label={label}
        size="sm"
        disabled={disabled}
        value={value ?? "__default"}
        onChange={(n) => onChange(n === "__default" ? null : (n as V))}
        options={[{ value: "__default", label: defaultLabel }, ...options]}
      />
    </div>
  );
}
