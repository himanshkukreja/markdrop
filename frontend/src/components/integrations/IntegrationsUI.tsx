"use client";

import { useRef, useState } from "react";
import { Anchor, Badge, Button, Icon, Skeleton, useToast } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { BrandMark } from "./BrandMark";
import type { IntegrationStatus } from "./useIntegrationStatus";
import { GROUP_ORDER, type IntegrationInfo } from "@/lib/integrations";

/**
 * The Integrations grid and detail page (owner, 2026-11-11: "every integration as a card with basic info,
 * keep a grid; clicking Details opens that integration's own page with all the details and steps").
 *
 *   <IntegrationGrid>     one grid of cards in group order: mark, group, name, status, one line, one action + Details
 *   <IntegrationDetail>   back link, header, What it does, Set up (numbered), Settings (the existing component), Troubleshooting, docs
 */

export function StatusChip({ status }: { status: IntegrationStatus | undefined }) {
  if (!status) return <Skeleton width={84} height={20} />;
  switch (status.kind) {
    case "connected": return <Badge tone="success" size="sm" dot data-status="connected">{status.label ?? "Connected"}</Badge>;
    case "attention": return <Badge tone="warning" size="sm" icon="alert" data-status="attention">{status.label ?? "Needs attention"}</Badge>;
    case "admin": return <Badge size="sm" icon="lock" data-status="admin">{status.label ?? "Admin only"}</Badge>;
    case "unavailable": return <Badge size="sm" data-status="unavailable">{status.label ?? "Not available"}</Badge>;
    case "info": return <Badge size="sm" data-status="info">{status.label}</Badge>;
    default: return <Badge size="sm" data-status="off">{status.label ?? "Not connected"}</Badge>;
  }
}

/** The card's one action: Manage when it's on, otherwise Connect (one-click) or Set up (steps). */
export interface CardAction { label: string; href?: string; onClick?: () => Promise<void> | void; icon?: string }

export function IntegrationCard({ info, status, href, action }: {
  info: IntegrationInfo;
  status: IntegrationStatus | undefined;
  href: string;
  action: CardAction | null;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const titleId = `int-${info.scope}-${info.id}`;
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4" data-testid={`integration-card-${info.id}`} aria-labelledby={titleId}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <BrandMark brand={info.brand} icon={info.icon} />
        <StatusChip status={status} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="m-0 text-eyebrow uppercase text-text-muted">{info.group}</p>
        <h3 id={titleId} className="m-0 mt-0.5 text-body-strong text-text">{info.name}</h3>
        <p className="m-0 mt-1 text-[13px] leading-5 text-text-secondary">{info.blurb}</p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {action && (action.href ? (
          <Button size="sm" variant={action.label === "Manage" ? "secondary" : "primary"} href={action.href} iconLeft={action.icon}
            aria-label={`${action.label} ${info.name}`} data-testid={`integration-action-${info.id}`}>{action.label}</Button>
        ) : (
          <Button size="sm" iconLeft={action.icon} loading={busy} aria-label={`${action.label} ${info.name}`} data-testid={`integration-action-${info.id}`}
            onClick={async () => {
              setBusy(true);
              try { await action.onClick?.(); } catch (e) {
                toast.error(e instanceof Error ? e.message : "That didn't work. Try again.");
                setBusy(false);
              }
            }}>{action.label}</Button>
        ))}
        <Button size="sm" variant="ghost" href={href} iconRight="arrowRight" aria-label={`${info.name} details`} data-testid={`integration-details-${info.id}`}>Details</Button>
      </div>
    </li>
  );
}

export function IntegrationGrid({ items, statuses, hrefOf, actionOf }: {
  items: IntegrationInfo[];
  statuses: Record<string, IntegrationStatus | undefined>;
  hrefOf: (i: IntegrationInfo) => string;
  actionOf: (i: IntegrationInfo, s: IntegrationStatus | undefined) => CardAction | null;
}) {
  // One dense grid, in group order; each card names its group (a header per group left half-empty rows).
  const ordered = GROUP_ORDER.flatMap((g) => items.filter((i) => i.group === g));
  return (
    <ul className="m-0 grid min-w-0 list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" data-testid="integrations-grid" aria-label="Integrations">
      {ordered.map((i) => (
        <IntegrationCard key={i.id} info={i} status={statuses[i.id]} href={hrefOf(i)} action={actionOf(i, statuses[i.id])} />
      ))}
    </ul>
  );
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, "-");

export function IntegrationDetail({ info, status, backHref, backLabel, actions, onSettingsTouched, children }: {
  info: IntegrationInfo;
  status: IntegrationStatus | undefined;
  backHref: string;
  backLabel: React.ReactNode;
  /** Connect / Disconnect, where the settings below don't already have them. */
  actions?: React.ReactNode;
  /** Something in Settings was used: the header's status is refreshed shortly after. */
  onSettingsTouched?: () => void;
  children?: React.ReactNode;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touched = () => {
    if (!onSettingsTouched) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(onSettingsTouched, 2000);
  };
  return (
    <div className="flex min-w-0 max-w-[820px] flex-col gap-6" data-testid={`integration-detail-${info.id}`}>
      <Anchor href={backHref} className="md-focus md-hit inline-flex min-w-0 max-w-full items-center gap-1.5 self-start rounded-sm text-[13px] font-medium text-accent-text no-underline hover:underline" data-testid="integration-back">
        <Icon name="chevronLeft" size={14} className="shrink-0" /><span className="min-w-0 truncate">{backLabel}</span>
      </Anchor>

      <header className="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-3">
        <BrandMark brand={info.brand} icon={info.icon} size={52} />
        <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="m-0 text-h1 text-text [overflow-wrap:anywhere]">{info.name}</h1>
            <span data-testid="integration-status"><StatusChip status={status} /></span>
          </div>
          <p className="m-0 text-body text-text-secondary">{info.blurb}</p>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </header>

      <Section title="What it does">
        <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-[14px] leading-6 text-text-secondary marker:text-text-muted">
          {info.what.map((w) => <li key={w}>{w}</li>)}
        </ul>
      </Section>

      <Section title="Set up" id="setup">
        <ol className="m-0 flex list-none flex-col gap-3 p-0" data-testid="integration-steps">
          {info.steps.map((s, n) => (
            <li key={s.title} className="flex min-w-0 gap-3">
              <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-inset text-[12px] font-semibold text-text-secondary">{n + 1}</span>
              <div className="min-w-0 pt-0.5">
                <p className="m-0 text-[14px] font-medium text-text">{s.title}</p>
                {s.body && <p className="m-0 mt-0.5 text-[13px] leading-5 text-text-secondary [overflow-wrap:anywhere]">{s.body}</p>}
              </div>
            </li>
          ))}
        </ol>
      </Section>

      {children && (
        <Section title="Settings" id="settings">
          <div className="min-w-0" onClickCapture={touched} onSubmitCapture={touched} onChangeCapture={touched}>{children}</div>
        </Section>
      )}

      {info.troubleshooting.length > 0 && (
        <Section title="Troubleshooting">
          <div className="flex min-w-0 flex-col divide-y divide-border rounded-xl border border-border bg-surface">
            {info.troubleshooting.map((t) => (
              <details key={t.q} className="group min-w-0 px-4 py-3">
                <summary className="md-focus flex cursor-pointer list-none items-center justify-between gap-3 rounded-sm text-[14px] font-medium text-text [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0">{t.q}</span>
                  <Icon name="chevronDown" size={16} className="shrink-0 text-text-muted transition-transform group-open:rotate-180" />
                </summary>
                <p className="m-0 mt-2 text-[13px] leading-5 text-text-secondary">{t.a}</p>
              </details>
            ))}
          </div>
        </Section>
      )}

      <p className="m-0 text-[13px] text-text-secondary">
        Everything about {info.name} in Markdrop, step by step: <ReadMore topic={info.docs}>Read the guide</ReadMore>
      </p>
    </div>
  );
}

function Section({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  const hid = `int-sec-${slug(title)}`;
  return (
    <section id={id} aria-labelledby={hid} className="flex min-w-0 scroll-mt-20 flex-col gap-3">
      <h2 id={hid} className="m-0 text-h3 text-text">{title}</h2>
      {children}
    </section>
  );
}
