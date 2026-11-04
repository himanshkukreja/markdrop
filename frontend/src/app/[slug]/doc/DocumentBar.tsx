"use client";

import { Button, CopyButton, Dropdown, IconButton, type MenuEntry } from "@/components/ui";

// The framed reader's top bar is DocumentTopBar (one bar, a page's: components/pages/PageChrome).

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
