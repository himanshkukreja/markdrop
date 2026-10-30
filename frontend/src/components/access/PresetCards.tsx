"use client";

/**
 * The three-preset choice as cards (ShareItem, ShareFolder and Settings boards): native radios in
 * labelled cards inside a fieldset, so arrow keys move between them and screen readers hear one
 * group. The chosen card is outlined in the accent; a disabled one says why underneath. `locked`
 * is for people who may look but not change it: the radios stay focusable (aria-disabled, so a
 * wrapping "Admins only" tooltip is reachable by keyboard) and ignore clicks and arrow keys.
 */
import { useId } from "react";
import { Icon, cx } from "@/components/ui";

export interface PresetOption<V extends string = string> {
  value: V;
  label: string;
  hint?: string;
  icon?: string;
  disabled?: boolean;
  /** Shown instead of the hint when disabled ("Add it to a workspace first"). */
  disabledReason?: string;
}

export function PresetCards<V extends string = string>({
  legend, legendHidden, name, value, onChange, options, layout = "stack", disabled, locked, busy, className,
  "aria-describedby": describedBy,
}: {
  legend: string;
  legendHidden?: boolean;
  name: string;
  value: V | null;
  onChange: (v: V) => void;
  options: PresetOption<V>[];
  /** stack: one card per row (radio · icon · text). columns: side by side, text under the radio. */
  layout?: "stack" | "columns" | "auto";
  disabled?: boolean;
  /** Visible and focusable but not changeable (aria-disabled). */
  locked?: boolean;
  busy?: boolean;
  className?: string;
  "aria-describedby"?: string;
}) {
  const uid = useId();
  const lock = locked
    ? {
        "aria-disabled": true as const,
        onClick: (e: React.MouseEvent) => e.preventDefault(),
        onKeyDown: (e: React.KeyboardEvent) => { if (e.key.startsWith("Arrow") || e.key === " ") e.preventDefault(); },
      }
    : {};
  const pick = (v: V) => { if (!locked) onChange(v); };
  return (
    <fieldset className={cx("m-0 flex min-w-0 flex-col gap-2 border-0 p-0", className)} aria-busy={busy || undefined} aria-describedby={describedBy} disabled={disabled}>
      <legend className={cx("mb-2 p-0 text-[13px] leading-5 font-semibold text-text", legendHidden && "md-visually-hidden")}>{legend}</legend>
      <div
        className={cx(
          "grid min-w-0 gap-2",
          layout === "columns" && "grid-cols-1 sm:grid-cols-3",
          layout === "auto" && "grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2.5",
        )}
      >
        {options.map((o) => {
          const on = o.value === value;
          const off = disabled || o.disabled || locked;
          const hintId = `${uid}-${o.value}-hint`;
          const hint = o.disabled && o.disabledReason ? o.disabledReason : o.hint;
          return (
            <label
              key={o.value}
              className={cx(
                "relative flex min-w-0 rounded-lg border transition-colors duration-(--duration-fast) has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-(--border-focus)",
                layout === "stack" ? "items-start gap-3 px-3.5 py-3" : "flex-col gap-1.5 p-3",
                on ? "border-accent bg-accent-soft" : "border-border bg-surface",
                off ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-border-strong",
              )}
            >
              {layout === "stack" ? (
                <>
                  <input
                    type="radio"
                    name={name}
                    value={o.value}
                    checked={on}
                    disabled={(disabled || o.disabled) && !locked}
                    onChange={() => pick(o.value)}
                    {...lock}
                    aria-describedby={hint ? hintId : undefined}
                    className="mt-[3px] shrink-0 accent-(--accent)"
                  />
                  {o.icon && <span aria-hidden className="mt-px flex shrink-0 text-text-secondary"><Icon name={o.icon} size={18} /></span>}
                  <span className="flex min-w-0 flex-col">
                    <strong className="text-body-strong text-text">{o.label}</strong>
                    {hint && <span id={hintId} className="text-caption text-text-muted">{hint}</span>}
                  </span>
                </>
              ) : (
                <>
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={name}
                      value={o.value}
                      checked={on}
                      disabled={(disabled || o.disabled) && !locked}
                      onChange={() => pick(o.value)}
                      {...lock}
                      aria-describedby={hint ? hintId : undefined}
                      className="m-0 shrink-0 accent-(--accent)"
                    />
                    {o.icon ? (
                      <span aria-hidden className="flex text-text-secondary"><Icon name={o.icon} size={18} /></span>
                    ) : (
                      <strong className="text-body-strong text-text">{o.label}</strong>
                    )}
                  </span>
                  {o.icon && <strong className="text-[13px] leading-5 font-semibold text-text">{o.label}</strong>}
                  {hint && <span id={hintId} className="text-caption text-text-muted">{hint}</span>}
                </>
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export default PresetCards;
