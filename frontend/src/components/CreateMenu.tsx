"use client";

import { CreateMenu as DSCreateMenu, type ButtonSize, type MenuEntry } from "@/components/ui";
import { useNotionImport } from "@/components/import/useNotionImport";
import { useAuth } from "@/contexts/AuthContext";
import { useMounted } from "@/components/shell/useLocation";
import { studioUrl } from "@/lib/studioHost";

/**
 * The one Create entry point (REVAMP_PLAN 4.4): a design-system Dropdown with six rows, each a
 * cat-* tile, a label and one line of description:
 *   Markdown document / "Write or paste markdown, publish a link"            → /new
 *   Page (Beta) / "Write with blocks, embed your files, add sub-pages"        → /pages/new
 *       (the template gallery, then the block editor; signed out: "Needs an account")
 *   Artifact (New) / "HTML page, PDF, spreadsheet, Word doc or video"          → /upload
 *       signed out it adds the caption "Needs an account" (/upload keeps a signed-out draft
 *       and asks for sign-in before publishing)
 *   README builder / "Assemble a README from ready-made blocks"               → /builder
 *   Send a file / "Peer-to-peer. Files are never stored on our servers."      → /share
 *   Guide / "A help center or product guide, in Markdrop Guides"              → guides.markdrop.in/new
 *       (signed out: "Needs an account"; the studio asks for sign-in first)
 *   Import › From Notion / "Pages and databases from a Notion export"          → the Import from Notion dialog
 *       (signed in only; the dialog loads on first use)
 * Keyboard: Enter/Space/ArrowDown open and focus the first row, arrows move, Escape closes and
 * returns focus to the trigger. Below 360px the trigger is the plus alone (label kept for AT).
 *
 * `variant` is "secondary" everywhere except where the page has no action of its own (/dashboard).
 */
export default function CreateMenu({
  variant = "secondary",
  size,
  align = "right",
  className,
}: {
  variant?: "primary" | "secondary";
  size?: ButtonSize;
  align?: "left" | "right";
  className?: string;
}) {
  const { user, loading } = useAuth();
  const mounted = useMounted();
  // While auth resolves, assume signed in so the caption never flashes for signed-in people.
  const signedIn = loading || !!user;
  // Guide: the studio's new-guide screen on its own host (guides.markdrop.in/new; /guides/new
  // locally). Before mount the menu keeps /guides/new, which redirects there.
  const hrefs = mounted ? { docs: studioUrl("/new") } : undefined;
  const notion = useNotionImport();
  const extra: MenuEntry[] | undefined = user ? [
    { header: "Import", separated: true },
    {
      label: "From Notion", description: "Pages, sub-pages and databases from a Notion export", onClick: notion.open,
      tile: <span className="md-menu__tile" style={{ color: "var(--text)", background: "var(--surface-active)" }}><NotionMark /></span>,
    },
  ] : undefined;
  return (
    <div className={className}>
      <DSCreateMenu variant={variant} size={size} align={align} signedIn={signedIn} hrefs={hrefs} extra={extra} />
      {notion.dialog}
    </div>
  );
}

/** A plain square-N mark for the Notion row (no brand colours). */
function NotionMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.5 16.5v-9l7 9v-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
