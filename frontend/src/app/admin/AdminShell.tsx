"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Drawer, Icon, IconButton, MarkdropLogo, SkipLink, cx } from "@/components/ui";
import type { Section } from "./shared";

/**
 * AdminShell (REVAMP_PLAN 7.18): a 232px sticky rail on `surface` with a right hairline, the logo
 * and an "Admin" badge, and four groups. No theme control: the admin is a permanent dark island
 * (D3). Below 1024px the rail becomes a left Drawer opened from a top bar.
 *
 * Items are real links (`/admin?tab=…`, so they open in a new tab) that switch in place on a plain
 * click.
 */

const GROUPS: { label: string; items: { id: Section; label: string; icon: string }[] }[] = [
  { label: "Insights", items: [
    { id: "overview", label: "Overview", icon: "chart" },
    { id: "live", label: "Live", icon: "wave" },
    { id: "health", label: "Product health", icon: "zap" },
    { id: "journeys", label: "Journeys", icon: "history" },
  ] },
  { label: "Content", items: [
    { id: "documents", label: "Documents", icon: "doc" },
    { id: "reports", label: "Reports", icon: "flag" },
  ] },
  { label: "People", items: [
    { id: "users", label: "Users", icon: "users" },
    { id: "feedback", label: "Feedback", icon: "message" },
  ] },
  { label: "Outreach", items: [{ id: "email", label: "Email", icon: "mail" }] },
];

export const SECTION_LABEL: Record<Section, string> = {
  overview: "Overview", live: "Live", health: "Product health", journeys: "Journeys", documents: "Documents", reports: "Reports",
  users: "Users", feedback: "Feedback", email: "Email",
};

const ITEM =
  "md-focus flex min-h-9 min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-body text-text-secondary no-underline transition-colors duration-(--duration-fast) hover:bg-surface-hover hover:text-text max-lg:min-h-11";
const ACTIVE = "bg-accent-soft font-medium text-accent-text hover:bg-accent-soft hover:text-accent-text";

function RailNav({ section, counts, onSelect, idPrefix }: {
  section: Section; counts: { reports?: number; feedback?: number };
  onSelect: (s: Section) => void; idPrefix: string;
}) {
  return (
    <nav aria-label="Admin" className="flex flex-col gap-6">
      {GROUPS.map((g) => (
        <section key={g.label} aria-labelledby={`${idPrefix}-${g.label}`} className="flex flex-col gap-0.5">
          <h2 id={`${idPrefix}-${g.label}`} className="mb-1.5 px-2.5 text-eyebrow uppercase text-text-muted">{g.label}</h2>
          {g.items.map((it) => {
            const on = section === it.id;
            const n = it.id === "reports" ? counts.reports : it.id === "feedback" ? counts.feedback : undefined;
            return (
              <a key={it.id} href={`/admin?tab=${it.id}`} aria-current={on ? "page" : undefined} className={cx(ITEM, on && ACTIVE)}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  e.preventDefault();
                  onSelect(it.id);
                }}>
                <Icon name={it.icon} size={16} />
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {n !== undefined && n > 0 && (
                  it.id === "reports"
                    ? <Badge size="sm" tone="warning" className="tabular-nums">{n}<span className="md-visually-hidden"> reported</span></Badge>
                    : <Badge size="sm" tone="neutral" className="tabular-nums">{n}<span className="md-visually-hidden"> open</span></Badge>
                )}
              </a>
            );
          })}
        </section>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <MarkdropLogo size={26} href="/" label="Markdrop home" />
      <Badge size="sm" tone="neutral" variant="outline">Admin</Badge>
    </div>
  );
}

export function AdminShell({ section, counts, onSelect, onSignOut, children }: {
  section: Section; counts: { reports?: number; feedback?: number };
  onSelect: (s: Section) => void; onSignOut: () => void; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [section]);

  const footer = (
    <div className="flex flex-col gap-1 border-t border-border pt-3">
      <a href="/" target="_blank" rel="noopener noreferrer" className={ITEM}>
        <Icon name="external" size={16} />
        <span className="min-w-0 flex-1 truncate">Open markdrop.in</span>
        <span className="md-visually-hidden">(opens in a new tab)</span>
      </a>
      <Button variant="ghost" iconLeft="logOut" onClick={onSignOut} className="justify-start max-lg:min-h-11">Sign out</Button>
    </div>
  );

  return (
    <div className="flex min-h-dvh w-full min-w-0 flex-1">
      <SkipLink />
      <div className="hidden w-58 shrink-0 border-r border-border bg-surface lg:block">
        <aside aria-label="Admin console" className="sticky top-0 flex h-dvh flex-col gap-6 overflow-y-auto px-3 py-5">
          <div className="px-1.5"><Brand /></div>
          <div className="flex-1"><RailNav section={section} counts={counts} onSelect={onSelect} idPrefix="rail" /></div>
          {footer}
        </aside>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-(--z-sticky) flex min-h-14 items-center gap-2 border-b border-border bg-surface px-2 sm:px-4 lg:hidden">
          <IconButton icon="menu" label="Open admin navigation" className="size-11" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} />
          <Brand />
          <span className="ml-auto min-w-0 truncate pr-2 text-body-strong text-text-secondary" aria-hidden>{SECTION_LABEL[section]}</span>
        </div>
        <main id="main" tabIndex={-1} className="w-full min-w-0 flex-1 px-4 py-6 outline-none sm:px-6 lg:px-8 lg:py-8">
          <div className="mx-auto w-full min-w-0 max-w-admin">{children}</div>
        </main>
      </div>

      <Drawer open={open} onClose={() => setOpen(false)} side="left" width={300} title="Admin console" bodyClassName="flex flex-col gap-6">
        <RailNav section={section} counts={counts} onSelect={onSelect} idPrefix="drawer" />
        {footer}
      </Drawer>
    </div>
  );
}
