"use client";

import {
  Badge, Button, CopyButton, Dropdown, IconButton, Kbd, Tooltip, type MenuEntry,
} from "@/components/ui";
import { LinkPill } from "@/components/kit/LinkPill";
import { linkParts } from "@/components/kit/publish-utils";
import { navigateToHeading, tocHeadings, type Heading } from "@/components/reading";

export interface DocumentBarProps {
  slug: string;
  /** The document URL without a fragment (host + path shown in the pill). */
  url: string;
  /** What Copy link copies: `url` plus `#k=…` on an encrypted document. */
  shareUrl: string;
  /** Decrypted/display title; empty → the slug in mono. */
  title: string | null;
  /** A gate is showing: the bar holds only /slug and a badge (REVAMP_PLAN 7.6). */
  gated?: boolean;
  gateBadge?: "private" | "password" | null;
  encrypted: boolean;
  /** Read-mode actions (absent while gated). */
  onCopyLink?: () => void;
  onEdit?: (() => void) | null;
  onShare?: (() => void) | null;
  onFullScreen?: (() => void) | null;
  onDetails?: () => void;
  onContents?: () => void;
  menu?: MenuEntry[];
  headings?: Heading[];
  /** "secondary" while another primary (the publish panel's Copy link) is on screen. */
  copyVariant?: "primary" | "secondary";
}

/**
 * The framed reader's sticky bar (REVAMP_PLAN 7.6, Viewer board): title + link on the left;
 * Copy link (the one primary) · Edit (owner or secret holder only, D19) · Share (owners and
 * resharers) · Read full screen (F) · More on the right. Contents collapses to a dropdown below
 * 1280px, and Details to a drawer. On phones the actions move to the bottom bar
 * (`DocumentActionBar`) and this keeps the title, Details and full screen.
 */
export function DocumentBar(p: DocumentBarProps) {
  const { host, fragment } = linkParts(p.shareUrl);
  const path = linkParts(p.url).slug || p.slug;
  const entries = tocHeadings(p.headings ?? []);
  const titleNode = p.title ? (
    <Tooltip content={<span dir="auto">{p.title}</span>} side="bottom" className="flex min-w-0 max-w-full">
      <p dir="auto" tabIndex={0} className="md-focus min-w-0 truncate rounded-sm text-body-strong text-text">{p.title}</p>
    </Tooltip>
  ) : (
    <p className="min-w-0 truncate font-mono text-body text-text-secondary">/{path}</p>
  );

  return (
    <div className="no-print sticky top-14 z-(--z-sticky) border-b border-border bg-surface">
      <div className="mx-auto flex h-14 max-w-marketing items-center gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {p.gated ? (
            <>
              <p className="min-w-0 truncate font-mono text-body text-text-secondary">/{path}</p>
              {p.gateBadge && (
                <Badge icon="lock" size="sm">{p.gateBadge === "private" ? "Private" : "Password"}</Badge>
              )}
            </>
          ) : (
            <>
              <div className="flex min-w-0 max-w-[24rem] shrink">{titleNode}</div>
              <span className="hidden min-w-0 shrink lg:flex">
                <LinkPill
                  slug={path}
                  host={host || "markdrop.in"}
                  fragment={fragment || undefined}
                  size="sm"
                  middleEllipsis
                  className="min-w-0"
                />
              </span>
              {p.encrypted && <span className="hidden md:flex xl:hidden"><Badge tone="info" icon="key" size="sm">E2E</Badge></span>}
            </>
          )}
        </div>

        {!p.gated && (
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {entries.length > 0 && (
              <div className="hidden sm:block xl:hidden">
                <Dropdown
                  aria-label="Contents"
                  trigger={<Button variant="ghost" size="sm" iconLeft="listTree" iconRight="chevronDown">Contents</Button>}
                  items={entries.map((h) => ({
                    label: <span dir="auto" className={h.depth > entries[0]!.depth ? "pl-3" : undefined}>{h.text}</span>,
                    onClick: () => navigateToHeading(h.id, { encrypted: p.encrypted }),
                  }))}
                  menuClassName="max-h-[60dvh] overflow-y-auto"
                />
              </div>
            )}
            <div className="hidden sm:block">
              <CopyButton text={p.shareUrl} label="Copy link" variant={p.copyVariant ?? "primary"} size="sm" onCopy={p.onCopyLink} />
            </div>
            {p.onEdit && (
              <Button variant="secondary" size="sm" iconLeft="edit" onClick={p.onEdit} className="hidden sm:inline-flex">
                Edit
              </Button>
            )}
            {p.onShare && (
              <Button variant="secondary" size="sm" iconLeft="userPlus" onClick={p.onShare} className="hidden sm:inline-flex">
                Share
              </Button>
            )}
            {p.onDetails && (
              <IconButton icon="info" label="Details" onClick={p.onDetails} className="xl:hidden" />
            )}
            {p.onFullScreen && (
              <Tooltip side="left" content={<span className="inline-flex items-center gap-1.5">Read full screen <Kbd>F</Kbd></span>}>
                <IconButton icon="expand" label="Read full screen" title="" aria-keyshortcuts="F" onClick={p.onFullScreen} />
              </Tooltip>
            )}
            {p.menu && p.menu.length > 0 && (
              <div className="hidden sm:block">
                <Dropdown
                  aria-label="More actions"
                  trigger={<IconButton icon="more" label="More actions" />}
                  items={p.menu}
                  minWidth={220}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Phones (<640): the sticky bottom action bar (MobileReading frames 1–2): Contents · Copy link
 * (primary) · Share or Edit · More. Padded by the safe area.
 */
export function DocumentActionBar({
  shareUrl, onCopyLink, onContents, onShare, onEdit, menu, copyVariant = "primary",
}: {
  copyVariant?: "primary" | "secondary";
  shareUrl: string;
  onCopyLink?: () => void;
  onContents?: (() => void) | null;
  onShare?: (() => void) | null;
  onEdit?: (() => void) | null;
  menu?: MenuEntry[];
}) {
  return (
    <div
      className="no-print sticky bottom-0 z-(--z-sticky) border-t border-border bg-surface px-4 pt-2 sm:hidden"
      style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom, 0px))" }}
    >
      <div className="flex items-center gap-2">
        {onContents && <IconButton icon="listTree" label="Contents" variant="secondary" onClick={onContents} className="h-11 w-11" />}
        <CopyButton text={shareUrl} label="Copy link" variant={copyVariant} block onCopy={onCopyLink} className="h-11 min-w-0 flex-1" />
        {onShare ? (
          <Button variant="secondary" iconLeft="userPlus" onClick={onShare} className="h-11">Share</Button>
        ) : onEdit ? (
          <Button variant="secondary" iconLeft="edit" onClick={onEdit} className="h-11">Edit</Button>
        ) : null}
        {menu && menu.length > 0 && (
          <Dropdown
            aria-label="More actions"
            placement="top"
            trigger={<IconButton icon="more" label="More actions" variant="secondary" className="h-11 w-11" />}
            items={menu}
            minWidth={220}
          />
        )}
      </div>
    </div>
  );
}
