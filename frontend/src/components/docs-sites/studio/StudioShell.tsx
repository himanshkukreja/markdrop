"use client";

import "./studio.css";
import { useEffect } from "react";
import { Anchor, Badge, Dropdown, Icon, IconButton, MarkdropMark, cx, type MenuEntry } from "@/components/ui";
import { HeaderAuthSlot } from "@/components/shell/AccountMenu";
import type { SiteSummary } from "@/lib/docsSites";
import { SiteTile } from "../SiteBar";
import { PERSONAL, scopeOf, siteBase, studioHome, studioNew } from "../routes";
import { StudioProvider, useStudio, useWorkspaceName } from "./StudioContext";

/** "Docs Studio" beside the Markdrop mark: the studio's own name, same family as the app's logo. */
export function StudioWordmark({ size = 26, compact, className }: { size?: number; compact?: boolean; className?: string }) {
  return (
    <Anchor href={studioHome()} className={cx("md-focus flex shrink-0 items-center gap-2 rounded-md text-text no-underline", className)} aria-label="Docs Studio home">
      <MarkdropMark size={size} />
      <span className={cx("docs-studio__word text-[17px] leading-none", compact && "max-sm:hidden")} aria-hidden>
        Docs <em>Studio</em>
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
          label: <span className="truncate" dir="auto">{s.name}</span>,
          href: siteBase(s.id),
          tile: <SiteTile site={s} size={20} />,
          icon: s.id === current.id ? "check" : undefined,
        });
      }
    }
  }
  items.push({ label: "All docs sites", href: studioHome(), icon: "layers", separated: items.length > 0 });
  items.push({ label: "New docs site", href: studioNew(scopeOf(current)), icon: "plus" });
  return (
    <Dropdown
      align="left"
      minWidth={260}
      aria-label="Switch docs site"
      trigger={
        <button
          type="button"
          className="md-focus flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-text hover:bg-surface-hover"
          aria-label={`${current.name}: switch docs site`}
        >
          <SiteTile site={current} size={22} />
          <span className="min-w-0 max-w-[38vw] truncate text-body-strong sm:max-w-[260px]" dir="auto">{current.name}</span>
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
    <Anchor href={studioHome(scopeOf(current))} className="md-focus hidden shrink-0 rounded-full no-underline sm:inline-flex" title={current.workspace_id ? `In the ${label} workspace` : "Your personal site"}>
      <Badge size="sm" icon={current.workspace_id ? "users" : "user"}>{label}</Badge>
    </Anchor>
  );
}

/** Between Markdrop and Docs Studio: the same account, two products. */
function AppSwitcher() {
  const tile = (bg: string, icon: React.ReactNode) => (
    <span className="grid size-8 place-items-center rounded-lg" style={{ background: bg }} aria-hidden>{icon}</span>
  );
  return (
    <Dropdown
      align="right"
      minWidth={280}
      aria-label="Switch app"
      trigger={<IconButton icon="columns" label="Switch app" />}
      items={[
        { header: <span className="text-caption font-semibold uppercase tracking-wide text-text-muted">Markdrop apps</span> },
        { label: "Markdrop", description: "Documents, artifacts and file sharing", href: "/dashboard", tile: tile("transparent", <MarkdropMark size={28} />) },
        { label: "Docs Studio", description: "Documentation websites for your team", href: studioHome(), tile: tile("var(--accent-soft)", <Icon name="layers" className="text-accent-text" />), icon: "check" },
      ]}
    />
  );
}

/**
 * Docs Studio's header: the Markdrop mark with "Docs Studio", then (on a site's screens) the site
 * switcher and its workspace; on the right the app switcher and the account menu.
 */
export function StudioHeader() {
  const { current } = useStudio();
  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 sm:gap-3 sm:px-5">
      {/* With a site open, phones keep the room for its name: the mark alone. */}
      <StudioWordmark compact={!!current} />
      {current && (
        <>
          <span aria-hidden className="text-[18px] font-light text-text-subtle">/</span>
          <SiteSwitcher />
          <WorkspaceBadge />
        </>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <AppSwitcher />
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
