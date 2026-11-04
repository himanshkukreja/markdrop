"use client";

import type { ReactNode } from "react";
import { Badge, Button, Dropdown, IconButton, Kbd, Tooltip, type MenuEntry } from "@/components/ui";
import { useShortcutsEnabled } from "@/lib/shortcuts";
import { linkParts } from "@/components/kit/publish-utils";
import { navigateToHeading, tocHeadings, type Heading } from "@/components/reading";
import { PageTopBar, type PageAddressing } from "@/components/pages/PageChrome";

export interface DocumentTopBarProps {
  slug: string;
  /** The document URL without a fragment. */
  url: string;
  /** What Copy link copies: `url` plus `#k=…` on an encrypted document. */
  shareUrl: string;
  /** The title (decrypted, or the document's own H1); none → /slug. */
  title: string | null;
  /** The workspace and folders before the title (members, on markdrop.in), as on a page. */
  addressing: PageAddressing;
  /** A gate is showing: the bar holds /slug and a badge, and no actions. */
  gated?: boolean;
  gateBadge?: "private" | "password" | null;
  /** The gate shows its own sign-in: the bar has no account slot. */
  hideAccount?: boolean;
  encrypted: boolean;
  /** The E2E badge opens "How this is protected". */
  onProtection?: (() => void) | null;
  onCopyLink?: () => void;
  onEdit?: (() => void) | null;
  onShare?: (() => void) | null;
  onFullScreen?: (() => void) | null;
  /** The ⋯ menu: the document's, with Copy link (when Share takes the bar) and Details. */
  menu?: MenuEntry[];
  headings?: Heading[];
  /** Who's viewing (components/presence): first among the actions, with who is editing. */
  presence?: ReactNode;
  /** There are sidebars (Contents, Details) for the bar's toggle to hide (≥ 1280 px, ⌘\). */
  rail?: boolean;
}

/**
 * A classic (Markdown) document's one top bar: a page's bar (components/pages/PageChrome
 * PageTopBar) with the document's own actions. Where the framed reader used to stack the app
 * header (SiteHeader, or TenantHeader on a workspace's domain) over a document bar, this is the
 * only bar now, in view details, behind a gate and in the editor:
 *
 *   sidebar toggle · logo · workspace › folders › title [E2E | lock] ……… who's viewing · Contents ·
 *   Edit · full screen (F) · Share (or Copy link) · ⋯ │ Create · avatar (or Sign in)
 *
 * Copy link and Details are in ⋯ (Copy link is the bar's own button when there's no Share). On
 * phones Share leads ⋯, and the bottom action bar (DocumentActionBar) keeps Contents, Copy link and
 * Share or Edit within reach of a thumb.
 */
export function DocumentTopBar(p: DocumentTopBarProps) {
  // The F hint only shows while single-key shortcuts are on (Settings › Account).
  const [shortcuts] = useShortcutsEnabled();
  const path = linkParts(p.url).slug || p.slug;
  const entries = tocHeadings(p.headings ?? []);
  const title = !p.gated && p.title ? p.title : `/${path}`;

  const badge = p.gated
    ? p.gateBadge && <Badge icon="lock" size="sm">{p.gateBadge === "private" ? "Private" : "Password"}</Badge>
    : p.encrypted && (
        p.onProtection ? (
          <button type="button" onClick={p.onProtection} className="md-focus rounded-full" aria-label="End-to-end encrypted: how this is protected">
            <Badge tone="info" icon="key" size="sm">E2E</Badge>
          </button>
        ) : (
          <Badge tone="info" icon="key" size="sm">E2E</Badge>
        )
      );

  const tools = p.gated ? null : (
    <>
      {entries.length > 0 && (
        // Below 1280 px, and on a wide screen while the sidebars are hidden (pages.css).
        <span className="md-docbar__contents">
          <Dropdown
            aria-label="Contents"
            trigger={<Button variant="ghost" size="sm" iconLeft="listTree" iconRight="chevronDown" className="pb-bar__btn">Contents</Button>}
            items={entries.map((h) => ({
              label: <span dir="auto" className={h.depth > entries[0]!.depth ? "pl-3" : undefined}>{h.text}</span>,
              onClick: () => navigateToHeading(h.id, { encrypted: p.encrypted }),
            }))}
            menuClassName="ph-no-capture max-h-[60dvh] overflow-y-auto"
          />
        </span>
      )}
      {p.onEdit && (
        <Button variant="ghost" size="sm" iconLeft="edit" onClick={p.onEdit} className="pb-bar__btn pb-bar__wide">
          Edit
        </Button>
      )}
      {p.onFullScreen && (
        <Tooltip side="bottom" content={<span className="inline-flex items-center gap-1.5">Read full screen{shortcuts !== false && <> <Kbd>F</Kbd></>}</span>}>
          <IconButton icon="expand" label="Read full screen" title="" size="sm" variant="ghost" className="pb-bar__btn" aria-keyshortcuts={shortcuts !== false ? "F" : undefined} onClick={p.onFullScreen} />
        </Tooltip>
      )}
    </>
  );

  return (
    <PageTopBar
      className="md-docbar"
      crumbs={[]}
      title={title}
      addressing={p.addressing}
      badge={badge || null}
      presence={p.gated ? null : p.presence}
      tools={tools}
      onShare={p.gated ? null : p.onShare}
      shareUrl={p.gated ? undefined : p.shareUrl}
      onCopied={p.onCopyLink}
      menu={p.gated ? [] : p.menu ?? []}
      menuLabel="More actions"
      rail={!!p.rail}
      hideAccount={p.hideAccount}
    />
  );
}
