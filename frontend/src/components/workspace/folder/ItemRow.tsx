"use client";

/**
 * One item row (simpler UI, Main board): the file's tile, its title and a one-line meta (address ·
 * views · who · when), then "who can open it" as a quiet pill that opens the Share dialog, Copy link
 * and the row menu. On phones (Mobile board) the row is the icon, the title and the access words;
 * its ⋯ opens the bottom sheet. Used by the folder view, Shared with me and Recent.
 */
import type { ReactNode } from "react";
import {
  Anchor, Badge, Button, CopyButton, FILE_KINDS, FileIcon, Icon, IconButton, cx, fileKind,
  type FileRenderer, type MenuEntry,
} from "@/components/ui";
import RowMenu from "@/components/dashboard/RowMenu";
import { plural, relativeTime, fullDate } from "@/components/dashboard/format";
import type { ItemAccess } from "@/lib/workspaces";
import { ACCESS_ICON, accessLabel } from "./items";

const RENDERERS = new Set<FileRenderer>(["pdf", "sheet", "docx", "text", "video", "audio", "html", "image", "zip"]);

export interface RowFile {
  slug: string;
  kind: string;
  mime?: string | null;
  renderer?: string | null;
  original_filename?: string | null;
}

/** The file's icon in its category colour (markdown documents are "document"). */
export function ItemTile({ file, bare }: { file: RowFile; bare?: boolean }) {
  const renderer = file.renderer && RENDERERS.has(file.renderer as FileRenderer) ? (file.renderer as FileRenderer) : null;
  const name = file.kind === "artifact" ? file.original_filename || file.slug : "doc.md";
  const kind = fileKind(name, file.mime || "", renderer);
  const tint = FILE_KINDS[kind].tint;
  if (bare) {
    return <span aria-hidden className="flex shrink-0" style={{ color: tint }}><FileIcon name={name} mime={file.mime || ""} renderer={renderer} size={18} /></span>;
  }
  return (
    <span
      aria-hidden
      className="grid size-9 shrink-0 place-items-center rounded-lg"
      style={{ color: tint, background: "color-mix(in srgb, currentColor 12%, transparent)" }}
    >
      <FileIcon name={name} mime={file.mime || ""} renderer={renderer} size={18} />
    </span>
  );
}

export interface ItemRowProps {
  file: RowFile;
  title: string;
  href: string;
  /** "docs.acme.com/guides/getting-started" (no scheme). */
  address: string | null;
  views?: number | null;
  /** "You", "Dana Kim"… */
  by?: string | null;
  /** ISO time for "2 days ago". */
  when?: string | null;
  access: ItemAccess;
  /** The workspace's short name ("Acme") for "Acme team". */
  team?: string | null;
  hasPassword?: boolean;
  encrypted?: boolean;
  /** Opens the Share dialog; null = the caller can't change it (the pill is plain text). */
  onAccess?: (() => void) | null;
  copy?: string | null;
  menu: MenuEntry[];
  menuLabel: string;
  phone: boolean;
  /** Phones: the ⋯ opens the bottom sheet instead of a menu. */
  onSheet?: () => void;
  /** Before the tile (e.g. a selection checkbox). */
  leading?: ReactNode;
  /** After the title (e.g. a "New" badge, a location chip). */
  badges?: ReactNode;
  /** Extra meta at the start of the second line. */
  chip?: ReactNode;
  rowRef?: (el: HTMLLIElement | null) => void;
  rowProps?: React.HTMLAttributes<HTMLLIElement>;
  className?: string;
}

export function ItemRow({
  file, title, href, address, views, by, when, access, team, hasPassword, encrypted, onAccess, copy, menu, menuLabel,
  phone, onSheet, leading, badges, chip, rowRef, rowProps, className,
}: ItemRowProps) {
  const words = accessLabel(access, team);
  const icon = ACCESS_ICON[access];
  const updated = when ? relativeTime(when) : null;

  if (phone) {
    return (
      <li ref={rowRef} {...rowProps} className={cx("ph-no-capture flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface py-3 pr-1.5 pl-3.5", className)}>
        {leading}
        <ItemTile file={file} bare />
        <div className="flex min-w-0 flex-1 flex-col">
          <Anchor href={href} target="_blank" rel="noopener noreferrer" className="md-focus min-w-0 truncate rounded-sm text-body-strong text-text no-underline" dir="auto">
            {title}<span className="md-visually-hidden"> (opens in a new tab)</span>
          </Anchor>
          <span className="flex min-w-0 items-center gap-1 text-caption text-text-muted">
            <Icon name={icon} size={12} className="shrink-0" />
            <span className="truncate">{words}{hasPassword && access === "link" ? " · password" : ""}</span>
          </span>
        </div>
        {onSheet ? (
          <IconButton icon="more" label={menuLabel} className="size-11" onClick={onSheet} aria-haspopup="dialog" />
        ) : (
          <RowMenu items={menu} label={menuLabel} />
        )}
      </li>
    );
  }

  return (
    <li ref={rowRef} {...rowProps} className={cx("ph-no-capture relative flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-3 transition-colors duration-(--duration-fast) hover:border-border-strong", className)}>
      {leading}
      <ItemTile file={file} />
      <div className="flex min-w-0 flex-[1_1_260px] flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <Anchor href={href} target="_blank" rel="noopener noreferrer" className="md-focus min-w-0 truncate rounded-sm text-body-strong text-text no-underline hover:underline hover:underline-offset-3" dir="auto" title={title}>
            {title}<span className="md-visually-hidden"> (opens in a new tab)</span>
          </Anchor>
          {encrypted && <Badge size="sm" tone="info" icon="key" upper title="Encrypted in the browser. The key is in the link.">E2E</Badge>}
          {hasPassword && <Badge size="sm" icon="lock" title="People without access are asked for the password">Password</Badge>}
          {badges}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-caption text-text-muted">
          {chip}
          <span className="min-w-0 truncate">
            {address && <span className="font-mono">{address}</span>}
            {views != null && <>{address && <span aria-hidden> · </span>}<span>{plural(views, "view")}</span></>}
            {by && <><span aria-hidden> · </span><span>{by}</span></>}
            {updated && when && (
              <>
                <span aria-hidden> · </span>
                <time dateTime={when} title={fullDate(when)}>{updated}</time>
              </>
            )}
          </span>
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {onAccess ? (
          <Button
            variant="ghost"
            size="sm"
            iconLeft={icon}
            iconRight="chevronDown"
            onClick={onAccess}
            aria-label={`Who can open it: ${words}. Change`}
            aria-haspopup="dialog"
            className="text-text-secondary"
          >
            {words}
          </Button>
        ) : (
          <span className="inline-flex h-8 items-center gap-1.5 px-2 text-caption text-text-secondary" title={`Who can open it: ${words}`}>
            <Icon name={icon} size={14} />
            {words}
          </span>
        )}
        {copy && <CopyButton text={copy} label="Copy link" variant="secondary" size="sm" announceText="Link copied" />}
        <RowMenu items={menu} label={menuLabel} />
      </div>
    </li>
  );
}

export default ItemRow;
