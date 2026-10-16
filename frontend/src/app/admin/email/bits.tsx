"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Button, Tooltip, cx, type Tone } from "@/components/ui";
import type { AudienceSpec, CampaignStatus, DisplayStatus, SenderCheck } from "./api";

/** Small pieces the email screens share: status badges, a section card, percent and time helpers. */

// ── Badges ────────────────────────────────────────────────────────────────────

const CAMPAIGN: Record<CampaignStatus, { tone: Tone; label: string; icon?: string; live?: boolean }> = {
  draft: { tone: "neutral", label: "Draft", icon: "edit" },
  scheduled: { tone: "info", label: "Scheduled", icon: "calendar" },
  sending: { tone: "info", label: "Sending", live: true },
  paused: { tone: "warning", label: "Paused", icon: "pause" },
  sent: { tone: "success", label: "Sent", icon: "check" },
  cancelled: { tone: "danger", label: "Cancelled", icon: "x" },
};

export function CampaignBadge({ status, legacy }: { status: CampaignStatus; legacy?: boolean }) {
  const s = CAMPAIGN[status] ?? { tone: "neutral" as Tone, label: status };
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge size="sm" tone={s.tone} icon={s.icon} live={s.live} className="whitespace-nowrap">{s.label}</Badge>
      {legacy && <Badge size="sm" tone="neutral" variant="outline">Legacy</Badge>}
    </span>
  );
}

const MSG: Record<DisplayStatus, { tone: Tone; label: string }> = {
  queued: { tone: "neutral", label: "Queued" },
  sending: { tone: "info", label: "Sending" },
  sent: { tone: "neutral", label: "Sent" },
  delivered: { tone: "neutral", label: "Delivered" },
  failed: { tone: "danger", label: "Failed" },
  skipped: { tone: "neutral", label: "Skipped" },
  opened: { tone: "info", label: "Opened" },
  clicked: { tone: "success", label: "Clicked" },
  bounced: { tone: "danger", label: "Bounced" },
  complained: { tone: "danger", label: "Complaint" },
};

export function MessageBadge({ status }: { status: DisplayStatus }) {
  const s = MSG[status] ?? { tone: "neutral" as Tone, label: status };
  return <Badge size="sm" tone={s.tone} variant={status === "skipped" ? "outline" : "soft"} className="whitespace-nowrap">{s.label}</Badge>;
}

export function CheckBadge({ check }: { check: SenderCheck }) {
  const map = {
    ok: { tone: "success" as Tone, icon: "checkCircle", label: "Verified" },
    warn: { tone: "warning" as Tone, icon: "alert", label: "Unverified" },
    bad: { tone: "danger" as Tone, icon: "alertCircle", label: "Can't send" },
  }[check.level];
  return <Badge size="sm" tone={map.tone} icon={map.icon} title={check.message} className="whitespace-nowrap">{map.label}</Badge>;
}

// ── Layout ────────────────────────────────────────────────────────────────────

/** A card with an eyebrow label, an h2 title and optional actions; the section's building block. */
export function Section({
  label, title, actions, children, className, id, bodyClassName,
}: {
  label?: React.ReactNode; title: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode;
  className?: string; id?: string; bodyClassName?: string;
}) {
  return (
    <section aria-labelledby={id} className={cx("min-w-0 rounded-xl border border-border bg-surface", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-4 pt-4 sm:px-5">
        <div className="min-w-0">
          {label && <p className="text-eyebrow uppercase text-text-muted">{label}</p>}
          <h2 id={id} className="mt-0.5 break-words text-h4 text-text">{title}</h2>
        </div>
        {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className={cx("min-w-0 px-4 pb-4 pt-3 sm:px-5 sm:pb-5", bodyClassName)}>{children}</div>
    </section>
  );
}

/** A definition list row set (label · value), wrapping on phones. */
export function Facts({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-body sm:grid-cols-[max-content_minmax(0,1fr)]">
      {items.map((it) => (
        <div key={it.label} className="contents">
          <dt className="text-caption text-text-muted sm:pt-0.5">{it.label}</dt>
          <dd className="mb-1 min-w-0 break-words text-text sm:mb-0">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Numbers and time ──────────────────────────────────────────────────────────

export function pct(n: number, d: number): string {
  if (!d) return "—";
  const v = (n / d) * 100;
  return `${v >= 99.95 || v === 0 ? v.toFixed(0) : v.toFixed(1)}%`;
}

export const num = (n: number) => n.toLocaleString("en");

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function exact(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}

/** A relative time that ticks every minute, with the exact time as its tooltip and datetime. */
export function TimeAgo({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  if (!iso) return <span className={className}>—</span>;
  return <time dateTime={iso} title={exact(iso)} className={cx("whitespace-nowrap", className)}>{timeAgo(iso, now)}</time>;
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    if (ms <= 0) { setV(value); return; }
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Interval that only runs while `active`, calling the latest `fn`. */
export function usePoll(fn: () => void, ms: number, active: boolean) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms, active]);
}

// ── Audience copy ─────────────────────────────────────────────────────────────

export const AUDIENCES: { kind: AudienceSpec["kind"]; label: string; hint: string }[] = [
  { kind: "all", label: "All accounts", hint: "Everyone who signed up" },
  { kind: "recent", label: "Recent sign-ups", hint: "Joined in the last N days" },
  { kind: "active", label: "Active recently", hint: "Signed in or published in the last N days" },
  { kind: "with_documents", label: "Has documents", hint: "Published at least N markdown documents" },
  { kind: "with_artifacts", label: "Uses files", hint: "Uploaded at least N artifacts (HTML, PDF, sheets…)" },
  { kind: "never_published", label: "Never published", hint: "Signed up, nothing published yet" },
  { kind: "vscode", label: "VS Code users", hint: "Have a VS Code extension token" },
  { kind: "workspace", label: "Workspace members", hint: "Owners and members of any workspace" },
  { kind: "custom", label: "Custom list", hint: "Paste addresses, with or without accounts" },
];

export function audienceLabel(a: AudienceSpec & { kind: string }): string {
  const base = AUDIENCES.find((x) => x.kind === a.kind)?.label ?? ({
    with_documents: "Has documents", recent: "Recent sign-ups",
  } as Record<string, string>)[a.kind] ?? a.kind;
  if (a.kind === "recent" || a.kind === "active") return `${base} · ${a.days ?? 30} d`;
  if ((a.kind === "with_documents" || a.kind === "with_artifacts") && (a.min ?? 1) > 1) return `${base} · ≥ ${a.min}`;
  return base;
}

// ── Download helper ───────────────────────────────────────────────────────────

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** A button that explains why it's unavailable instead of silently doing nothing. */
export function GuardedButton({ reason, ...props }: React.ComponentProps<typeof Button> & { reason?: string | null }) {
  if (!reason) return <Button {...props} />;
  return (
    <Tooltip content={reason}>
      <Button {...props} aria-disabled onClick={(e) => e.preventDefault()} />
    </Tooltip>
  );
}
