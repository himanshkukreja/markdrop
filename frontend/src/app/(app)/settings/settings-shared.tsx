"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { MarkdropLoader, Switch } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Settings pages need a session. While auth settles they show the loader; with no session they
 * replace the URL with /login?next=<this page> (the same redirect each page made before).
 */
export function useRequireUser(next: string) {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (loading || user) return;
    router.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [loading, user, router, next]);
  return { user, ready: !loading && !!user };
}

/** The centred page loader used while a settings page waits for auth or its first fetch. */
export function SettingsLoader({ label = "Loading your settings" }: { label?: string }) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center" aria-busy="true">
      <MarkdropLoader label={label} />
    </div>
  );
}

/** "Sep 13" this year, "Sep 13, 2025" otherwise. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** "in 5 days", "tomorrow", "today", "3 days ago". */
export function relativeDays(iso: string): string {
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days > 1) return `in ${days} days`;
  if (days === 1) return "tomorrow";
  if (days === 0) return "today";
  return `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A setting with its explanation on the left and a Switch on the right (44px+ row). The switch is
 * named by the label and described by the hint. `locked` keeps it focusable but inert
 * (aria-disabled) so a Tooltip can say why (non-admins).
 */
export function SwitchRow({
  id, label, hint, checked, onChange, disabled, locked,
}: {
  id: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  checked: boolean | undefined;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  /** aria-disabled instead of disabled: focusable, announced as unavailable, ignores clicks. */
  locked?: boolean;
}) {
  return (
    <div className="flex min-h-11 min-w-0 items-start justify-between gap-4">
      <div className="min-w-0">
        <p id={`${id}-label`} className="text-body-strong text-text">{label}</p>
        {hint && <p id={`${id}-hint`} className="mt-0.5 text-caption text-text-muted">{hint}</p>}
      </div>
      <Switch
        className={`mt-0.5 shrink-0 ${locked ? "md-switch--disabled" : ""}`}
        checked={!!checked}
        disabled={disabled || checked === undefined}
        aria-disabled={locked || undefined}
        aria-labelledby={`${id}-label`}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => {
          if (locked) return;
          onChange(e.target.checked);
        }}
        onClick={locked ? (e) => e.preventDefault() : undefined}
      />
    </div>
  );
}
