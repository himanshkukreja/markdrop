"use client";

/**
 * A folder's contents (fix/ws-listing), modelled on the custom-domain listing's calm rows:
 *
 *   List (default)  Finder / Notion-like rows: icon · name (· item count) · kind · owner · updated ·
 *                   who can open it · ⋯. Folders first, then items, in one list.
 *   Grid            compact tiles: icon, name, one quiet line (item count, or owner and date).
 *   Cards           larger cards: a preview of the item (CardPreview.tsx: a page's cover and first
 *                   blocks, a document's start, a PDF's first page, an image, a video's poster, a
 *                   sheet's first cells; an HTML file live on hover), the name, owner and date.
 *
 * The view is the person's choice, remembered on this device (Cards until they pick one) (`useListingView`, localStorage in
 * try/catch). Owners show as a small avatar and a name (names only reach members: the API serves
 * this listing to workspace members alone). Folders are drop targets (items, desktop files) and,
 * for admins, draggable; items are draggable when they can move. Phones get one list of 60 px rows
 * whose ⋯ opens the bottom sheet, or a two-column grid.
 */
import { useState, useSyncExternalStore } from "react";
import {
  Anchor, Badge, Checkbox, CopyButton, Icon, IconButton, SegmentedControl, Skeleton, Tooltip, cx, FILE_KINDS, fileKind,
  type FileRenderer, type MenuEntry,
} from "@/components/ui";
import RowMenu from "@/components/dashboard/RowMenu";
import { fullDate, plural, relativeTime } from "@/components/dashboard/format";
import { hasFiles } from "@/components/workspace/uploads/UploadProvider";
import { colorFor, viewerColor } from "@/lib/presence";
import { kindLabel } from "@/lib/itemKind";
import { openHref, type ItemOwner, type TreeFolder, type WorkspaceItem } from "@/lib/workspaces";
import { useFolderDrop, useWorkspaceDrag, useWorkspaceDraggable, type DragData } from "../WorkspaceDnd";
import { PreviewBand, useLiveHover } from "./CardPreview";
import { ItemTile } from "./ItemRow";
import { ACCESS_ICON, accessLabel, itemTitle } from "./items";
import "./listing.css";

/* ── The view, remembered ──────────────────────────────────────────────── */

export type ListingView = "list" | "grid" | "cards";
const VIEW_KEY = "md_ws_view";
const VIEWS: ListingView[] = ["list", "grid", "cards"];
const viewListeners = new Set<() => void>();
let memory: ListingView | null = null;

function readView(): ListingView {
  if (memory) return memory;
  try {
    const v = window.localStorage.getItem(VIEW_KEY) as ListingView | null;
    if (v && VIEWS.includes(v)) return v;
  } catch {
    /* storage blocked: the default */
  }
  return "cards";
}

function subscribeView(cb: () => void) {
  viewListeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === VIEW_KEY) { memory = null; cb(); } };
  window.addEventListener("storage", onStorage);
  return () => { viewListeners.delete(cb); window.removeEventListener("storage", onStorage); };
}

/** The person's listing view on this device ("cards", with live previews, until they pick another), and a setter. */
export function useListingView(): [ListingView, (v: ListingView) => void] {
  const view = useSyncExternalStore(subscribeView, readView, () => "cards" as ListingView);
  const set = (v: ListingView) => {
    memory = v;
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* remembered for this tab only */
    }
    for (const l of viewListeners) l();
  };
  return [view, set];
}

export function ViewSwitch({ view, onChange, className }: { view: ListingView; onChange: (v: ListingView) => void; className?: string }) {
  return (
    <SegmentedControl<ListingView>
      aria-label="View"
      size="sm"
      iconOnly
      value={view}
      onChange={onChange}
      className={className}
      options={[
        { value: "list", label: "List", icon: "list" },
        { value: "grid", label: "Grid", icon: "grid" },
        { value: "cards", label: "Cards", icon: "cards" },
      ]}
    />
  );
}

/* ── People ────────────────────────────────────────────────────────────── */

/** One letter: two don't fit a 20 px circle legibly (Notion does the same). */
function initial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() || "?";
}

export const ownerLabel = (o: Pick<ItemOwner, "name" | "is_you">) => (o.is_you ? "You" : o.name || "Someone");

/** A person's avatar: their photo (https) or their initials on a soft colour that's stable per name. */
export function PersonAvatar({ person, size = "md" }: { person: ItemOwner; size?: "sm" | "md" | "lg" }) {
  const [broken, setBroken] = useState(false);
  const name = person.name || (person.is_you ? "You" : "?");
  const pic = person.picture && person.picture.startsWith("https://") && !broken ? person.picture : null;
  return (
    <span
      aria-hidden
      className={cx("wl-av ph-no-capture", size === "sm" && "wl-av--sm", size === "lg" && "wl-av--lg")}
      style={{ "--av": viewerColor(colorFor(name)) } as React.CSSProperties}
    >
      {initial(name)}
      {/* A profile photo from the sign-in provider: next/image would need every host allow-listed. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {pic && <img src={pic} alt="" referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setBroken(true)} />}
    </span>
  );
}

/** Avatar and name ("You" for the caller). `data-owner` marks it for tests. */
export function Person({ person, size, hideName, className }: { person: ItemOwner; size?: "sm" | "md" | "lg"; hideName?: boolean; className?: string }) {
  const label = ownerLabel(person);
  // The name on hover (instant, the design system's tooltip; never the slow native title).
  return (
    <Tooltip content={<span className="ph-sensitive ph-mask">{person.is_you ? "You own this" : `Owned by ${label}`}</span>}>
      <span className={cx("wl-person", className)} data-owner>
        <PersonAvatar person={person} size={size} />
        <span className={cx("wl-person__name ph-sensitive ph-mask", hideName && "md-visually-hidden")}>{label}</span>
      </span>
    </Tooltip>
  );
}

/** A folder's people: up to three overlapping avatars, then "+n". */
export function People({ people, count, size = "md" }: { people: ItemOwner[]; count: number; size?: "sm" | "md" }) {
  if (!people.length) return <span className="wl-count" aria-label="Nobody yet">—</span>;
  const names = people.map(ownerLabel);
  const rest = Math.max(0, count - people.length);
  const words = `Items by ${names.join(", ")}${rest ? ` and ${rest} more` : ""}`;
  return (
    <span className="wl-people" data-owner>
      {/* Each face names its person on hover; "+n" lists the rest. */}
      {people.map((p, i) => (
        <Tooltip key={`${p.name}-${i}`} content={<span className="ph-sensitive ph-mask">{ownerLabel(p)}</span>}>
          <PersonAvatar person={p} size={size} />
        </Tooltip>
      ))}
      {rest > 0 && (
        <Tooltip content={<span className="ph-sensitive ph-mask">{words}</span>}>
          <span className="wl-more" aria-hidden>+{rest}</span>
        </Tooltip>
      )}
      <span className="md-visually-hidden ph-sensitive ph-mask">{words}</span>
    </span>
  );
}

/* ── Icons ─────────────────────────────────────────────────────────────── */

const RENDERERS = new Set<FileRenderer>(["pdf", "sheet", "docx", "pptx", "text", "video", "audio", "html", "image", "zip"]);

/** The colour of an item's kind (its file category). */
export function tintOf(it: WorkspaceItem): string {
  const renderer = it.renderer && RENDERERS.has(it.renderer as FileRenderer) ? (it.renderer as FileRenderer) : null;
  const name = it.kind === "artifact" ? it.original_filename || it.slug : "doc.md";
  return FILE_KINDS[fileKind(name, it.mime || "", renderer)].tint;
}

const isEmoji = (icon: string | null | undefined): icon is string => !!icon && !icon.startsWith("asset:") && icon.length <= 16;

export function ItemIcon({ it }: { it: WorkspaceItem }) {
  if (isEmoji(it.icon)) return <span aria-hidden className="wl-icon">{it.icon}</span>;
  return (
    <span aria-hidden className="wl-icon" style={{ color: tintOf(it), background: "color-mix(in srgb, currentColor 11%, transparent)" }}>
      <ItemTile file={it} bare />
    </span>
  );
}

const FolderIcon = () => (
  <span aria-hidden className="wl-icon wl-icon--folder"><Icon name="folder" size={16} /></span>
);

/* ── Entries ───────────────────────────────────────────────────────────── */

export interface FolderEntryProps {
  workspaceId: string;
  folder: TreeFolder;
  href: string;
  /** Items (and, for admins, folders) can be dropped here. */
  canDropItems: boolean;
  canDragFolders: boolean;
  /** Folder ids this folder can't be dropped into (itself and below). */
  blocked: string[];
  onFiles: ((files: File[]) => void) | null;
  menu: MenuEntry[] | null;
}

/** Drag and drop for a folder entry (any view). */
function useFolderEntry({ workspaceId, folder: f, canDropItems, canDragFolders, blocked, onFiles }: FolderEntryProps) {
  const drop = useFolderDrop(`card:${f.id}`, canDropItems ? { workspaceId, folderId: f.id, label: f.name, acceptsFolders: canDragFolders } : null);
  const dragData: DragData | null = canDragFolders
    ? { type: "folder", workspaceId, folderId: f.id, label: f.name, parentId: f.parent_id, blocked }
    : null;
  const drag = useWorkspaceDraggable(`card:${f.id}`, dragData);
  const { active } = useWorkspaceDrag();
  const [fileOver, setFileOver] = useState(false);
  return {
    ref: (el: HTMLLIElement | null) => { drop.setNodeRef(el); drag.setNodeRef(el); },
    props: {
      ...(drag.listeners ?? {}),
      "data-over": drop.over || fileOver ? "true" : undefined,
      "data-candidate": active && drop.candidate && !drop.over ? "true" : undefined,
      "data-dragging": drag.isDragging ? "true" : undefined,
      onDragOver: (e: React.DragEvent) => { if (onFiles && hasFiles(e.nativeEvent)) { e.preventDefault(); e.stopPropagation(); setFileOver(true); } },
      onDragLeave: () => setFileOver(false),
      onDrop: (e: React.DragEvent) => {
        if (!onFiles || !hasFiles(e.nativeEvent)) return;
        e.preventDefault();
        e.stopPropagation();
        setFileOver(false);
        onFiles(Array.from(e.dataTransfer.files));
      },
    } as React.HTMLAttributes<HTMLLIElement>,
  };
}

export interface ItemEntryProps {
  workspaceId: string;
  item: WorkspaceItem;
  team: string;
  /** Search results: say which folder each one is in. */
  showLocation: boolean;
  dragSlugs: string[];
  fromFolderId: string | null | undefined;
  menu: MenuEntry[];
  onAccess: (() => void) | null;
  onSheet: () => void;
  selection: { selected: boolean; active: boolean; onSelect: (on: boolean) => void } | null;
}

function useItemEntry({ workspaceId, item: it, dragSlugs, fromFolderId }: ItemEntryProps) {
  const t = itemTitle(it);
  const drag = useWorkspaceDraggable(`item:${it.slug}`, it.can.move
    ? { type: "items", workspaceId, slugs: dragSlugs, label: dragSlugs.length > 1 ? plural(dragSlugs.length, "item") : t, fromFolderId }
    : null);
  return {
    ref: drag.setNodeRef as (el: HTMLLIElement | null) => void,
    props: { ...(drag.listeners ?? {}), "aria-label": undefined, "data-dragging": drag.isDragging ? "true" : undefined } as React.HTMLAttributes<HTMLLIElement>,
  };
}

function When({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span aria-hidden>—</span>;
  return <time dateTime={iso} title={fullDate(iso)}>{relativeTime(iso)}</time>;
}

function Access({ it, team, onAccess, compact }: { it: WorkspaceItem; team: string; onAccess: (() => void) | null; compact?: boolean }) {
  const words = accessLabel(it.access, team);
  const icon = ACCESS_ICON[it.access];
  const inner = (
    <>
      <Icon name={icon} size={14} className="shrink-0" />
      <span className={cx("wl-access-words min-w-0 truncate ph-sensitive ph-mask", compact && "md-visually-hidden")}>{words}</span>
    </>
  );
  if (onAccess) {
    return (
      <button
        type="button"
        onClick={onAccess}
        className="wl-lift wl-access md-focus inline-flex h-8 max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-[13px] text-text-secondary hover:bg-surface-active hover:text-text"
        aria-label={`Who can open it: ${words}. Change`}
        aria-haspopup="dialog"
        title={`Who can open it: ${words}`}
      >
        {inner}
      </button>
    );
  }
  return (
    <span className="inline-flex h-8 max-w-full min-w-0 items-center gap-1.5 px-2 text-[13px] text-text-secondary" title={`Who can open it: ${words}`}>
      {inner}
    </span>
  );
}

function Badges({ it }: { it: WorkspaceItem }) {
  return (
    <>
      {it.encrypted && <Badge size="sm" tone="info" icon="key" upper title="Encrypted in the browser. The key is in the link.">E2E</Badge>}
      {it.has_password && <Badge size="sm" icon="lock" title="People without access are asked for the password">Password</Badge>}
    </>
  );
}

function Location({ it }: { it: WorkspaceItem }) {
  return (
    <span className="wl-count inline-flex min-w-0 items-center gap-1">
      <Icon name="folder" size={11} />
      <span className="max-w-32 truncate ph-sensitive ph-mask" dir="auto">{it.folder?.name ?? "Top level"}</span>
    </span>
  );
}

/* List rows */

function FolderRow(p: FolderEntryProps) {
  const { folder: f, href, menu } = p;
  const e = useFolderEntry(p);
  return (
    <li ref={e.ref} {...e.props} className="wl-row" data-row-kind="folder">
      <span className="wl-cell wl-cell--name">
        <FolderIcon />
        <Anchor href={href} draggable={false} className="wl-name ph-sensitive ph-mask" dir="auto">{f.name}</Anchor>
        <span className="wl-count">{plural(f.total_count, "item")}</span>
        {f.share && <Icon name="link" size={13} className="shrink-0 text-text-muted" aria-label={f.share.level === "link" ? "Folder link on" : "Shared with the team"} />}
      </span>
      <span className="wl-cell wl-c-kind">Folder</span>
      <span className="wl-cell wl-c-owner"><People people={f.people ?? []} count={f.people_count ?? 0} /></span>
      <span className="wl-cell"><When iso={f.updated_at} /></span>
      <span className="wl-cell wl-c-access" />
      <span className="wl-cell wl-cell--act">
        {menu && menu.length > 0 && <span className="wl-lift wl-hover"><RowMenu portal items={menu} label={`Actions for the folder ${f.name}`} /></span>}
      </span>
    </li>
  );
}

function ItemListRow(p: ItemEntryProps) {
  const { item: it, team, showLocation, menu, onAccess, selection } = p;
  const e = useItemEntry(p);
  const t = itemTitle(it);
  return (
    <li ref={e.ref} {...e.props} className="wl-row group" data-row-kind="item" data-selected={selection?.selected ? "true" : undefined}>
      {selection && (
        <span className={cx("wl-gutter transition-opacity", selection.active || selection.selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100")}>
          <Checkbox aria-label={`Select ${t}`} checked={selection.selected} onChange={(ev) => selection.onSelect(ev.target.checked)} />
        </span>
      )}
      <span className="wl-cell wl-cell--name">
        <ItemIcon it={it} />
        <a href={openHref(it.slug, it.url, it.encrypted)} target="_blank" rel="noopener noreferrer" draggable={false} className="wl-name md-focus ph-sensitive ph-mask" dir="auto" title={t}>
          {t}<span className="md-visually-hidden"> (opens in a new tab)</span>
        </a>
        <Badges it={it} />
        {showLocation && <Location it={it} />}
      </span>
      <span className="wl-cell wl-c-kind">{kindLabel(it)}</span>
      <span className="wl-cell wl-c-owner"><Person person={it.owner} /></span>
      <span className="wl-cell"><When iso={it.updated_at} /></span>
      <span className="wl-cell wl-c-access overflow-visible"><Access it={it} team={team} onAccess={onAccess} /></span>
      <span className="wl-cell wl-cell--act">
        {!it.encrypted && (
          <span className="wl-lift wl-hover wl-copy">
            <CopyButton text={it.url} label="Copy link" iconOnly variant="ghost" size="sm" announceText="Link copied" />
          </span>
        )}
        <span className="wl-lift"><RowMenu portal items={menu} label={`Actions for ${t}`} /></span>
      </span>
    </li>
  );
}

/* Phone rows */

function FolderPhoneRow(p: FolderEntryProps) {
  const { folder: f, href } = p;
  const e = useFolderEntry(p);
  return (
    <li ref={e.ref} {...e.props} className="wl-prow" data-row-kind="folder">
      <FolderIcon />
      <span className="wl-prow__main">
        <Anchor href={href} draggable={false} className="wl-name ph-sensitive ph-mask" dir="auto">{f.name}</Anchor>
        <span className="wl-prow__meta">
          <span>{plural(f.total_count, "item")}</span>
          {f.updated_at && <><span aria-hidden>·</span><When iso={f.updated_at} /></>}
        </span>
      </span>
      <Icon name="chevronRight" size={16} className="shrink-0 text-text-muted" aria-hidden />
    </li>
  );
}

function ItemPhoneRow(p: ItemEntryProps) {
  const { item: it, onSheet, showLocation } = p;
  const t = itemTitle(it);
  return (
    <li className="wl-prow" data-row-kind="item">
      <ItemIcon it={it} />
      <span className="wl-prow__main">
        <a href={openHref(it.slug, it.url, it.encrypted)} target="_blank" rel="noopener noreferrer" className="wl-name md-focus ph-sensitive ph-mask" dir="auto">
          {t}<span className="md-visually-hidden"> (opens in a new tab)</span>
        </a>
        <span className="wl-prow__meta">
          <Person person={it.owner} size="sm" />
          <span aria-hidden>·</span>
          <When iso={it.updated_at} />
          {showLocation && <><span aria-hidden>·</span><Location it={it} /></>}
        </span>
      </span>
      <IconButton icon="more" label={`Actions for ${t}`} className="wl-lift size-11" onClick={onSheet} aria-haspopup="dialog" />
    </li>
  );
}

/* Grid tiles and cards */

function FolderTile(p: FolderEntryProps & { cards: boolean }) {
  const { folder: f, href, menu, cards } = p;
  const e = useFolderEntry(p);
  const act = menu && menu.length > 0 ? <RowMenu portal items={menu} label={`Actions for the folder ${f.name}`} /> : null;
  const name = <Anchor href={href} draggable={false} className="wl-name ph-sensitive ph-mask" dir="auto">{f.name}</Anchor>;
  if (cards) {
    return (
      <li ref={e.ref} {...e.props} className="wl-tile" data-row-kind="folder">
        <span className="wl-card__band"><FolderIcon /></span>
        <span className="wl-card__body">
          {name}
          <span className="wl-card__foot">
            <People people={f.people ?? []} count={f.people_count ?? 0} size="sm" />
            <span className="ml-auto truncate">{plural(f.total_count, "item")}</span>
          </span>
        </span>
        {act && <span className="wl-card__act wl-lift wl-hover">{act}</span>}
      </li>
    );
  }
  return (
    <li ref={e.ref} {...e.props} className="wl-tile" data-row-kind="folder">
      <span className="wl-tile__top">
        <FolderIcon />
        {act && <span className="wl-tile__act wl-lift wl-hover">{act}</span>}
      </span>
      {name}
      <span className="wl-tile__meta"><span>{plural(f.total_count, "item")}</span></span>
    </li>
  );
}

function ItemTileEntry(p: ItemEntryProps & { cards: boolean }) {
  const { item: it, menu, cards, showLocation } = p;
  const e = useItemEntry(p);
  const t = itemTitle(it);
  const hover = useLiveHover(p.workspaceId, it);
  const link = (
    <a href={openHref(it.slug, it.url, it.encrypted)} target="_blank" rel="noopener noreferrer" draggable={false} className="wl-name md-focus ph-sensitive ph-mask" dir="auto" title={t}>
      {t}<span className="md-visually-hidden"> (opens in a new tab)</span>
    </a>
  );
  const act = <RowMenu portal items={menu} label={`Actions for ${t}`} />;
  if (cards) {
    return (
      <li ref={e.ref} {...e.props} {...(cards ? hover : {})} className="wl-tile" data-row-kind="item">
        <PreviewBand workspaceId={p.workspaceId} it={it} title={t} tint={tintOf(it)} kind={kindLabel(it)} fallback={<ItemIcon it={it} />} />
        <span className="wl-card__body">
          <span className="flex min-w-0 items-center gap-2">{link}<Badges it={it} /></span>
          <span className="wl-card__foot">
            <Person person={it.owner} size="sm" />
            <span aria-hidden>·</span>
            <span className="shrink-0"><When iso={it.updated_at} /></span>
            <span className="ml-auto inline-flex shrink-0 items-center" title={`Who can open it: ${accessLabel(it.access, p.team)}`}>
              <Icon name={ACCESS_ICON[it.access]} size={13} aria-label={`Who can open it: ${accessLabel(it.access, p.team)}`} />
            </span>
          </span>
          {showLocation && <Location it={it} />}
        </span>
        <span className="wl-card__act wl-lift wl-hover">{act}</span>
      </li>
    );
  }
  return (
    <li ref={e.ref} {...e.props} className="wl-tile" data-row-kind="item">
      <span className="wl-tile__top">
        <ItemIcon it={it} />
        <span className="wl-tile__act wl-lift wl-hover">{act}</span>
      </span>
      {link}
      <span className="wl-tile__meta">
        <Person person={it.owner} size="sm" hideName />
        <span>{kindLabel(it)}</span>
        <span aria-hidden>·</span>
        <When iso={it.updated_at} />
        {showLocation && <Location it={it} />}
      </span>
    </li>
  );
}

/* Placeholders while a folder's items load (its subfolders show at once, from the tree). */

const WIDTHS = ["46%", "62%", "38%", "54%", "44%", "58%"];

function SkeletonEntry({ view, phone, i }: { view: ListingView; phone: boolean; i: number }) {
  const w = WIDTHS[i % WIDTHS.length]!;
  if (phone && view === "list") {
    return (
      <li className="wl-prow" aria-hidden>
        <Skeleton variant="rect" width={28} height={28} />
        <span className="wl-prow__main"><Skeleton width={w} height={14} /><Skeleton width="30%" height={10} /></span>
      </li>
    );
  }
  if (view === "list") {
    return (
      <li className="wl-row" aria-hidden>
        <span className="wl-cell wl-cell--name"><Skeleton variant="rect" width={28} height={28} /><Skeleton width={w} height={14} /></span>
        <span className="wl-cell wl-c-kind"><Skeleton width={40} height={12} /></span>
        <span className="wl-cell wl-c-owner flex items-center gap-2"><Skeleton variant="circle" width={20} height={20} /><Skeleton width={72} height={12} /></span>
        <span className="wl-cell"><Skeleton width={56} height={12} /></span>
        <span className="wl-cell wl-c-access"><Skeleton width={104} height={12} /></span>
        <span />
      </li>
    );
  }
  if (view === "cards") {
    return (
      <li className="wl-tile" aria-hidden>
        <span className="wl-card__band" style={{ "--tint": "var(--text-subtle)" } as React.CSSProperties} />
        <span className="wl-card__body"><Skeleton width={w} height={14} /><Skeleton width="50%" height={12} /></span>
      </li>
    );
  }
  return (
    <li className="wl-tile" aria-hidden>
      <Skeleton variant="rect" width={36} height={36} />
      <Skeleton width={w} height={14} />
      <span className="wl-tile__meta"><Skeleton width="40%" height={10} /></span>
    </li>
  );
}

/* ── The listing ───────────────────────────────────────────────────────── */

export interface ListingProps {
  view: ListingView;
  phone: boolean;
  folders: FolderEntryProps[];
  items: ItemEntryProps[];
  /** List view, desktop: the select-all checkbox in the header's gutter. */
  selectAll: { checked: boolean; indeterminate: boolean; onChange: (on: boolean) => void } | null;
  label: string;
  /** Placeholder entries after the folders while the items load (0: none). */
  loading?: number;
}

export function Listing({ view, phone, folders, items, selectAll, label, loading = 0 }: ListingProps) {
  const skeletons = Array.from({ length: loading }, (_, i) => <SkeletonEntry key={`sk${i}`} view={view} phone={phone} i={i} />);
  if (phone && view === "list") {
    return (
      <ul className="wl-plist ph-no-capture" data-view="list" aria-label={label}>
        {folders.map((f) => <FolderPhoneRow key={f.folder.id} {...f} />)}
        {items.map((it) => <ItemPhoneRow key={it.item.slug} {...it} />)}
        {skeletons}
      </ul>
    );
  }
  if (view === "list") {
    return (
      <div className="wl-list ph-no-capture" data-view="list">
        <div className="wl-head">
          {selectAll && (
            <span className={cx("wl-gutter transition-opacity", selectAll.checked || selectAll.indeterminate ? "opacity-100" : "opacity-0 hover:opacity-100 focus-within:opacity-100")}>
              <Checkbox aria-label="Select all" checked={selectAll.checked} indeterminate={selectAll.indeterminate} onChange={(e) => selectAll.onChange(e.target.checked)} />
            </span>
          )}
          {/* Column labels for the eye; each row reads in the same order. */}
          <span aria-hidden className="pl-[38px]">Name</span>
          <span aria-hidden className="wl-c-kind">Kind</span>
          <span aria-hidden className="wl-c-owner">Owner</span>
          <span aria-hidden>Updated</span>
          <span aria-hidden className="wl-c-access pl-2">Access</span>
          <span aria-hidden />
        </div>
        <ul className="m-0 list-none p-0" aria-label={label}>
          {folders.map((f) => <FolderRow key={f.folder.id} {...f} />)}
          {items.map((it) => <ItemListRow key={it.item.slug} {...it} />)}
          {skeletons}
        </ul>
      </div>
    );
  }
  const cards = view === "cards";
  return (
    <ul className={cx("wl-grid ph-no-capture", cards && "wl-cards", phone && !cards && "!grid-cols-2", phone && cards && "!grid-cols-1")} data-view={view} aria-label={label}>
      {folders.map((f) => <FolderTile key={f.folder.id} {...f} cards={cards} />)}
      {items.map((it) => <ItemTileEntry key={it.item.slug} {...it} cards={cards} />)}
      {skeletons}
    </ul>
  );
}
