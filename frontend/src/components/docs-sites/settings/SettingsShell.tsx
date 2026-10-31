"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Alert, Anchor, Icon, Select, cx } from "@/components/ui";
import { getWorkspace } from "@/lib/workspaces";
import SiteBar from "../SiteBar";
import { useSite } from "../SiteContext";
import { SECTIONS, isSection, settingsHref, type SettingsSection } from "./sections";

/** Which section the address is on (/settings/<section>[/…]); null on /settings itself. */
export function useSettingsSection(): SettingsSection | null {
  const path = usePathname() ?? "";
  const seg = path.split("/settings/")[1]?.split("/")[0] ?? null;
  return isSection(seg) ? seg : null;
}

/** The workspace's name, for "Acme members only" and the like (null while loading, or personal). */
export function useWorkspaceName(): string | null {
  const { site } = useSite();
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (site.workspace_id) getWorkspace(site.workspace_id).then((w) => setName(w.name)).catch(() => {});
  }, [site.workspace_id]);
  return name;
}

/**
 * A section's heading: its name (h1), what it's for, and actions on the right. `back` adds a link
 * above it (a domain's setup page → Domains).
 */
export function SectionHeader({ title, description, actions, back }: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {back && (
        <Anchor href={back.href} className="md-focus mb-1 inline-flex w-fit items-center gap-1.5 rounded text-[13px] text-accent-text no-underline hover:underline">
          <Icon name="chevronLeft" size={14} />{back.label}
        </Anchor>
      )}
      <div className="flex min-w-0 flex-wrap items-start gap-3">
        <h1 className="min-w-0 flex-1 text-[24px] font-bold leading-8 text-text">{title}</h1>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {description && <p className="text-body text-text-secondary">{description}</p>}
    </div>
  );
}

/** One card of a section (Settings.dc.html): a title, an optional line under it, actions on the right. */
export function SettingsCard({ id, title, description, aside, children, tone, className }: {
  id?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  aside?: React.ReactNode;
  children?: React.ReactNode;
  tone?: "danger" | "accent";
  className?: string;
}) {
  const hid = id ? `${id}-h` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={title ? hid : undefined}
      className={cx(
        "flex min-w-0 flex-col gap-3.5 rounded-xl border p-4 sm:p-[22px]",
        tone === "danger" ? "border-danger bg-danger-soft" : tone === "accent" ? "border-[1.5px] border-accent bg-surface shadow-[var(--shadow-sm)]" : "border-border bg-surface",
        className,
      )}
    >
      {(title || aside) && (
        <div className="flex min-w-0 flex-wrap items-start gap-3">
          <div className="min-w-0 flex-[1_1_240px]">
            {title && <h2 id={hid} className="text-[16px] font-semibold leading-6 text-text">{title}</h2>}
            {description && <p className="mt-0.5 text-body text-text-secondary">{description}</p>}
          </div>
          {aside && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{aside}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A setting with a switch on the right (search indexing, Ask AI, reviews, Try it…). */
export function SwitchRow({ title, hint, children, divided }: { title: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; divided?: boolean }) {
  return (
    <div className={cx("flex min-w-0 items-center gap-3", divided && "border-t border-border pt-3.5")}>
      <div className="min-w-0 flex-1">
        <div className="text-body-strong text-text">{title}</div>
        {hint && <div className="text-caption text-text-muted">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Admins change settings; everyone else sees them, with this note at the top of each section. */
export function LockedNote() {
  const { isAdmin } = useSite();
  const ws = useWorkspaceName();
  if (isAdmin) return null;
  return (
    <Alert tone="neutral" title="Only Guides admins change these settings">
      You can see how this guide is set up. Ask a Guides admin of {ws ?? "this workspace"} to change it.
    </Alert>
  );
}

/**
 * /guides/<site>/settings/…: the site bar, then the sections on the left (sticky; a select on
 * phones) and the open section. Each section is its own page; the links are ordinary in-app links,
 * so a section with unsaved changes (useLeaveGuard) asks before leaving.
 */
export default function SettingsShell({ children }: { children: React.ReactNode }) {
  const { base } = useSite();
  const current = useSettingsSection();

  // The phone select goes through the matching (hidden) link, so the leave guard sees it like a click.
  const go = (id: string) => {
    const a = document.querySelector<HTMLAnchorElement>(`a[data-settings-link="${id}"]`);
    a?.click();
  };

  return (
    <>
      <SiteBar section="settings" />
      <div className="mx-auto grid w-full max-w-[1120px] grid-cols-1 gap-6 px-4 pb-16 pt-5 sm:px-6 sm:pt-7 md:grid-cols-[200px_minmax(0,1fr)] md:gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="hidden min-w-0 md:block">
          <div className="sticky top-[128px] flex flex-col gap-0.5">
            <p className="mb-2 ml-2.5 text-[13px] font-semibold uppercase tracking-wide text-text-muted">Settings</p>
            {SECTIONS.map((s) => {
              const on = s.id === current;
              return (
                <Anchor
                  key={s.id}
                  href={settingsHref(base, s.id)}
                  data-settings-link={s.id}
                  aria-current={on ? "page" : undefined}
                  className={cx(
                    "md-focus flex items-center gap-2.5 rounded-md px-2.5 py-2 text-body no-underline transition-colors",
                    on ? "bg-surface-active font-semibold text-text" : "font-medium text-text-secondary hover:bg-surface-hover hover:text-text",
                    s.id === "danger" && !on && "text-text-secondary",
                  )}
                >
                  <Icon name={s.icon} size={15} className={on ? "text-text" : "text-text-muted"} />
                  {s.label}
                </Anchor>
              );
            })}
          </div>
        </nav>
        <main id="main" tabIndex={-1} className="flex min-w-0 flex-col gap-5 outline-none">
          <div className="md:hidden">
            <label className="mb-1.5 block text-[13px] font-semibold text-text-muted" htmlFor="settings-section">Settings</label>
            <Select id="settings-section" value={current ?? "general"} onChange={(e) => go(e.target.value)} aria-label="Settings section"
              options={SECTIONS.map((s) => ({ value: s.id, label: s.label }))} />
          </div>
          {children}
        </main>
      </div>
    </>
  );
}
