"use client";

import { useCallback, useState } from "react";
import { Button, Field, Input, Popover, RadioGroup } from "@/components/ui";
import { useOnUnauthorized } from "../shared";

const API = process.env.NEXT_PUBLIC_API_URL || "https://api.markdrop.in";

/** Presets the backend accepts (admin_analytics.RANGES). It has no "all time" range. */
export const RANGES: { key: string; label: string; vs: string }[] = [
  { key: "24h", label: "Last 24 hours", vs: "24 hours" },
  { key: "7d", label: "Last 7 days", vs: "7 days" },
  { key: "30d", label: "Last 30 days", vs: "30 days" },
  { key: "90d", label: "Last 90 days", vs: "90 days" },
  { key: "12m", label: "Last 12 months", vs: "12 months" },
];

export interface RangeValue { key: string; custom: { start: string; end: string } | null }

/** URL form: "30d" or "2026-09-01..2026-10-01". */
export function parseRange(v: string | null): RangeValue {
  if (v && /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [start, end] = v.split("..");
    if (start <= end) return { key: "custom", custom: { start, end } };
  }
  return { key: RANGES.some((r) => r.key === v) ? (v as string) : "30d", custom: null };
}
export const serializeRange = (r: RangeValue) => (r.custom ? `${r.custom.start}..${r.custom.end}` : r.key);
export const rangeLabel = (r: RangeValue) => (r.custom ? `${r.custom.start} to ${r.custom.end}` : RANGES.find((x) => x.key === r.key)?.label ?? "Last 30 days");
export const rangeVs = (r: RangeValue) => (r.custom ? "period of the same length" : RANGES.find((x) => x.key === r.key)?.vs ?? "period");

export function rangeParams(r: RangeValue, tz: string): Record<string, string | undefined> {
  return { range: r.custom ? "custom" : r.key, start: r.custom?.start, end: r.custom?.end, tz };
}

/** GET /api/v1/admin/analytics/<path>. A 401 signs the admin out. */
export function useAdminFetch(token: string) {
  const onUnauthorized = useOnUnauthorized();
  return useCallback(async <T,>(path: string, params: Record<string, string | undefined>): Promise<T> => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]);
    const res = await fetch(`${API}/api/v1/admin/analytics/${path}?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) { onUnauthorized(); throw new Error("UNAUTHORIZED"); }
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }, [token, onUnauthorized]);
}

/** The range control: presets plus a custom range from two native date inputs (DateRangePicker is v2). */
export function RangePicker({ value, onChange, className }: { value: RangeValue; onChange: (r: RangeValue) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(value.custom?.start ?? "");
  const [end, setEnd] = useState(value.custom?.end ?? "");
  const bad = !!start && !!end && start > end;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      title="Date range"
      width={288}
      trap
      className={className}
      trigger={<Button variant="secondary" iconLeft="calendar" iconRight="chevronDown" className="min-h-11 sm:min-h-9">{rangeLabel(value)}</Button>}
    >
      {({ close }) => (
        <div className="flex flex-col gap-4">
          <RadioGroup
            name="admin-range"
            aria-label="Preset ranges"
            value={value.custom ? "" : value.key}
            onChange={(k) => { onChange({ key: k, custom: null }); close(); }}
            options={RANGES.map((r) => ({ value: r.key, label: r.label }))}
          />
          <form
            className="flex flex-col gap-2 border-t border-border pt-3"
            onSubmit={(e) => { e.preventDefault(); if (!start || !end || bad) return; onChange({ key: "custom", custom: { start, end } }); close(); }}
          >
            <p className="text-caption font-medium text-text-secondary">Custom range</p>
            <div className="grid grid-cols-2 gap-2">
              <Field label="From"><Input type="date" size="sm" value={start} max={end || undefined} onChange={(e) => setStart(e.target.value)} /></Field>
              <Field label="To"><Input type="date" size="sm" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} /></Field>
            </div>
            {bad && <p className="text-caption text-danger" role="alert">The start date is after the end date.</p>}
            <Button type="submit" size="sm" variant="secondary" aria-disabled={!start || !end || bad || undefined}>Apply custom range</Button>
          </form>
        </div>
      )}
    </Popover>
  );
}
