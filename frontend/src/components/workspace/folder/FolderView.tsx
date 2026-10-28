"use client";

/**
 * A workspace folder (simpler UI, Main board): /w/<workspace> is the top level, /w/<workspace>/f/<folder>
 * a folder. One drive-like page:
 *
 *   breadcrumb · title with its address · Preview as / Share / New ▾
 *   "Who can open what's in here" (counts by preset) and what new items start as
 *   folders as cards · items as rows (access pill → Share, Copy link, menu)
 *   "Drop files anywhere on this page" — dropping files uploads them here
 *
 * A new, empty workspace shows "Get set up" beside a big drop zone (NewWorkspace board).
 * `?preview=anyone|member|email` switches to Preview as (PreviewAs board). Phones get a compact
 * header and a bottom sheet per item (Mobile board).
 *
 * What the toolbar offers follows the caller's role and each row's `can` flags from the server;
 * nothing is offered that the API would refuse. The list holds only what the caller can open
 * (A1/D2): other people's private documents aren't hidden by this page; the server never sends them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert, Anchor, Badge, Breadcrumb, Button, Checkbox, ConfirmDialog, Dropdown, EmptyState, Icon, IconButton,
  Skeleton, copyText, cx, useToast, type MenuEntry,
} from "@/components/ui";
import { WorkspaceTile } from "@/components/shell/SideNav";
import { useLocationSearch, useMounted } from "@/components/shell/useLocation";
import { openCommandPalette, useFolderCommands, type FolderCommand } from "@/components/shell/commands";
import ShareDialog from "@/components/access/ShareDialog";
import RowMenu from "@/components/dashboard/RowMenu";
import { ListSkeleton } from "@/components/dashboard/ListParts";
import { plural } from "@/components/dashboard/format";
import { usePhone } from "@/components/dashboard/hooks";
import { DeleteDocDialog, NewFolderDialog } from "@/components/dashboard/DocDialogs";
import { hasFiles, useUploads, type UploadTarget } from "@/components/workspace/uploads/UploadProvider";
import { useAuth } from "@/contexts/AuthContext";
import {
  can, errorStatus, listWorkspaceItems, listWorkspaces, removeItems,
  type Folder, type ItemAccess, type PreviewAs, type RedactedItem, type TreeFolder, type Workspace, type WorkspaceItem,
} from "@/lib/workspaces";
import {
  ancestry, childrenMap, descendants, documentsChanged, useWorkspaceChanged, useWorkspaceTree, workspaceChanged,
} from "@/lib/workspaceStore";
import { useFolderDrop, useWorkspaceDraggable, useWorkspaceDrag, type DragData } from "../WorkspaceDnd";
import { AddExistingDialog, DeleteFolderDialog, MAX_FOLDER_DEPTH, MoveToDialog, RenameFolderDialog, type MoveTarget } from "./FolderDialogs";
import ShareFolderDialog, { type ShareFolderTab } from "./ShareFolderDialog";
import { ExposureBar, FolderDefaultDialog, exposureOf } from "./ExposureBar";
import { ItemRow } from "./ItemRow";
import ItemSheet, { type SheetAction } from "./ItemSheet";
import PreviewMode from "./PreviewMode";
import RenameItemDialog, { type RenameTarget } from "./RenameItemDialog";
import { DropArea, SetupChecklist, useChecklistHidden } from "./SetupChecklist";
import { accessLabel, displayAddress, itemTitle, teamName, toDocRow } from "./items";

type Kind = "" | "markdown" | "artifact";
const PAGE = 50;

const wsHref = (ws: string) => `/w/${encodeURIComponent(ws)}`;
const folderHref = (ws: string, f: string) => `/w/${encodeURIComponent(ws)}/f/${encodeURIComponent(f)}`;

function readQuery(search: string) {
  const p = new URLSearchParams(search);
  const k = p.get("kind");
  const pv = p.get("preview");
  return {
    q: (p.get("q") || "").trim(),
    kind: (k === "markdown" || k === "artifact" ? k : "") as Kind,
    unfiled: p.get("filter") === "unfiled",
    preview: (pv === "anyone" || pv === "member" || pv === "email" ? pv : null) as PreviewAs | null,
    email: (p.get("email") || "").trim(),
  };
}

/** Workspaces with branding, shared across folder views (one request per session, refreshable). */
let wsCache: Promise<Workspace[]> | null = null;
function useWorkspaceMeta(id: string) {
  const [ws, setWs] = useState<Workspace | null>(null);
  useEffect(() => {
    let live = true;
    wsCache ??= listWorkspaces().catch((e) => { wsCache = null; throw e; });
    wsCache.then((all) => { if (live) setWs(all.find((w) => w.id === id) ?? null); }).catch(() => {});
    return () => { live = false; };
  }, [id]);
  return ws;
}

/** Files dragged from the desktop anywhere on the page (desktop only). */
function usePageFileDrop(target: UploadTarget | null, onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    if (!target) return;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setOver(true);
    };
    const overFn = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) onFiles(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", overFn);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", overFn);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [target, onFiles]);
  return over;
}

export default function FolderView({ workspaceId, folderId }: { workspaceId: string; folderId: string | null }) {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const phone = usePhone();
  const mounted = useMounted();
  const search = useLocationSearch();
  const urlReady = mounted && typeof window !== "undefined" && search === window.location.search;
  const query = useMemo(() => readQuery(search), [search]);
  const uploads = useUploads();

  // Signed out: to sign-in, then straight back here.
  useEffect(() => {
    if (authLoading || !mounted || user) return;
    router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }, [authLoading, mounted, user, router]);

  const { tree, error: treeError, reload: reloadTree } = useWorkspaceTree(user ? workspaceId : null);
  const meta = useWorkspaceMeta(workspaceId);
  const role = tree?.workspace.role ?? meta?.role;
  const isMember = can(role, "member");
  const isAdmin = can(role, "admin");
  const wsName = tree?.workspace.name ?? meta?.name ?? "Workspace";
  const team = teamName(meta, wsName);
  const host = tree?.workspace.primary_host ?? meta?.primary_host ?? null;
  const canShareFolders = isAdmin || (isMember && meta?.settings?.members_can_share_folders !== false);
  const wsDefault: ItemAccess = tree?.workspace.default_access ?? meta?.default_access ?? meta?.settings?.default_access ?? "workspace";

  const folders = useMemo(() => tree?.folders ?? [], [tree]);
  const folder = folderId ? folders.find((f) => f.id === folderId) ?? null : null;
  const trail = useMemo(() => ancestry(folders, folderId), [folders, folderId]);
  const kids = useMemo(() => childrenMap(folders), [folders]);
  const subfolders = useMemo(() => (query.unfiled ? [] : kids.get(folderId ?? null) ?? []), [kids, folderId, query.unfiled]);
  const folderMissing = !!folderId && !!tree && !folder;
  const wsMissing = !tree && !!treeError && [403, 404].includes(errorStatus(treeError));
  const startsAs: ItemAccess = folder ? folder.effective_default_access ?? folder.default_access ?? wsDefault : wsDefault;
  const here = folder?.name ?? wsName;

  /* ── URL state ────────────────────────────────────────────────────── */
  const setQuery = useCallback((patch: Record<string, string | null>, replace = true) => {
    const p = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (!v) p.delete(k);
      else p.set(k, v);
    }
    const qs = p.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    if (replace) router.replace(url, { scroll: false });
    else router.push(url, { scroll: false });
  }, [router]);

  /* ── Items ────────────────────────────────────────────────────────── */
  const [items, setItems] = useState<WorkspaceItem[]>([]);
  const [redacted, setRedacted] = useState<RedactedItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [more, setMore] = useState(false);
  const [itemsError, setItemsError] = useState("");
  const seq = useRef(0);
  // A search looks across the whole workspace; otherwise the folder (or the top level).
  const scope = query.q ? "all" : folderId ?? "root";

  const load = useCallback(async (quiet = false) => {
    if (!user || !urlReady) return;
    const id = ++seq.current;
    if (!quiet) setState("loading");
    try {
      const r = await listWorkspaceItems(workspaceId, { folder: scope, q: query.q || undefined, kind: query.kind || undefined, limit: PAGE });
      if (id !== seq.current) return;
      setItems(r.items);
      setRedacted(r.redacted);
      setCursor(r.next_cursor);
      setState("ok");
      setItemsError("");
    } catch (e) {
      if (id !== seq.current) return;
      setItemsError(e instanceof Error ? e.message : "");
      setState("error");
    }
  }, [user, urlReady, workspaceId, scope, query.q, query.kind]);

  useEffect(() => { void load(); }, [load]);
  // Anything that changes this workspace (here, in the rail, in a dialog, an upload) reloads quietly.
  const quietReload = useCallback(() => { void load(true); }, [load]);
  useWorkspaceChanged(workspaceId, quietReload);

  async function loadMore() {
    if (!cursor || more) return;
    setMore(true);
    try {
      const r = await listWorkspaceItems(workspaceId, { folder: scope, q: query.q || undefined, kind: query.kind || undefined, cursor, limit: PAGE });
      setItems((xs) => [...xs, ...r.items.filter((n) => !xs.some((x) => x.slug === n.slug))]);
      setRedacted((xs) => [...xs, ...r.redacted.filter((n) => !xs.some((x) => x.id_token === n.id_token))]);
      setCursor(r.next_cursor);
    } catch {
      toast.error("Couldn't load more. Try again.");
    } finally {
      setMore(false);
    }
  }

  /* ── Selection (desktop) ──────────────────────────────────────────── */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(new Set()), [workspaceId, folderId, query.q, query.kind]);
  const movable = items.filter((i) => i.can.move);
  const selectedItems = items.filter((i) => selected.has(i.slug));
  const toggleSelect = (slug: string, on: boolean) =>
    setSelected((s) => { const n = new Set(s); if (on) n.add(slug); else n.delete(slug); return n; });

  /* ── Dialogs ──────────────────────────────────────────────────────── */
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [renameFor, setRenameFor] = useState<TreeFolder | null>(null);
  const [deleteFor, setDeleteFor] = useState<TreeFolder | null>(null);
  const [shareTab, setShareTab] = useState<ShareFolderTab | null>(null);
  const [defaultFor, setDefaultFor] = useState<TreeFolder | null>(null);
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [shareFor, setShareFor] = useState<WorkspaceItem | null>(null);
  const [removeFor, setRemoveFor] = useState<WorkspaceItem[] | null>(null);
  const [removeHidden, setRemoveHidden] = useState<RedactedItem | null>(null);
  const [renameItem, setRenameItem] = useState<RenameTarget | null>(null);
  const [deleteItem, setDeleteItem] = useState<WorkspaceItem | null>(null);
  const [sheetFor, setSheetFor] = useState<WorkspaceItem | null>(null);

  const changed = useCallback(() => { workspaceChanged(workspaceId); }, [workspaceId]);

  const newDocHref = `/new?ws=${encodeURIComponent(workspaceId)}${folderId ? `&folder=${encodeURIComponent(folderId)}` : ""}`;
  const uploadHref = `/upload?ws=${encodeURIComponent(workspaceId)}${folderId ? `&folder=${encodeURIComponent(folderId)}` : ""}`;
  const depthFull = !!folder && folder.depth >= MAX_FOLDER_DEPTH; // tree depth: top level = 1

  /* ── Uploads (drop anywhere, Choose files) ────────────────────────── */
  const uploadTarget = useMemo<UploadTarget | null>(
    () => (isMember && uploads && tree && !folderMissing ? { workspaceId, folderId, label: here, access: startsAs } : null),
    [isMember, uploads, tree, folderMissing, workspaceId, folderId, here, startsAs],
  );
  const dropFiles = useCallback((files: File[]) => { if (uploadTarget && uploads) uploads.upload(files, uploadTarget); }, [uploadTarget, uploads]);
  const fileOver = usePageFileDrop(!phone && !query.preview ? uploadTarget : null, dropFiles);
  const pickFiles = () => { if (uploadTarget && uploads) uploads.pick(uploadTarget); else router.push(uploadHref); };

  /* ── Preview as ───────────────────────────────────────────────────── */
  const openPreview = useCallback(() => { setShareTab(null); setQuery({ preview: "anyone", email: null }, false); }, [setQuery]);

  /* ── ⌘K actions for this folder ───────────────────────────────────── */
  useFolderCommands(useCallback((c: FolderCommand) => {
    if (c === "share" && folder) setShareTab("link");
    else if (c === "invite") setShareTab("invite");
    else if (c === "new-folder" && !depthFull) setNewFolderOpen(true);
    else if (c === "preview") openPreview();
  }, [folder, depthFull, openPreview]));

  /* ── Row menus ────────────────────────────────────────────────────── */
  const copyLink = (it: WorkspaceItem) => {
    void copyText(it.url).then((ok) => (ok ? toast.success("Link copied") : toast.error("Couldn't copy the link")));
  };
  const moveOne = (it: WorkspaceItem) =>
    setMoveTarget({ kind: "items", slugs: [it.slug], label: itemTitle(it), fromFolderId: it.folder?.id ?? null });

  function itemMenu(it: WorkspaceItem): MenuEntry[] {
    const out: MenuEntry[] = [{ label: "Open", icon: "external", href: `/${it.slug}` }];
    if (it.can.move) out.push({ label: "Move to…", icon: "folder", onClick: () => moveOne(it) });
    if (it.can.edit && !it.encrypted) out.push({ label: "Rename", icon: "edit", onClick: () => setRenameItem({ slug: it.slug, kind: it.kind, title: itemTitle(it) }) });
    if (it.can.unshare) out.push({ label: "Remove from workspace", icon: "x", separated: true, onClick: () => setRemoveFor([it]) });
    if (it.can.delete) out.push({ label: "Delete", icon: "trash", danger: true, separated: !it.can.unshare, onClick: () => setDeleteItem(it) });
    return out;
  }

  function sheetActions(it: WorkspaceItem): SheetAction[] {
    const out: SheetAction[] = [];
    if (!it.encrypted) out.push({ label: "Copy link", icon: "copy", onClick: () => copyLink(it) });
    if (it.can.share) out.push({ label: "Who can open it", icon: "user", value: accessLabel(it.access, team), onClick: () => setShareFor(it) });
    if (it.can.move) out.push({ label: "Move to…", icon: "folder", value: it.folder?.name ?? "Top level", onClick: () => moveOne(it) });
    if (it.can.edit && !it.encrypted) out.push({ label: "Rename", icon: "edit", onClick: () => setRenameItem({ slug: it.slug, kind: it.kind, title: itemTitle(it) }) });
    if (it.can.unshare) out.push({ label: "Remove from workspace", icon: "x", onClick: () => setRemoveFor([it]) });
    if (it.can.delete) out.push({ label: "Delete", icon: "trash", danger: true, onClick: () => setDeleteItem(it) });
    return out;
  }

  /* ── Header ───────────────────────────────────────────────────────── */
  const crumbs = [
    { label: wsName, href: wsHref(workspaceId) },
    ...trail.map((f, i) => (i === trail.length - 1 ? { label: f.name } : { label: f.name, href: folderHref(workspaceId, f.id) })),
    ...(query.unfiled && !folderId ? [{ label: "Unfiled" }] : []),
  ];
  if (!folderId && !query.unfiled) crumbs[0] = { label: wsName };

  const title = folder?.name ?? (query.unfiled ? "Unfiled" : wsName);
  const address = host ? (folder ? `${host}/${folder.path}` : host) : null;
  const directCount = folder ? folder.item_count : tree?.unfiled_count ?? 0;
  const totalCount = folder ? folder.total_count : (tree?.unfiled_count ?? 0) + folders.filter((f) => !f.parent_id).reduce((n, f) => n + f.total_count, 0);
  const rootEmpty = !folderId && !!tree && tree.folders.length === 0 && tree.unfiled_count === 0;
  const countBits = [subfolders.length ? plural(subfolders.length, "folder") : null, plural(directCount, "item")].filter(Boolean).join(" · ");

  const newMenu: MenuEntry[] = [
    { label: "New document", icon: "lines", href: newDocHref, description: `Write markdown straight into ${folder ? `“${folder.name}”` : wsName}` },
    uploadTarget
      ? { label: "Upload", icon: "upload", onClick: pickFiles, description: "Videos, PDFs, pages and documents" }
      : { label: "Upload", icon: "upload", href: uploadHref, description: "Videos, PDFs, pages and documents" },
    {
      label: "New folder", icon: "folder", onClick: () => setNewFolderOpen(true), disabled: depthFull,
      description: depthFull ? `Folders nest at most ${MAX_FOLDER_DEPTH} deep` : folder ? `Inside “${folder.name}”` : undefined,
    },
    { label: "Add existing…", icon: "plus", separated: true, onClick: () => setAddOpen(true), description: "File something you already published" },
  ];

  const moreMenu: MenuEntry[] = [];
  if (folder && isAdmin) {
    moreMenu.push({ label: "Rename folder…", icon: "edit", onClick: () => setRenameFor(folder) });
    moreMenu.push({ label: "Move folder to…", icon: "folder", onClick: () => setMoveTarget({ kind: "folder", folder }) });
    moreMenu.push({ label: "New items start as…", icon: "user", onClick: () => setDefaultFor(folder) });
  }
  if (address) {
    moreMenu.push({ label: `Copy ${host} address`, icon: "copy", separated: moreMenu.length > 0, onClick: () => { void copyText(`https://${address}`).then((ok) => (ok ? toast.success("Address copied") : toast.error("Couldn't copy"))); } });
  }
  moreMenu.push({ label: "Workspace settings", icon: "settings", separated: true, href: `/settings/workspaces/${encodeURIComponent(workspaceId)}` });
  if (folder && isAdmin) moreMenu.push({ label: "Delete folder…", icon: "trash", danger: true, separated: true, onClick: () => setDeleteFor(folder) });

  const shareVisible = folder ? canShareFolders || isAdmin : isAdmin;

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      {isMember && !rootEmpty && (
        <Button variant="ghost" iconLeft="eye" onClick={openPreview}>Preview as</Button>
      )}
      {shareVisible && (
        <Button variant="secondary" iconLeft="link" onClick={() => setShareTab(folder && canShareFolders ? "link" : "invite")} aria-haspopup="dialog">Share</Button>
      )}
      {isMember && (
        <Dropdown
          aria-label="New"
          align="right"
          minWidth={280}
          trigger={<Button variant="primary" iconLeft="plus" iconRight="chevronDown">New</Button>}
          items={newMenu}
        />
      )}
      <Dropdown
        aria-label="More actions"
        minWidth={240}
        trigger={<IconButton icon="more" label={folder ? "More folder actions" : "More workspace actions"} variant="ghost" />}
        items={moreMenu}
      />
    </div>
  );

  /* ── Exposure ─────────────────────────────────────────────────────── */
  const serverExposure = folder ? folder.exposure : tree?.root_exposure;
  const exposure = serverExposure ?? (state === "ok" && !cursor && !query.q && !query.kind ? exposureOf(items) : null);
  const exposureTotal = exposure ? exposure.link + exposure.workspace + exposure.private : 0;
  const changeDefault = isAdmin
    ? folder ? () => setDefaultFor(folder) : () => router.push(`/settings/workspaces/${encodeURIComponent(workspaceId)}?tab=advanced`)
    : null;

  /* ── Get set up ───────────────────────────────────────────────────── */
  const { hidden: checklistHidden, hide: hideChecklist } = useChecklistHidden(workspaceId);
  const steps = [
    { title: "Name your workspace", hint: wsName, done: true },
    {
      title: "Invite your team", hint: "They can open everything the team can.",
      done: !!meta && (meta.member_count > 1 || meta.pending_invite_count > 0), cta: "Invite", onCta: () => setShareTab("invite"),
    },
    {
      title: "Add your first file", hint: "Drop it on the right, or write a document.",
      done: totalCount > 0, cta: "Upload", onCta: pickFiles,
    },
    {
      title: "Use your own domain", hint: "Optional. Links like docs.yourcompany.com/guides.",
      done: !!host || (meta?.domain_count ?? 0) > 0, cta: "Set up",
      onCta: () => router.push(`/settings/workspaces/${encodeURIComponent(workspaceId)}?tab=look`),
    },
  ];
  const showChecklist = !folderId && !query.unfiled && !query.q && isAdmin && checklistHidden === false && steps.some((s) => !s.done);

  /* ── Render ───────────────────────────────────────────────────────── */
  if (authLoading || !user) {
    return <ListSkeleton label="Loading" />;
  }

  if (wsMissing) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="md-visually-hidden">Workspace</h1>
        <EmptyState
          icon="users"
          title="This workspace isn't available"
          description="It may have been deleted, or you're no longer a member."
          actions={<Button variant="secondary" href="/dashboard">Go to My files</Button>}
        />
      </div>
    );
  }

  if (!tree && treeError) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="md-visually-hidden">{wsName}</h1>
        <Alert tone="danger" title="Couldn't load this workspace" actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={() => void reloadTree()}>Try again</Button>}>
          {treeError instanceof Error && treeError.message ? treeError.message : "Check your connection and try again."}
        </Alert>
      </div>
    );
  }

  if (folderMissing) {
    return (
      <div className="flex flex-col gap-6">
        <Breadcrumb items={[{ label: wsName, href: wsHref(workspaceId) }, { label: "Folder" }]} />
        <h1 className="md-visually-hidden">Folder not found</h1>
        <EmptyState
          icon="folder"
          title="This folder isn't here anymore"
          description="It may have been deleted or moved to another workspace. Its files weren't deleted."
          actions={<Button variant="secondary" href={wsHref(workspaceId)} iconLeft="arrowLeft">Back to {wsName}</Button>}
        />
      </div>
    );
  }

  if (query.preview && tree && isMember) {
    return (
      <PreviewMode
        workspaceId={workspaceId}
        workspaceName={wsName}
        team={team}
        folderId={folderId}
        folderName={here}
        address={address}
        as={query.preview}
        email={query.email}
        canEmail={isAdmin}
        onChangeAs={(as, email) => setQuery({ preview: as, email: as === "email" ? email ?? null : null })}
        onExit={() => setQuery({ preview: null, email: null })}
      />
    );
  }

  const searching = !!query.q;
  const filtered = searching || !!query.kind;
  const folderEmpty = state === "ok" && items.length === 0 && redacted.length === 0 && subfolders.length === 0 && !filtered;
  const parentHref = folder ? (folder.parent_id ? folderHref(workspaceId, folder.parent_id) : wsHref(workspaceId)) : "/dashboard";
  const parentName = folder ? (trail.length > 1 ? trail[trail.length - 2]!.name : wsName) : "My files";

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {/* ── Header ── */}
      {phone ? (
        <header className="-mx-4 -mt-6 flex items-center gap-1 border-b border-border bg-surface px-2 py-1.5">
          <IconButton icon="chevronLeft" label={`Back to ${parentName}`} href={parentHref} className="size-11" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-caption text-text-muted" dir="auto">{folder ? wsName : "Workspace"}</div>
            <h1 className="truncate text-h4 leading-5 text-text" dir="auto">{tree ? title : <Skeleton width={120} height={18} />}</h1>
          </div>
          <IconButton icon="search" label="Search" className="size-11" onClick={openCommandPalette} aria-haspopup="dialog" />
          {isMember && (
            <Dropdown aria-label="New" align="right" minWidth={240} trigger={<IconButton icon="plus" label="New" className="size-11" />} items={newMenu} />
          )}
          {shareVisible && (
            <IconButton icon="link" label={folder ? "Share folder" : "Share workspace"} className="size-11" onClick={() => setShareTab(folder && canShareFolders ? "link" : "invite")} aria-haspopup="dialog" />
          )}
        </header>
      ) : (
        <header className="flex min-w-0 flex-col gap-5">
          <Breadcrumb items={crumbs} className="min-w-0 flex-wrap" />
          <div className="flex min-w-0 flex-wrap items-start gap-4">
            <div className="flex min-w-0 flex-[1_1_360px] items-start gap-3.5">
              {folder ? (
                <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text">
                  <Icon name="folder" size={22} />
                </span>
              ) : meta ? (
                <WorkspaceTile ws={meta} active size={44} />
              ) : (
                <Skeleton variant="rect" width={44} height={44} />
              )}
              <div className="min-w-0">
                <h1 className="text-h1 text-text [overflow-wrap:anywhere]" dir="auto">{tree ? title : <Skeleton width={180} height={30} />}</h1>
                {tree && (
                  <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] leading-5 text-text-muted">
                    {rootEmpty ? (
                      <span>A shared home for your team&apos;s files and pages.</span>
                    ) : (
                      <>
                        <span>{countBits}</span>
                        {address && (
                          <>
                            <span aria-hidden>·</span>
                            <code className="max-w-full truncate rounded-sm bg-surface-inset px-1.5 py-px font-mono text-caption text-text-secondary">{address}</code>
                          </>
                        )}
                        {folder?.share && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="inline-flex items-center gap-1"><Icon name="link" size={12} />{folder.share.level === "link" ? "Folder link on" : `Shared with the ${team} team`}</span>
                          </>
                        )}
                        {!isMember && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="inline-flex items-center gap-1"><Icon name="eye" size={12} />Can view</span>
                          </>
                        )}
                      </>
                    )}
                  </p>
                )}
              </div>
            </div>
            {tree && toolbar}
          </div>
        </header>
      )}

      {/* ── Who can open what's in here ── */}
      {exposure && exposureTotal > 0 && !filtered && (
        <ExposureBar exposure={exposure} team={team} startsAs={isMember ? startsAs : null} onChange={changeDefault} phone={phone} />
      )}

      {/* ── Search / filter in the URL (from ⌘K or an old link) ── */}
      {filtered && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3.5 py-2.5 text-[13px] text-text-secondary" role="status">
          <Icon name={searching ? "search" : "filter"} size={14} />
          <span className="min-w-0 flex-1">
            {searching ? <>Results for <strong className="text-text">“{query.q}”</strong> in {wsName}</> : query.kind === "artifact" ? "Showing files only" : "Showing documents only"}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setQuery({ q: null, kind: null })}>{searching ? "Clear search" : "Show everything"}</Button>
        </div>
      )}

      {/* ── A new workspace: Get set up + the big drop zone ── */}
      {(showChecklist || (rootEmpty && !filtered)) && (
        <div className="flex min-w-0 flex-wrap items-start gap-5">
          {showChecklist && <SetupChecklist steps={steps} onHide={hideChecklist} />}
          {rootEmpty && isMember && (
            <DropArea target={uploadTarget} team={team} startsAs={startsAs} newDocHref={newDocHref} onNewFolder={() => setNewFolderOpen(true)} />
          )}
          {rootEmpty && !isMember && (
            <EmptyState icon="inbox" title="Nothing you can open here yet" description="When members add something you can open, it appears here." className="flex-1" />
          )}
        </div>
      )}

      {/* ── Folders ── */}
      {!searching && subfolders.length > 0 && (
        <section aria-labelledby="md-subfolders" className="flex min-w-0 flex-col gap-2.5">
          <h2 id="md-subfolders" className="text-eyebrow uppercase text-text-muted">Folders</h2>
          <ul className={cx("m-0 grid min-w-0 list-none gap-3 p-0", phone ? "grid-cols-1" : "grid-cols-[repeat(auto-fill,minmax(220px,1fr))]")}>
            {subfolders.map((f) => (
              <FolderCard
                key={f.id}
                workspaceId={workspaceId}
                folder={f}
                phone={phone}
                canDropItems={isMember}
                canDragFolders={isAdmin}
                blocked={isAdmin ? [...descendants(folders, f.id)] : []}
                onFiles={uploads && isMember ? (files) => uploads.upload(files, uploads.resolve(workspaceId, f.id, f.name)) : null}
              />
            ))}
          </ul>
        </section>
      )}

      {/* ── Selection bar ── */}
      {!phone && selected.size > 0 && (
        <div className="sticky top-16 z-10 flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-border-strong bg-surface-raised px-3 py-2 shadow-md" role="region" aria-label="Selection">
          <span className="text-body-strong text-text">{plural(selected.size, "item")} selected</span>
          <span className="flex-1" />
          <Button size="sm" variant="secondary" iconLeft="folder" onClick={() => setMoveTarget({
            kind: "items",
            slugs: selectedItems.filter((i) => i.can.move).map((i) => i.slug),
            label: plural(selectedItems.filter((i) => i.can.move).length, "item"),
            fromFolderId: searching ? undefined : folderId,
          })} disabled={!selectedItems.some((i) => i.can.move)}>Move to…</Button>
          {selectedItems.some((i) => i.can.unshare) && (
            <Button size="sm" variant="ghost" iconLeft="x" onClick={() => setRemoveFor(selectedItems.filter((i) => i.can.unshare))}>Remove from workspace</Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      {/* ── Items ── */}
      {state === "error" && (
        <Alert tone="danger" title="Couldn't load the items" actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={() => void load()}>Try again</Button>}>
          {itemsError || "Check your connection and try again."}
        </Alert>
      )}
      {state === "loading" && !rootEmpty && <ListSkeleton rows={4} label="Loading items" />}

      {folderEmpty && !rootEmpty && (
        isMember ? (
          <DropArea target={uploadTarget} team={team} startsAs={startsAs} newDocHref={newDocHref} onNewFolder={depthFull ? null : () => setNewFolderOpen(true)} title={folder ? `“${folder.name}” is empty` : "Drop files here"} />
        ) : (
          <EmptyState icon="folder" title="Nothing you can open here yet" description="When members add something you can open, it appears here." />
        )
      )}

      {state === "ok" && items.length === 0 && filtered && (
        <EmptyState
          icon="search"
          title={searching ? `Nothing matches “${query.q}”` : query.kind === "artifact" ? "No files here" : "No documents here"}
          description={searching ? `Search looks at titles and links across ${wsName}, in what you can open.` : undefined}
        />
      )}

      {state === "ok" && items.length > 0 && (
        <section aria-labelledby="md-items" className="flex min-w-0 flex-col gap-2">
          <div className="relative flex min-w-0 items-center gap-3">
            {!phone && movable.length > 1 && (
              <span className={cx("absolute top-1/2 -left-7 -translate-y-1/2 transition-opacity", selected.size ? "opacity-100" : "opacity-0 hover:opacity-100 focus-within:opacity-100")}>
                <Checkbox
                  aria-label="Select all"
                  checked={selected.size > 0 && selected.size === movable.length}
                  indeterminate={selected.size > 0 && selected.size < movable.length}
                  onChange={(e) => setSelected(e.target.checked ? new Set(movable.map((i) => i.slug)) : new Set())}
                />
              </span>
            )}
            <h2 id="md-items" className="text-eyebrow uppercase text-text-muted">{searching ? `Results in ${wsName}` : "Items"}</h2>
          </div>
          <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0" aria-labelledby="md-items">
            {items.map((it) => (
              <WorkspaceItemRow
                key={it.slug}
                item={it}
                workspaceId={workspaceId}
                team={team}
                phone={phone}
                showLocation={searching}
                selectable={!phone && it.can.move && movable.length > 1}
                selected={selected.has(it.slug)}
                selectionActive={selected.size > 0}
                onSelect={(on) => toggleSelect(it.slug, on)}
                dragSlugs={selected.has(it.slug) && selected.size > 1 ? [...selected].filter((s) => items.find((x) => x.slug === s)?.can.move) : [it.slug]}
                fromFolderId={searching ? undefined : folderId}
                menu={itemMenu(it)}
                onAccess={it.can.share ? () => setShareFor(it) : null}
                onSheet={() => setSheetFor(it)}
              />
            ))}
          </ul>
          {cursor && (
            <div className="flex justify-center pt-2">
              <Button variant="secondary" onClick={() => void loadMore()} loading={more}>Load more</Button>
            </div>
          )}
        </section>
      )}

      {/* Admins see that private items are filed here (not what they are), so they can take them out. */}
      {state === "ok" && redacted.length > 0 && (
        <section aria-labelledby="md-redacted" className="flex min-w-0 flex-col gap-2">
          <h2 id="md-redacted" className="text-eyebrow uppercase text-text-muted">Private items you can&apos;t open</h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {redacted.map((r) => (
              <li key={r.id_token} className="flex min-w-0 items-center gap-3 rounded-xl border border-dashed border-border bg-surface px-3.5 py-3">
                <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-active text-text-muted">
                  <Icon name="lock" size={18} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-body-strong text-text-secondary" dir="auto">Private item by {r.owner.name || "a member"}</span>
                  <span className="truncate text-caption text-text-muted">
                    Only people added can open it{searching && r.folder ? ` · in ${r.folder.name}` : ""}.
                  </span>
                </div>
                {r.can.unshare && (
                  <RowMenu
                    label={`Actions for the private item by ${r.owner.name || "a member"}`}
                    items={[{ label: "Remove from workspace", icon: "x", danger: true, onClick: () => setRemoveHidden(r) }]}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Drop hint ── */}
      {uploadTarget && !phone && !rootEmpty && !folderEmpty && state === "ok" && (
        <div className="flex items-center justify-center gap-2.5 rounded-2xl border-[1.5px] border-dashed border-border-strong p-4.5 text-[13px] text-text-muted">
          <Icon name="upload" size={18} />
          <span>Drop files anywhere on this page to add them to <strong className="font-semibold text-text">{here}</strong></span>
        </div>
      )}
      {!isMember && state === "ok" && (items.length > 0 || subfolders.length > 0) && (
        <p className="text-caption text-text-muted">You can view {wsName}. Ask an admin to let you edit if you need to add or move things.</p>
      )}

      {/* ── Page-wide drop overlay ── */}
      {fileOver && uploadTarget && (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-(--z-overlay) grid place-items-center bg-[color-mix(in_srgb,var(--bg)_70%,transparent)] p-6">
          <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-accent bg-surface px-10 py-8 text-center shadow-xl">
            <span className="grid size-14 place-items-center rounded-xl bg-accent-soft text-accent-text"><Icon name="upload" size={26} /></span>
            <p className="text-h3 text-text">Drop to add to {here}</p>
            <p className="text-body text-text-secondary">New items start as {accessLabel(startsAs, team)}</p>
          </div>
        </div>
      )}

      {/* ── Overlays ── */}
      <ConfirmDialog
        open={!!removeHidden}
        onClose={() => setRemoveHidden(null)}
        title={`Remove this private item from ${wsName}?`}
        body={<p className="text-body text-text-secondary">It goes back to {removeHidden?.owner.name || "its owner"}&apos;s files. Nothing is deleted, and nobody who could open it loses access.</p>}
        confirmLabel="Remove"
        onConfirm={async () => {
          const r = removeHidden;
          if (!r) return;
          try {
            await removeItems(workspaceId, [], [r.id_token]);
          } catch (e) {
            throw new Error(e instanceof Error && e.message ? e.message : "Couldn't remove it. Try again.");
          }
          setRemoveHidden(null);
          changed();
          toast.success(`Removed from ${wsName}`);
        }}
      />

      <NewFolderDialog
        open={newFolderOpen}
        workspaceId={workspaceId}
        parent={folder ? ({ id: folder.id, name: folder.name, path: folder.path.split("/") } as unknown as Folder) : null}
        onClose={() => setNewFolderOpen(false)}
        onCreated={(f) => {
          setNewFolderOpen(false);
          changed();
          toast.toast({ message: `Folder “${f.name}” created`, kind: "success", action: { label: "Open", onClick: () => router.push(folderHref(workspaceId, f.id)) } });
        }}
      />

      <AddExistingDialog
        open={addOpen}
        workspace={{ id: workspaceId, name: wsName }}
        folder={folder}
        onClose={() => setAddOpen(false)}
        onAdded={(n) => {
          setAddOpen(false);
          changed();
          documentsChanged();
          toast.success(`Added ${plural(n, "item")} to ${folder ? `“${folder.name}”` : wsName}`);
        }}
      />

      <RenameFolderDialog
        workspaceId={workspaceId}
        folder={renameFor}
        host={host}
        onClose={() => setRenameFor(null)}
        onRenamed={(name) => { setRenameFor(null); changed(); toast.success(`Renamed to “${name}”`); }}
      />

      <DeleteFolderDialog
        workspaceId={workspaceId}
        folder={deleteFor}
        tree={tree}
        onClose={() => setDeleteFor(null)}
        onDeleted={(f) => {
          setDeleteFor(null);
          changed();
          toast.success(`Deleted “${f.name}”. Nothing in it was deleted.`);
          if (f.id === folderId) router.replace(f.parent_id ? folderHref(workspaceId, f.parent_id) : wsHref(workspaceId));
        }}
      />

      <MoveToDialog
        workspace={{ id: workspaceId, name: wsName, branding: meta?.branding ?? ({} as Workspace["branding"]) }}
        tree={tree}
        target={moveTarget}
        onClose={() => setMoveTarget(null)}
        onMoved={(dest) => {
          const t = moveTarget;
          setMoveTarget(null);
          setSelected(new Set());
          changed();
          toast.success(`Moved ${t?.kind === "folder" ? `“${t.folder.name}”` : t?.slugs.length === 1 ? `“${t.label}”` : t?.label} to ${dest.label}`);
        }}
      />

      <ShareFolderDialog
        open={!!shareTab}
        workspaceId={workspaceId}
        workspaceName={wsName}
        team={team}
        folder={folder}
        itemCount={totalCount}
        startTab={shareTab ?? "link"}
        canInvite={isAdmin}
        canLink={canShareFolders}
        onClose={() => setShareTab(null)}
        onPreview={openPreview}
      />

      <FolderDefaultDialog
        workspaceId={workspaceId}
        folder={defaultFor}
        team={team}
        workspaceDefault={wsDefault}
        onClose={() => setDefaultFor(null)}
      />

      <RenameItemDialog
        target={renameItem}
        onClose={() => setRenameItem(null)}
        onRenamed={(t) => { setRenameItem(null); changed(); toast.success(`Renamed to “${t}”`); }}
      />

      <DeleteDocDialog
        doc={deleteItem ? toDocRow(deleteItem, workspaceId) : null}
        onClose={() => setDeleteItem(null)}
        onDeleted={() => { setDeleteItem(null); changed(); documentsChanged(); toast.success("Deleted"); }}
      />

      {sheetFor && (
        <ItemSheet
          open={!!sheetFor}
          onClose={() => setSheetFor(null)}
          title={itemTitle(sheetFor)}
          address={sheetFor.encrypted ? null : displayAddress(sheetFor.url)}
          actions={sheetActions(sheetFor)}
        />
      )}

      {shareFor && (
        <ShareDialog
          slug={shareFor.slug}
          documentId={shareFor.id ?? null}
          title={itemTitle(shareFor)}
          kind={shareFor.kind}
          shareUrl={shareFor.encrypted ? undefined : shareFor.url}
          location={{ workspaceId, folderId: shareFor.folder?.id ?? null }}
          onClose={() => setShareFor(null)}
          onChanged={() => { changed(); }}
        />
      )}

      <ConfirmDialog
        open={!!removeFor}
        onClose={() => setRemoveFor(null)}
        title={removeFor && removeFor.length === 1 ? `Remove “${itemTitle(removeFor[0]!)}” from ${wsName}?` : `Remove ${plural(removeFor?.length ?? 0, "item")} from ${wsName}?`}
        body={
          <div className="flex flex-col gap-2 text-body text-text-secondary">
            <p>{removeFor && removeFor.length === 1 ? "It goes back to its owner's files." : "They go back to their owners' files."} Nothing is deleted, and markdrop.in links keep working.</p>
            {removeFor?.some((i) => i.access === "workspace") && (
              <p>Anything open to the {team} team becomes “Only people added”.</p>
            )}
          </div>
        }
        confirmLabel="Remove"
        onConfirm={async () => {
          const list = removeFor ?? [];
          let res;
          try {
            res = await removeItems(workspaceId, list.map((i) => i.slug));
          } catch (e) {
            throw new Error(e instanceof Error && e.message ? e.message : "Couldn't remove it. Try again.");
          }
          setRemoveFor(null);
          setSelected(new Set());
          changed();
          documentsChanged();
          const priv = res.filter((r) => r.access_after === "private").length;
          toast.success(
            list.length === 1
              ? `Removed from ${wsName}${priv ? ". Only people added can open it now" : ""}`
              : `Removed ${plural(list.length, "item")} from ${wsName}${priv ? `; ${priv} now only for people added` : ""}`,
          );
        }}
      />
    </div>
  );
}

/* ── Folder card ─────────────────────────────────────────────────────── */

function exposureNote(f: TreeFolder): string {
  const e = f.exposure;
  if (!e) return "";
  if (e.link > 0) return ` · ${e.link} public`;
  if (e.workspace > 0 && e.private === 0) return " · team only";
  if (e.private > 0 && e.workspace === 0) return " · only people added";
  return "";
}

function FolderCard({
  workspaceId, folder: f, phone, canDropItems, canDragFolders, blocked, onFiles,
}: {
  workspaceId: string;
  folder: TreeFolder;
  phone: boolean;
  canDropItems: boolean;
  canDragFolders: boolean;
  blocked: string[];
  onFiles: ((files: File[]) => void) | null;
}) {
  const drop = useFolderDrop(`card:${f.id}`, canDropItems ? { workspaceId, folderId: f.id, label: f.name, acceptsFolders: canDragFolders } : null);
  const dragData: DragData | null = canDragFolders
    ? { type: "folder", workspaceId, folderId: f.id, label: f.name, parentId: f.parent_id, blocked }
    : null;
  const drag = useWorkspaceDraggable(`card:${f.id}`, dragData);
  const { active } = useWorkspaceDrag();
  const [fileOver, setFileOver] = useState(false);

  return (
    <li
      ref={(el) => { drop.setNodeRef(el); drag.setNodeRef(el); }}
      {...(drag.listeners ?? {})}
      onDragOver={(e) => { if (onFiles && hasFiles(e)) { e.preventDefault(); e.stopPropagation(); setFileOver(true); } }}
      onDragLeave={() => setFileOver(false)}
      onDrop={(e) => {
        if (!onFiles || !hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setFileOver(false);
        onFiles(Array.from(e.dataTransfer.files));
      }}
      className={cx(
        "relative flex min-w-0 items-center gap-3 rounded-xl border bg-surface shadow-sm transition-colors duration-(--duration-fast)",
        phone ? "px-3.5 py-3" : "px-4 py-3.5",
        drop.over || fileOver ? "border-accent bg-accent-soft ring-2 ring-accent" : active && drop.candidate ? "border-dashed border-border-strong" : "border-border hover:border-border-strong",
        drag.isDragging && "opacity-50",
      )}
    >
      <span aria-hidden className="flex shrink-0 text-accent-text"><Icon name="folder" size={phone ? 18 : 22} /></span>
      <span className="flex min-w-0 flex-1 flex-col">
        <Anchor
          href={folderHref(workspaceId, f.id)}
          draggable={false}
          className="md-focus min-w-0 truncate rounded-sm text-body-strong text-text no-underline after:absolute after:inset-0 after:content-[''] hover:underline hover:underline-offset-3"
          dir="auto"
        >
          {f.name}
        </Anchor>
        {!phone && (
          <span className="truncate text-caption text-text-muted">
            {plural(f.total_count, "item")}{exposureNote(f)}
            {f.share && <span className="md-visually-hidden">, shared by {f.share.level === "link" ? "link" : "the team"}</span>}
          </span>
        )}
      </span>
      {phone && <span className="shrink-0 text-caption text-text-muted">{f.total_count}</span>}
      {!phone && f.share && <Icon name="link" size={14} className="shrink-0 text-text-muted" aria-hidden />}
    </li>
  );
}

/* ── Item row ────────────────────────────────────────────────────────── */

function WorkspaceItemRow({
  item: it, workspaceId, team, phone, showLocation, selectable, selected, selectionActive, onSelect, dragSlugs, fromFolderId, menu, onAccess, onSheet,
}: {
  item: WorkspaceItem;
  workspaceId: string;
  team: string;
  phone: boolean;
  showLocation: boolean;
  selectable: boolean;
  selected: boolean;
  selectionActive: boolean;
  onSelect: (on: boolean) => void;
  dragSlugs: string[];
  fromFolderId: string | null | undefined;
  menu: MenuEntry[];
  onAccess: (() => void) | null;
  onSheet: () => void;
}) {
  const t = itemTitle(it);
  const drag = useWorkspaceDraggable(`item:${it.slug}`, it.can.move
    ? { type: "items", workspaceId, slugs: dragSlugs, label: dragSlugs.length > 1 ? plural(dragSlugs.length, "item") : t, fromFolderId }
    : null);
  const location = showLocation ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-surface-active px-1.5 text-micro text-text-secondary">
      <Icon name="folder" size={11} />
      <span className="max-w-32 truncate" dir="auto">{it.folder?.name ?? "Top level"}</span>
    </span>
  ) : null;

  return (
    <ItemRow
      file={{ slug: it.slug, kind: it.kind, mime: it.mime, renderer: it.renderer, original_filename: it.original_filename }}
      title={t}
      href={`/${it.slug}`}
      address={it.encrypted ? "Encrypted" : displayAddress(it.url)}
      views={it.views ?? 0}
      by={it.owner.is_you ? "You" : it.owner.name}
      when={it.updated_at}
      access={it.access}
      team={team}
      hasPassword={it.has_password}
      encrypted={!!it.encrypted}
      onAccess={onAccess}
      copy={it.encrypted ? null : it.url}
      menu={menu}
      menuLabel={`Actions for ${t}`}
      phone={phone}
      onSheet={onSheet}
      chip={location}
      rowRef={drag.setNodeRef}
      rowProps={{ ...(drag.listeners ?? {}), "aria-label": undefined } as React.HTMLAttributes<HTMLLIElement>}
      className={cx("group", selected && "!border-accent bg-accent-soft/40", drag.isDragging && "opacity-50")}
      leading={selectable ? (
        // In the gutter to the left of the row, so rows line up whether or not they can be selected.
        <span className={cx("absolute top-1/2 -left-7 -translate-y-1/2 transition-opacity", selectionActive || selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100")}>
          <Checkbox aria-label={`Select ${t}`} checked={selected} onChange={(e) => onSelect(e.target.checked)} />
        </span>
      ) : undefined}
    />
  );
}
