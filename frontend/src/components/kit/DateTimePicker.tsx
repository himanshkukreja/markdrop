"use client";
/**
 * DateTimePicker (REVAMP_PLAN 8.2): quick presets, a month grid and a native time input.
 *
 * - The grid follows the WAI-ARIA date-picker dialog pattern, inline: role="grid", one tab stop
 *   (roving tabindex), Arrow keys ±1 day / ±1 week, Home/End start/end of the week, PageUp/PageDown
 *   ±1 month (Shift: ±1 year), Enter/Space picks. Days before `min` or after `max` are
 *   aria-disabled (focusable, not pickable). Today has aria-current="date".
 * - The time is a native `<input type="time">` (it follows `color-scheme`, which the theme sets).
 * - Every date is formatted in the reader's zone, so nothing date-shaped renders on the server:
 *   until hydration the picker is a same-height placeholder.
 * - `value` is an ISO string (UTC instant); the picker edits it in local time.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { IconButton, Input } from "@/components/ui";
import { defaultExpiryMoment, useIsClient } from "./publish-utils";
import s from "./publish.module.css";

export interface DateTimePreset { label: string; days: number; }

export interface DateTimePickerProps {
  /** ISO 8601 instant, or null for "nothing picked yet" (the grid then opens on `min`'s month). */
  value: string | null;
  onChange: (iso: string) => void;
  /** Earliest pickable moment. Default: now. Days before it are disabled. */
  min?: Date;
  /** Latest pickable moment. Optional. */
  max?: Date;
  /** Quick picks that keep the chosen time of day. Pass [] to hide them. */
  presets?: DateTimePreset[];
  /** Names the group (default "Expiry date and time"). */
  label?: string;
  /** Shown under the controls; turns danger with `error`. */
  hint?: React.ReactNode;
  error?: boolean;
  disabled?: boolean;
  className?: string;
  /** 0 = Sunday (default), 1 = Monday. */
  weekStartsOn?: 0 | 1;
}

const DEFAULT_PRESETS: DateTimePreset[] = [
  { label: "Tomorrow", days: 1 },
  { label: "In 3 days", days: 3 },
  { label: "In 2 weeks", days: 14 },
  { label: "In 3 months", days: 90 },
];

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** Same day-of-month in another month, clamped (Jan 31 + 1 month = Feb 28/29). */
function addMonths(d: Date, n: number) {
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), last));
}
const pad = (n: number) => String(n).padStart(2, "0");
const toTimeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function DateTimePicker({ value, onChange, min, max, presets = DEFAULT_PRESETS, label = "Expiry date and time", hint, error, disabled, className, weekStartsOn = 0 }: DateTimePickerProps) {
  const isClient = useIsClient();
  const uid = useId();
  const gridRef = useRef<HTMLTableElement>(null);
  const focusAfterRender = useRef(false);

  // `min` defaults to "now", but only on the client (server time is meaningless here).
  const minDate = useMemo(() => (isClient ? min ?? new Date() : null), [isClient, min]);
  const selected = useMemo(() => {
    if (!value) return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }, [value]);

  const [focusDay, setFocusDay] = useState<Date | null>(null);
  // The day the grid is about: the focused day, else the selection, else the first pickable day.
  const anchor = focusDay ?? (selected ? startOfDay(selected) : minDate ? startOfDay(minDate) : null);
  useEffect(() => {
    if (!focusAfterRender.current) return;
    focusAfterRender.current = false;
    gridRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  });

  if (!isClient || !anchor || !minDate) {
    return <div className={[s.dtp, s.dtpPlaceholder, className].filter(Boolean).join(" ")} aria-hidden />;
  }

  const timeOf = selected ?? defaultExpiryMoment();
  const dayDisabled = (d: Date) => startOfDay(d) < startOfDay(minDate) || (!!max && startOfDay(d) > startOfDay(max));
  /** Combine a day with the chosen time; if that lands before `min` on the min day, use min's next minute. */
  const commit = (day: Date, time: Date = timeOf) => {
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.getHours(), time.getMinutes(), 0, 0);
    if (next <= minDate) next.setTime(Math.ceil((minDate.getTime() + 60_000) / 60_000) * 60_000);
    onChange(next.toISOString());
  };

  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const lead = (monthStart.getDay() - weekStartsOn + 7) % 7;
  const gridStart = addDays(monthStart, -lead);
  const weeks: Date[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: Date[] = [];
    for (let i = 0; i < 7; i++) row.push(addDays(gridStart, w * 7 + i));
    if (w > 0 && row[0]!.getMonth() !== anchor.getMonth()) break;
    weeks.push(row);
  }
  const weekdayNames = Array.from({ length: 7 }, (_, i) => addDays(gridStart, i));
  const today = new Date();
  const monthLabel = anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const prevDisabled = new Date(anchor.getFullYear(), anchor.getMonth(), 0) < startOfDay(minDate);
  const nextDisabled = !!max && new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1) > max;

  const moveFocus = (d: Date) => { focusAfterRender.current = true; setFocusDay(d); };
  const onGridKey = (e: React.KeyboardEvent, d: Date) => {
    let next: Date | null = null;
    switch (e.key) {
      case "ArrowLeft": next = addDays(d, -1); break;
      case "ArrowRight": next = addDays(d, 1); break;
      case "ArrowUp": next = addDays(d, -7); break;
      case "ArrowDown": next = addDays(d, 7); break;
      case "Home": next = addDays(d, -((d.getDay() - weekStartsOn + 7) % 7)); break;
      case "End": next = addDays(d, 6 - ((d.getDay() - weekStartsOn + 7) % 7)); break;
      case "PageUp": next = addMonths(d, e.shiftKey ? -12 : -1); break;
      case "PageDown": next = addMonths(d, e.shiftKey ? 12 : 1); break;
      case "Enter": case " ":
        e.preventDefault();
        if (!dayDisabled(d)) commit(d);
        return;
      default: return;
    }
    e.preventDefault();
    if (next) moveFocus(next);
  };

  const hintId = `${uid}-hint`;
  return (
    <div role="group" aria-label={label} aria-describedby={hint ? hintId : undefined} className={[s.dtp, className].filter(Boolean).join(" ")}>
      {presets.length > 0 && (
        <div className={s.dtpPresets} role="group" aria-label="Quick picks">
          {presets.map((p) => {
            const d = addDays(startOfDay(new Date()), p.days);
            const on = !!selected && sameDay(selected, d);
            return (
              <button key={p.label} type="button" className={s.dtpPreset} aria-pressed={on} disabled={disabled || dayDisabled(d)}
                onClick={() => { setFocusDay(d); commit(d); }}>
                {p.label}
              </button>
            );
          })}
        </div>
      )}
      <div className={s.dtpCal}>
        <div className={s.dtpHead}>
          <IconButton icon="chevronLeft" label="Previous month" size="sm" disabled={disabled || prevDisabled} onClick={() => setFocusDay(addMonths(anchor, -1))} />
          <div id={`${uid}-month`} className={s.dtpMonth} aria-live="polite">{monthLabel}</div>
          <IconButton icon="chevronRight" label="Next month" size="sm" disabled={disabled || nextDisabled} onClick={() => setFocusDay(addMonths(anchor, 1))} />
        </div>
        <table ref={gridRef} role="grid" aria-labelledby={`${uid}-month`} className={s.dtpGrid}>
          <thead>
            <tr>
              {weekdayNames.map((d) => (
                <th key={d.getDay()} scope="col" abbr={d.toLocaleDateString(undefined, { weekday: "long" })}>
                  {d.toLocaleDateString(undefined, { weekday: "narrow" })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((row, w) => (
              <tr key={w}>
                {row.map((d) => {
                  const off = dayDisabled(d);
                  const isSel = !!selected && sameDay(d, selected);
                  const outside = d.getMonth() !== anchor.getMonth();
                  return (
                    <td key={d.getTime()} role="gridcell" aria-selected={isSel}>
                      <button type="button" tabIndex={sameDay(d, anchor) ? 0 : -1}
                        className={[s.dtpDay, isSel && s.dtpDaySel, outside && s.dtpDayOut, sameDay(d, today) && s.dtpDayToday].filter(Boolean).join(" ")}
                        aria-disabled={off || disabled || undefined}
                        aria-current={sameDay(d, today) ? "date" : undefined}
                        aria-label={d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                        onClick={() => { setFocusDay(d); if (!off && !disabled) commit(d); }}
                        onKeyDown={(e) => onGridKey(e, d)}>
                        {d.getDate()}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={s.dtpTimeRow}>
        <label htmlFor={`${uid}-time`} className={s.dtpTimeLabel}>Time</label>
        <Input id={`${uid}-time`} type="time" step={60} size="sm" className={s.dtpTime} disabled={disabled}
          value={toTimeValue(timeOf)}
          onChange={(e) => {
            const m = /^(\d{1,2}):(\d{2})/.exec(e.target.value);
            if (!m) return;
            const t = new Date(timeOf); t.setHours(+m[1]!, +m[2]!, 0, 0);
            commit(selected ? startOfDay(selected) : anchor, t);
          }} />
        <span className={s.dtpZone}>{Intl.DateTimeFormat().resolvedOptions().timeZone?.replace(/_/g, " ")}</span>
      </div>
      {hint && <div id={hintId} className={error ? s.hintError : s.hint} role={error ? "alert" : undefined}>{hint}</div>}
    </div>
  );
}
