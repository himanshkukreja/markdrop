"use client";

import "./studio.css";
import { useEffect } from "react";
import { Anchor, Badge, Dropdown, Icon, MarkdropLogo, MarkdropMark, cx, type MenuEntry } from "@/components/ui";
import { HeaderAuthSlot } from "@/components/shell/AccountMenu";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { roleLabel, type SiteSummary } from "@/lib/docsSites";
import { RoleBadge } from "../people/roles";
import { SiteTile } from "../SiteBar";
import { PERSONAL, scopeOf, siteBase, studioHome, studioMembers, studioNew } from "../routes";
import { GuideSearch } from "./GuideSearch";
import { StudioProvider, useStudio, useWorkspaceName } from "./StudioContext";

/**
 * "Guides" in the accent (Markdrop Guides' name), linking to its home. Phones put the Markdrop
 * mark before it (the full logo and a divider sit before it from sm up, in the header); with a
 * guide open (`compact`) phones keep the mark alone, to leave room for the guide's name.
 */
export function StudioWordmark({ size = 26, compact, className }: { size?: number; compact?: boolean; className?: string }) {
  return (
    <Anchor href={studioHome()} className={cx("md-focus flex shrink-0 items-center gap-2 rounded-md text-text no-underline", className)} aria-label="Markdrop Guides home">
      <MarkdropMark size={size} className="sm:hidden" />
      <span className={cx("docs-studio__word text-[17px] leading-none", compact && "max-sm:hidden")} aria-hidden>
        <em>Guides</em>
      </span>
    </Anchor>
  );
}

/** Groups the listing's sites by where they live, in the listing's workspace order, personal last. */
export function groupSites(sites: SiteSummary[], workspaces: Array<{ id: string; name: string }>): Array<{ scope: string; name: string; sites: SiteSummary[] }> {
  const out = workspaces.map((w) => ({ scope: w.id, name: w.name, sites: sites.filter((s) => s.workspace_id === w.id) }));
  out.push({ scope: PERSONAL, name: "Personal", sites: sites.filter((s) => !s.workspace_id) });
  return out;
}

/** The open site's name with a menu of every other site you can open, grouped by workspace. */
function SiteSwitcher() {
  const { all, current } = useStudio();
  if (!current) return null;
  const items: MenuEntry[] = [];
  if (all) {
    for (const g of groupSites(all.sites, all.workspaces)) {
      if (!g.sites.length) continue;
      items.push({ header: <span className="text-caption font-semibold uppercase tracking-wide text-text-muted">{g.name}</span>, separated: items.length > 0 });
      for (const s of g.sites) {
        items.push({
          label: <span className="ph-sensitive ph-mask truncate" dir="auto" title={s.name}>{s.name}</span>,
          href: siteBase(s.id),
          tile: <SiteTile site={s} size={20} />,
          description: roleLabel(s.your_role),
          icon: s.id === current.id ? "check" : undefined,
        });
      }
    }
  }
  items.push({ label: "All guides", href: studioHome(), icon: "layers", separated: items.length > 0 });
  items.push({ label: "New guide", href: studioNew(scopeOf(current)), icon: "plus" });
  const ws = current.workspace_id ? all?.workspaces.find((w) => w.id === current.workspace_id) : null;
  if (ws?.can_manage_people) items.push({ label: `Members of ${ws.name}`, href: studioMembers(ws.id), icon: "users" });
  return (
    <Dropdown
      align="left"
      minWidth={260}
      aria-label="Switch guide"
      trigger={
        <button
          type="button"
          className="ph-no-capture md-focus flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-text hover:bg-surface-hover"
          aria-label={`${current.name}: switch guide`}
        >
          <SiteTile site={current} size={22} />
          <span className="min-w-0 max-w-[38vw] truncate text-body-strong sm:max-w-[260px]" dir="auto" title={current.name}>{current.name}</span>
          <Icon name="chevronDown" size={14} className="shrink-0 text-text-muted" />
        </button>
      }
      items={items}
    />
  );
}

/** Which workspace the open site belongs to (or Personal); a link to that workspace's sites. */
function WorkspaceBadge() {
  const { current } = useStudio();
  const name = useWorkspaceName(current?.workspace_id);
  if (!current) return null;
  const label = current.workspace_id ? name : "Personal";
  if (!label) return null;
  return (
    <Anchor href={studioHome(scopeOf(current))} className="md-focus hidden shrink-0 rounded-full no-underline sm:inline-flex" title={current.workspace_id ? `In the ${label} workspace` : "Your personal guide"}>
      <Badge size="sm" icon={current.workspace_id ? "users" : "user"}>{label}</Badge>
    </Anchor>
  );
}

/** Markdrop's own areas beside Guides (wide screens; the account menu has them everywhere). */
const APP_NAV = [
  { label: "Documents", href: "/dashboard?kind=document" },
  { label: "Files", href: "/dashboard?kind=artifact" },
  { label: "Guides", href: studioHome(), current: true },
];

function AppNav({ className }: { className?: string }) {
  return (
    <nav aria-label="Markdrop" className={cx("items-center gap-0.5", className)}>
      {APP_NAV.map((l) => (
        <Anchor
          key={l.label}
          href={l.href}
          aria-current={l.current ? "page" : undefined}
          className={cx(
            "md-focus rounded-md px-2.5 py-1.5 text-body no-underline transition-colors",
            l.current ? "bg-surface-active font-semibold text-text" : "text-text-secondary hover:bg-surface-hover hover:text-text",
          )}
        >
          {l.label}
        </Anchor>
      ))}
    </nav>
  );
}

/**
 * Markdrop Guides' header, on every Guides screen: the Markdrop logo, a divider and "Guides"; on
 * a guide's screens its switcher, workspace and your role there; Markdrop's Documents / Files /
 * Guides; then the guide search (⌘K), the theme switch and the account menu. Phones: the mark with
 * "Guides" (the mark alone with a guide open), the search button and the account menu.
 */
export function StudioHeader() {
  const { current } = useStudio();
  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 sm:gap-3 sm:px-5">
      <MarkdropLogo size={26} wordmark={!current} href="/" className="md-focus shrink-0 max-sm:hidden" />
      <span aria-hidden className="h-[22px] w-px shrink-0 bg-border-strong max-sm:hidden" />
      <StudioWordmark compact={!!current} />
      {current && (
        <>
          <span aria-hidden className="text-[18px] font-light text-text-subtle">/</span>
          <SiteSwitcher />
          <WorkspaceBadge />
          <RoleBadge role={current.your_role} className="max-sm:hidden" title="Your Guides role on this guide" />
        </>
      )}
      <AppNav className={cx("ml-2 hidden", current ? "2xl:flex" : "lg:flex")} />
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <GuideSearch compact={!!current} />
        <ThemeToggle className="max-md:hidden" />
        <HeaderAuthSlot />
      </div>
    </header>
  );
}

/**
 * The studio's frame: its accent tokens (studio.css) on this root and, while mounted, on <html>
 * (portals render outside the root), the studio-wide state, and the header.
 */
export function StudioShell({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const html = document.documentElement;
    html.setAttribute("data-studio", "docs");
    return () => html.removeAttribute("data-studio");
  }, []);
  return (
    <StudioProvider>
      <div className="docs-studio flex min-h-dvh w-full min-w-0 flex-1 flex-col bg-bg text-text">
        <StudioHeader />
        {children}
      </div>
    </StudioProvider>
  );
}

export default StudioShell;
