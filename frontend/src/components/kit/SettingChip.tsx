"use client";
/**
 * SettingChip (REVAMP_PLAN 7.3, 8.2): one publish setting stated as its value ("Never expires",
 * "Encrypted"), opening a panel. A real button, so DS Popover can clone it as its trigger
 * (aria-haspopup="dialog", aria-expanded, click-to-toggle). Its accessible name is
 * "<label>: <value>", which contains the visible text (WCAG 2.5.3).
 *
 * - `set`: a non-default value; shows the accent dot (pops in once, 150ms).
 * - `static`: a fact, not a control (signed-out access). Renders a non-interactive chip without a
 *   chevron; wrap it in a focusable Tooltip to explain why.
 * - `emphasis`: accent text, for "Encrypted" (the setting the product is sold on).
 * - `invalid`: the panel behind it has an error; danger outline + alert icon, and the name says so.
 */
import React from "react";
import { Icon } from "@/components/ui";
import s from "./publish.module.css";

export interface SettingChipProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "value"> {
  /** What the setting is ("Who can open it"); prefixes the accessible name. */
  label: string;
  /** What it's set to, shown on the chip. */
  value: React.ReactNode;
  /** Plain-text value for the accessible name when `value` isn't a string. */
  valueText?: string;
  icon: string;
  set?: boolean;
  static?: boolean;
  emphasis?: boolean;
  invalid?: boolean;
  /** Render the value in the mono face (slugs). */
  mono?: boolean;
}

export const SettingChip = React.forwardRef<HTMLButtonElement, SettingChipProps>(function SettingChip(
  { label, value, valueText, icon, set, static: isStatic, emphasis, invalid, mono, className, ...rest }, ref) {
  const text = valueText ?? (typeof value === "string" ? value : "");
  const name = `${label}: ${text}${invalid ? ", needs attention" : ""}`;
  const cls = [s.chip, set && s.chipSet, emphasis && s.chipEmphasis, invalid && s.chipInvalid, isStatic && s.chipStatic, className].filter(Boolean).join(" ");
  const inner = (
    <>
      <Icon name={invalid ? "alertCircle" : icon} className={s.chipIcon} />
      <span className={mono ? `${s.chipValue} ${s.chipMono}` : s.chipValue}>{value}</span>
      {set && !isStatic && <span className={s.chipDot} aria-hidden />}
      {!isStatic && <Icon name="chevronDown" className={s.chipChevron} />}
    </>
  );
  if (isStatic) {
    return <span className={cls} aria-label={name} role="img">{inner}</span>;
  }
  return (
    <button ref={ref} type="button" className={cls} aria-label={name} {...rest}>
      {inner}
    </button>
  );
});
