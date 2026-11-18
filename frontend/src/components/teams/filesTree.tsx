"use client";

/**
 * A team's folder / page tree as TreeView nodes (components/workspace/FolderTree). It used to sit under each team in
 * the sidebar; since the nav redesign (2026-11-18) the sidebar shows only a team's sections and this tree is the
 * team's Files & pages (TeamFiles). Folders, pages (with sub-pages, loaded when opened), documents and files; drag
 * and drop to move, files dropped on a folder upload there. Meeting pages and the Meetings folders are not in it
 * (the Meetings section lists them), nor the hidden HubSpot deal folders (the Deals section).
 */
import { FileIcon, Icon, type MenuEntry } from "@/components/ui";
import type { TreeNode } from "@/components/workspace/FolderTree";
import { can, type NavItem, type TreeFolder, type Workspace, type WorkspaceNav, type WorkspaceTree } from "@/lib/workspaces";
import { childrenMap, descendants } from "@/lib/workspaceStore";
import { childrenSlot } from "@/lib/navStore";
import { isFavorite, type Favorite, type FavoriteKind } from "@/lib/favorites";
import type { TeamCard } from "@/lib/teams";
import type { FileRenderer } from "@/components/ui/markdrop";

/** A page's tree key (also its expand key). */
export const filesPageKey = (wsId: string, slug: string) => `ws:${wsId}:page:${slug}`;
export const filesFolderKey = (wsId: string, folderId: string) => `ws:${wsId}:folder:${folderId}`;
/** The Archive group: folders named "… (archived)", "Archive", "Old stuff (archive)". */
export const filesArchiveKey = (wsId: string, teamId: string) => `ws:${wsId}:archive:${teamId}`;
const ARCHIVED = /\barchived?\b/i;

/** A page's icon: its emoji, its image, else the page glyph. */
export function PageIcon({ icon, url }: { icon?: string | null; url?: string | null }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" />;
  }
  if (icon && !icon.startsWith("asset:")) return <span className="md-tree__emoji">{icon}</span>;
  return <Icon name="doc" size={16} />;
}

/** A document or file's icon by kind (a Markdown document: lines; files: their type's glyph and tint). */
export function ItemIcon({ it }: { it: Pick<NavItem, "kind" | "renderer" | "mime" | "filename"> }) {
  if (it.kind === "markdown") return <Icon name="lines" size={16} />;
  return <FileIcon renderer={(it.renderer as FileRenderer | null) ?? null} mime={it.mime ?? ""} name={it.filename ?? ""} size={16} />;
}

/** Where a row sits, for drag and drop: its folder (null: the top level), its parent page and every page above it. */
interface Place { folderId: string | null; parent: string | null; ancestors: string[] }

export interface FilesCtx {
  ws: Workspace;
  member: boolean;
  expanded: Set<string>;
  /** Open pages whose sub-pages the tree needs (collected while building). */
  want: string[];
  copy: (href: string, label: string) => void;
  /** "Add to / Remove from favorites" for a row's ⋯ menu. */
  fav: (kind: FavoriteKind, ref: string, label: string, draft?: Partial<Favorite>) => MenuEntry;
}

/** A node's `sig` (see shareNodes): the values its row shows and its handlers use. */
const sig = (...parts: unknown[]) => JSON.stringify(parts);

function pageNode(c: FilesCtx, p: { slug: string; title: string | null; has_children?: boolean; icon?: string | null; icon_url?: string | null }, at: Place, shown: boolean): TreeNode {
  const wsId = c.ws.id;
  const key = filesPageKey(wsId, p.slug);
  const label = p.title?.trim() || "Untitled";
  const href = `/${encodeURIComponent(p.slug)}`;
  let children: TreeNode[] | undefined;
  let lazy = false;
  if (p.has_children && shown && c.expanded.has(key)) {
    c.want.push(p.slug);
    const kids = childrenSlot(p.slug);
    if (kids === null) lazy = true;
    else if (kids) {
      const below: Place = { ...at, parent: p.slug, ancestors: [...at.ancestors, p.slug] };
      children = kids.map((k) => pageNode(c, k, below, true));
    }
  } else if (p.has_children) lazy = true;
  const isLazy = lazy && !children?.length;
  const isLeaf = !p.has_children || (children !== undefined && !children.length);
  return {
    key,
    sig: sig("p", label, p.icon, p.icon_url, isLazy, isLeaf, c.member, at.folderId, at.parent, at.ancestors, isFavorite(wsId, "doc", p.slug)),
    label,
    icon: <PageIcon icon={p.icon} url={p.icon_url} />,
    href,
    children: children?.length ? children : undefined,
    lazy: isLazy,
    leaf: isLeaf,
    drag: c.member ? { type: "page", workspaceId: wsId, slug: p.slug, label, parent: at.parent, folderId: at.folderId } : null,
    drop: c.member ? { workspaceId: wsId, folderId: at.folderId, label: `“${label}”`, acceptsFolders: false, page: { slug: p.slug, ancestors: at.ancestors } } : null,
    actions: {
      add: c.member ? { href: `/pages/new?parent=${encodeURIComponent(p.slug)}`, label: `Add a page inside ${label}` } : null,
      menu: [
        ...(c.member ? [{ label: "Add a sub-page", icon: "plus", href: `/pages/new?parent=${encodeURIComponent(p.slug)}` }] : []),
        c.fav("doc", p.slug, label, { href, icon: p.icon, doc_kind: "page", editor: "blocks" }),
        { label: "Copy link", icon: "link", onClick: () => c.copy(href, label) },
        { label: "Open in new tab", icon: "external", href, external: true },
      ],
    },
  };
}

function itemNode(c: FilesCtx, it: NavItem): TreeNode {
  const label = (it.title?.trim() || it.filename || it.slug);
  const href = `/${encodeURIComponent(it.slug)}`;
  return {
    key: `ws:${c.ws.id}:item:${it.slug}`,
    sig: sig("i", label, it.kind, it.renderer, it.mime, it.filename, it.folder_id, c.member, isFavorite(c.ws.id, "doc", it.slug)),
    label,
    icon: <ItemIcon it={it} />,
    href,
    leaf: true,
    drag: c.member ? { type: "items", workspaceId: c.ws.id, slugs: [it.slug], label, fromFolderId: it.folder_id ?? null } : null,
    actions: {
      menu: [
        c.fav("doc", it.slug, label, { href, doc_kind: it.kind, renderer: it.renderer, mime: it.mime, filename: it.filename }),
        { label: "Copy link", icon: "link", onClick: () => c.copy(href, label) },
        { label: "Open in new tab", icon: "external", href, external: true },
      ],
    },
  };
}

/** What sits directly in a place (a folder, or the top level): pages first, then documents and files,
 *  then "N more" (a link to the folder view) when the outline was cut. */
function placeNodes(c: FilesCtx, nav: WorkspaceNav, folderId: string | null, href: string, shown: boolean): TreeNode[] {
  const here = nav.items.filter((it) => (it.folder_id ?? null) === folderId);
  const out = here.map((it) =>
    it.kind === "page" ? pageNode(c, it, { folderId, parent: null, ancestors: [] }, shown) : itemNode(c, it),
  );
  const more = nav.more[folderId ?? "root"];
  if (more) {
    out.push({
      key: `ws:${c.ws.id}:more:${folderId ?? "root"}`,
      sig: sig("m", more, href),
      label: `${more} more`,
      icon: <Icon name="more" size={16} />,
      href,
      leaf: true,
      className: "text-text-muted",
    });
  }
  return out;
}

type TeamFolder = TreeFolder & { team_ids?: string[] };

/** The folders a team's Files & pages shows: General's = folders in no team; a team's = its own. Never the
 *  Meetings folders (the Meetings section) — a folder whose parent isn't shown sits at the top. */
export function teamFolders(tree: WorkspaceTree, t: Pick<TeamCard, "id" | "general">): TreeFolder[] {
  const mine = (tree.folders as TeamFolder[]).filter((f) => !f.meetings && !f.meetings_sub
    && (t.general ? !f.team_ids?.length : !!f.team_ids?.includes(t.id)));
  const ids = new Set(mine.map((f) => f.id));
  return mine.map((f) => (f.parent_id && !ids.has(f.parent_id) ? { ...f, parent_id: null } : f));
}

/** Whether a top-level folder goes in the Archive group. */
export const isArchived = (f: Pick<TreeFolder, "name">) => ARCHIVED.test(f.name);

/**
 * The team's tree: its top-level folders (archived ones grouped under one "Archive" row at the end, closed by
 * default), then the items at its top level. `onFiles` uploads files dropped on a folder.
 */
export function teamFilesNodes(
  c: FilesCtx, t: Pick<TeamCard, "id" | "general" | "my_role" | "can_admin" | "name">, tree: WorkspaceTree, nav: WorkspaceNav | null,
  onFiles: ((wsId: string, folderId: string | null, label: string, files: File[]) => void) | null,
): TreeNode[] {
  const { ws } = c;
  const inTeam = !!t.my_role || t.can_admin || !!t.general;
  const admin = can(tree.workspace.role ?? ws.role, "admin");
  const wsHref = `/w/${encodeURIComponent(ws.id)}`;
  const folderHref = (id: string) => `${wsHref}/f/${encodeURIComponent(id)}`;
  const newPage = (folder?: string) => `/pages/new?workspace=${encodeURIComponent(ws.id)}${t.general ? "" : `&team=${encodeURIComponent(t.id)}`}${folder ? `&folder=${encodeURIComponent(folder)}` : ""}`;
  const filesTo = (folderId: string | null, label: string) =>
    c.member && inTeam && onFiles ? (files: File[]) => onFiles(ws.id, folderId, label, files) : undefined;
  const folders = teamFolders(tree, t);
  const ids = new Set(folders.map((f) => f.id));
  const kids = childrenMap(folders);
  // An item filed in a folder the tree doesn't show sits at the team's top level.
  const outline: WorkspaceNav | null = nav ? { ...nav, items: nav.items.map((it) => (it.folder_id && !ids.has(it.folder_id) ? { ...it, folder_id: null } : it)) } : null;
  const build = (f: TreeFolder, parentShown: boolean): TreeNode => {
    const shown = parentShown && c.expanded.has(filesFolderKey(ws.id, f.id));
    const sub = (kids.get(f.id) ?? []).map((x) => build(x, shown));
    const items = outline ? placeNodes(c, outline, f.id, folderHref(f.id), shown) : [];
    const all = [...sub, ...items];
    const blocked = admin ? [...descendants(tree.folders, f.id)] : [];
    return {
      key: filesFolderKey(ws.id, f.id),
      sig: sig("f", f.name, f.parent_id, f.share?.level ?? null, !all.length, c.member, admin, blocked),
      label: f.name,
      icon: <Icon name="folder" size={16} />,
      href: folderHref(f.id),
      children: all.length ? all : undefined,
      leaf: !all.length,
      marker: f.share ? (
        <span className="inline-flex shrink-0 text-text-muted" title={f.share.level === "link" ? "Shared by link" : "Shared with the team"}>
          <Icon name="link" size={12} />
          <span className="md-visually-hidden">, shared</span>
        </span>
      ) : undefined,
      drop: c.member ? { workspaceId: ws.id, folderId: f.id, label: f.name, acceptsFolders: admin } : null,
      drag: admin ? { type: "folder", workspaceId: ws.id, folderId: f.id, label: f.name, parentId: f.parent_id, blocked } : null,
      onFiles: filesTo(f.id, f.name),
      actions: {
        add: c.member && inTeam ? { href: newPage(f.id), label: `New page in ${f.name}` } : null,
        menu: [
          ...(c.member && inTeam ? [{ label: "New page here", icon: "plus", href: newPage(f.id) }] : []),
          { label: "Copy link", icon: "link", onClick: () => c.copy(folderHref(f.id), f.name) },
        ],
      },
    };
  };
  const top = kids.get(null) ?? [];
  const live = top.filter((f) => !isArchived(f)).map((f) => build(f, true));
  const archived = top.filter(isArchived);
  const items = outline ? placeNodes(c, outline, null, wsHref, true) : [];
  const out = [...live, ...items];
  if (archived.length) {
    const akey = filesArchiveKey(ws.id, t.id);
    const open = c.expanded.has(akey);
    out.push({
      key: akey,
      sig: sig("archive", archived.length, open),
      label: "Archive",
      icon: <Icon name="archive" size={16} />,
      className: "text-text-muted",
      count: archived.length,
      children: archived.map((f) => build(f, open)),
    });
  }
  return out;
}
