"use client";

/**
 * Where a custom domain is on its way to live (P5): Added → DNS records → Verified → Live. One
 * glance answers "what's left to do"; the current step is marked for assistive tech with
 * aria-current="step". A lapsed domain (verified once, then failing checks) shows the failure on
 * the step that broke.
 */
import { Icon, cx } from "@/components/ui";
import type { Domain } from "@/lib/workspaces";

type StepState = "done" | "current" | "todo" | "error";

export function domainSteps(d: Domain): Array<{ key: string; label: string; detail: string; state: StepState }> {
  const verified = d.status === "verified";
  const lapsed = d.status === "lapsed";
  const failed = d.status === "failed";
  const recordsOk = verified || (d.txt_ok === true && d.routing_ok === true);
  const live = d.live ?? (verified && d.attached);
  const serving = d.kind === "cdn" ? "Serving files" : "Live";
  return [
    { key: "added", label: "Added", detail: d.host, state: "done" },
    {
      key: "dns",
      label: "DNS records",
      detail: lapsed ? "Stopped resolving" : recordsOk ? "Both found" : d.txt_ok ? "Routing record missing" : d.routing_ok ? "Ownership record missing" : "Add two records",
      state: lapsed ? "error" : recordsOk ? "done" : failed ? "error" : "current",
    },
    {
      key: "verified",
      label: "Verified",
      detail: verified ? "Ownership proven" : lapsed ? "Lapsed" : "After the records are found",
      state: verified ? "done" : lapsed ? "error" : recordsOk ? "current" : "todo",
    },
    {
      key: "live",
      label: serving,
      detail: live ? (d.kind === "cdn" ? "Raw files" : "Readers can open it") : lapsed ? "Not serving" : verified ? "Going live…" : "Last step",
      state: live ? "done" : verified ? "current" : "todo",
    },
  ];
}

export function DomainStepper({ domain, className }: { domain: Domain; className?: string }) {
  const steps = domainSteps(domain);
  return (
    <ol className={cx("m-0 grid min-w-0 list-none grid-cols-2 gap-x-3 gap-y-3 p-0 sm:grid-cols-4", className)} aria-label={`Setup of ${domain.host}`}>
      {steps.map((s, i) => (
        <li key={s.key} className="relative flex min-w-0 items-start gap-2" aria-current={s.state === "current" ? "step" : undefined}>
          <span
            aria-hidden
            className={cx(
              "grid size-6 shrink-0 place-items-center rounded-full border text-micro font-semibold",
              s.state === "done" && "border-success bg-success-soft text-success",
              s.state === "current" && "border-accent bg-accent-soft text-accent-text",
              s.state === "todo" && "border-border bg-surface text-text-muted",
              s.state === "error" && "border-danger bg-danger-soft text-danger",
            )}
          >
            {s.state === "done" ? <Icon name="check" size={13} /> : s.state === "error" ? <Icon name="alert" size={12} /> : i + 1}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className={cx("text-body-strong", s.state === "todo" ? "text-text-muted" : "text-text")}>
              {s.label}
              <span className="md-visually-hidden">
                {s.state === "done" ? ": done" : s.state === "current" ? ": in progress" : s.state === "error" ? ": needs attention" : ": not yet"}
              </span>
            </span>
            <span className={cx("truncate text-caption", s.state === "error" ? "text-danger" : "text-text-muted")}>{s.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export default DomainStepper;
