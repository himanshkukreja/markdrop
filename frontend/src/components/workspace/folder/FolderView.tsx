"use client";

/**
 * A workspace folder (P2): /w/<workspace> is the top level, /w/<workspace>/f/<folder> a folder.
 *
 * Breadcrumbs with names, then the folder's subfolders as cards, then its items as rows. What the
 * toolbar offers follows the caller's role and each row's `can` flags from the server; nothing is
 * offered that the API would refuse. Rows and folder cards drag onto folders (here or in the rail);
 * "Move to…" does the same from the keyboard or a phone.
 *
 * The list holds only what the caller can open (A1/D2). Other people's private documents aren't
 * hidden by this page; the server never sends them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert, Anchor, Badge, Breadcrumb, Button, Checkbox, ConfirmDialog, Dropdown, EmptyState, Icon, IconButton, Input, Kbd,
  SegmentedControl, Skeleton, copyText, cx, useToast, type MenuEntry,
} from "@/components/ui";
import { PageHeader } from "@/components/shell/PageHeader";
import { WorkspaceTile } from "@/components/shell/SideNav";
import { useLocationSearch, useMounted } from "@/components/shell/useLocation";
import ShareDialog from "@/components/access/ShareDialog";
import { DocRow, rowStatuses } from "@/components/dashboard/DocRow";
import RowMenu from "@/components/dashboard/RowMenu";
import { ListSkeleton } from "@/components/dashboard/ListParts";
import { plural } from "@/components/dashboard/format";
import { shouldHandleSlash, usePhone } from "@/components/dashboard/hooks";
import { NewFolderDialog } from "@/components/dashboard/DocDialogs";
import { useAuth } from "@/contexts/AuthContext";
import {
  can, errorStatus, listWorkspaceItems, listWorkspaces, removeItems,
  type RedactedItem, type TreeFolder, type Workspace, type WorkspaceItem,
} from "@/lib/workspaces";
import {
  ancestry, childrenMap, descendants, useWorkspaceChanged, useWorkspaceTree, workspaceChanged, documentsChanged,
} from "@/lib/workspaceStore";
import { useFolderDrop, useWorkspaceDraggable, useWorkspaceDrag, type DragData } from "../WorkspaceDnd";
import { AddExistingDialog, DeleteFolderDialog, MAX_FOLDER_DEPTH, MoveToDialog, RenameFolderDialog, type MoveTarget } from "./FolderDialogs";
import ShareFolderDialog from "./ShareFolderDialog";
import { displayAddress, itemTitle, toDocRow } from "./items";
import type { Folder } from "@/lib/workspaces";

type Kind = "" | "markdown" | "artifact";
const PAGE = 50;

const wsHref = (ws: string) => `/w/${encodeURIComponent(ws)}`;
const folderHref = (ws: string, f: string) => `/w/${encodeURIComponent(ws)}/f/${encodeURIComponent(f)}`;

function readQuery(search: string) {
  const p = new URLSearchParams(search);
  const k = p.get("kind");
  return {
    q: (p.get("q") || "").trim(),
    kind: (k === "markdown" || k === "artifact" ? k : "") as Kind,
    unfiled: p.get("filter") === "unfiled",
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

export default function FolderView({ workspaceId, folderId }: { workspaceId: string; folderId: string | null }) {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const phone = usePhone();
  const mounted = useMounted();
  const search = useLocationSearch();
  const urlReady = mounted && typeof window !== "undefined" && search === window.location.search;
  const query = useMemo(() => readQuery(search), [search]);

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
  const host = tree?.workspace.primary_host ?? meta?.primary_host ?? null;
  const canShareFolders = isAdmin || (isMember && meta?.settings?.members_can_share_folders !== false);

  const folders = useMemo(() => tree?.folders ?? [], [tree]);
  const folder = folderId ? folders.find((f) => f.id === folderId) ?? null : null;
  const trail = useMemo(() => ancestry(folders, folderId), [folders, folderId]);
  const subfolders = useMemo(
    () => (query.unfiled ? [] : childrenMap(folders).get(folderId ?? null) ?? []),
    [folders, folderId, query.unfiled],
  );
  const folderMissing = !!folderId && !!tree && !folder;
  const wsMissing = !tree && !!treeError && [403, 404].includes(errorStatus(treeError));

  /* ── URL-driven search and kind ───────────────────────────────────── */
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

  const searchRef = useRef<HTMLInputElement>(null);
  const [qInput, setQInput] = useState("");
  const typing = useRef(false);
  useEffect(() => {
    if (!urlReady) return;
    if (document.activeElement !== searchRef.current || !typing.current) setQInput(query.q);
  }, [urlReady, query.q]);
  useEffect(() => {
    if (!urlReady || !typing.current) return;
    const t = setTimeout(() => {
      typing.current = false;
      if (qInput.trim() !== query.q) setQuery({ q: qInput.trim() || null });
    }, 300);
    return () => clearTimeout(t);
  }, [qInput, urlReady, query.q, setQuery]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shouldHandleSlash(e)) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
  // Anything that changes this workspace (here, in the rail, in a dialog) reloads the rows quietly.
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
  const [shareFolderFor, setShareFolderFor] = useState<TreeFolder | null>(null);
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [shareFor, setShareFor] = useState<WorkspaceItem | null>(null);
  const [removeFor, setRemoveFor] = useState<WorkspaceItem[] | null>(null);
  const [removeHidden, setRemoveHidden] = useState<RedactedItem | null>(null);

  const changed = useCallback(() => { workspaceChanged(workspaceId); }, [workspaceId]);

  const here = folder ? `“${folder.name}”` : `the top of ${wsName}`;
  const newDocHref = `/new?ws=${encodeURIComponent(workspaceId)}${folderId ? `&folder=${encodeURIComponent(folderId)}` : ""}`;
  const uploadHref = `/upload?ws=${encodeURIComponent(workspaceId)}${folderId ? `&folder=${encodeURIComponent(folderId)}` : ""}`;
  const depthFull = !!folder && folder.depth + 1 >= MAX_FOLDER_DEPTH;

  /* ── Row menus ────────────────────────────────────────────────────── */
  function itemMenu(it: WorkspaceItem): MenuEntry[] {
    const t = itemTitle(it);
    const out: MenuEntry[] = [{ label: "Open", icon: "external", href: `/${it.slug}` }];
    if (phone) {
      out.push({ label: "Copy link", icon: "copy", onClick: () => { void copyText(it.url).then((ok) => (ok ? toast.success("Link copied") : toast.error("Couldn't copy the link"))); } });
    }
    if (it.can.edit && it.kind === "markdown" && !it.encrypted) out.push({ label: "Edit", icon: "edit", href: `/${it.slug}?edit=1` });
    const second: MenuEntry[] = [];
    if (it.can.share) second.push({ label: "Share…", icon: "user", onClick: () => setShareFor(it) });
    if (it.can.move) second.push({ label: "Move to…", icon: "folder", onClick: () => setMoveTarget({ kind: "items", slugs: [it.slug], label: t, fromFolderId: it.folder?.id ?? null }) });
    if (second.length) out.push({ ...second[0]!, separated: true } as MenuEntry, ...second.slice(1));
    if (it.can.unshare) out.push({ label: `Remove from ${wsName}`, icon: "x", danger: true, separated: true, onClick: () => setRemoveFor([it]) });
    return out;
  }

  function folderMenu(f: TreeFolder): MenuEntry[] {
    const out: MenuEntry[] = [{ label: "Open", icon: "folder", href: folderHref(workspaceId, f.id) }];
    if (canShareFolders) out.push({ label: f.share ? "Sharing…" : "Share…", icon: "link", onClick: () => setShareFolderFor(f) });
    if (isAdmin) {
      out.push({ label: "Rename…", icon: "edit", separated: true, onClick: () => setRenameFor(f) });
      out.push({ label: "Move to…", icon: "folder", onClick: () => setMoveTarget({ kind: "folder", folder: f }) });
      out.push({ label: "Delete folder…", icon: "trash", danger: true, separated: true, onClick: () => setDeleteFor(f) });
    }
    return out;
  }

  /* ── Header ───────────────────────────────────────────────────────── */
  const crumbs = [
    ...(folder || query.unfiled ? [] : [{ label: "Workspaces", href: "/settings/workspaces" }]),
    { label: wsName, href: wsHref(workspaceId) },
    ...trail.map((f) => ({ label: f.name, href: folderHref(workspaceId, f.id) })),
    ...(query.unfiled && !folderId ? [{ label: "Unfiled" }] : []),
  ];

  const title = folder?.name ?? (query.unfiled ? "Unfiled" : wsName);
  const address = host ? (folder ? `${host}/${folder.path}` : host) : null;
  const directCount = folder ? folder.item_count : tree?.unfiled_count ?? 0;
  const countLine = tree
    ? [
        subfolders.length ? plural(subfolders.length, "folder") : null,
        `${plural(directCount, "item")}${!folder && subfolders.length ? " at the top level" : ""}`,
      ].filter(Boolean).join(" · ")
    : null;

  const newMenu: MenuEntry[] = [
    { label: "New document", icon: "lines", href: newDocHref, description: `Write markdown and publish it into ${here}` },
    { label: "Upload a file", icon: "upload", href: uploadHref, description: "HTML, PDF, sheet, video and more" },
    { label: "Add existing…", icon: "plus", onClick: () => setAddOpen(true), description: "File something you already published" },
    {
      label: "New folder", icon: "folder", separated: true, onClick: () => setNewFolderOpen(true), disabled: depthFull,
      description: depthFull ? `Folders nest at most ${MAX_FOLDER_DEPTH} deep` : folder ? `Inside “${folder.name}”` : undefined,
    },
  ];

  const moreMenu: MenuEntry[] = [];
  if (folder && isAdmin) {
    moreMenu.push({ label: "Rename…", icon: "edit", onClick: () => setRenameFor(folder) });
    moreMenu.push({ label: "Move to…", icon: "folder", onClick: () => setMoveTarget({ kind: "folder", folder }) });
  }
  if (address) {
    moreMenu.push({ label: `Copy ${host} address`, icon: "copy", separated: moreMenu.length > 0, onClick: () => { void copyText(`https://${address}`).then((ok) => (ok ? toast.success("Address copied") : toast.error("Couldn't copy"))); } });
  }
  moreMenu.push({ label: "Workspace settings", icon: "settings", separated: true, href: `/settings/workspaces/${encodeURIComponent(workspaceId)}` });
  if (folder && isAdmin) moreMenu.push({ label: "Delete folder…", icon: "trash", danger: true, separated: true, onClick: () => setDeleteFor(folder) });

  const actions = (
    <>
      {isMember && (
        <Dropdown
          aria-label="Create"
          align="left"
          minWidth={280}
          trigger={<Button variant="primary" iconLeft="plus" iconRight="chevronDown" className="max-sm:h-11">New</Button>}
          items={newMenu}
        />
      )}
      {folder && canShareFolders && (
        <Button variant="secondary" iconLeft={folder.share ? "link" : "share"} className="max-sm:h-11" onClick={() => setShareFolderFor(folder)}>
          Share
        </Button>
      )}
      <Dropdown
        aria-label="More folder actions"
        minWidth={240}
        trigger={<IconButton icon="more" label="More folder actions" variant="secondary" className="max-sm:size-11" />}
        items={moreMenu}
      />
    </>
  );

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
          actions={<Button variant="secondary" href="/dashboard">Go to your documents</Button>}
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
          description="It may have been deleted or moved to another workspace. Its documents weren't deleted."
          actions={<Button variant="secondary" href={wsHref(workspaceId)} iconLeft="arrowLeft">Back to {wsName}</Button>}
        />
      </div>
    );
  }

  const searching = !!query.q;
  const empty = state === "ok" && items.length === 0 && redacted.length === 0 && subfolders.length === 0 && !searching && !query.kind;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        breadcrumb={<Breadcrumb items={crumbs} className="min-w-0 flex-wrap" />}
        leading={
          folder ? (
            <span aria-hidden className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text">
              <Icon name="folder" size={20} />
            </span>
          ) : meta ? (
            <span aria-hidden className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-surface [&>span]:size-6 [&>span]:text-body">
              <WorkspaceTile ws={meta} />
            </span>
          ) : undefined
        }
        title={tree ? title : <Skeleton width={180} height={28} />}
        description={
          tree ? (
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-text-muted">
              {countLine && <span>{countLine}</span>}
              {folder?.share && (
                <Badge size="sm" tone="info" icon="link">{folder.share.level === "link" ? "Shared by link" : `Shared with ${wsName}`}</Badge>
              )}
              {!isMember && <Badge size="sm" variant="outline" icon="eye">View only</Badge>}
              {address && (
                <span className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-caption text-text-secondary">
                  <Icon name="globe" size={12} className="shrink-0" />
                  <span className="truncate">{address}</span>
                </span>
              )}
            </span>
          ) : undefined
        }
        actions={tree && !phone ? actions : undefined}
      />

      {/* Phones: the toolbar gets its own row, so the title keeps the width. */}
      {phone && tree && (
        <div className="flex min-w-0 items-center gap-2 [&>*:not(:last-child)]:flex-1 [&>*:not(:last-child)_button]:w-full [&>*:last-child]:shrink-0">
          {actions}
        </div>
      )}

      {/* Search + kind */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div role="search" className="min-w-0 flex-[1_1_16rem]">
          <Input
            ref={searchRef}
            type="search"
            size={phone ? "md" : "sm"}
            iconPrefix="search"
            iconSuffix={!phone && !qInput ? <Kbd>/</Kbd> : undefined}
            value={qInput}
            onChange={(e) => { typing.current = true; setQInput(e.target.value); }}
            onKeyDown={(e) => { if (e.key === "Escape" && qInput) { e.preventDefault(); typing.current = false; setQInput(""); setQuery({ q: null }); } }}
            placeholder={`Search ${wsName}`}
            aria-label={`Search ${wsName}`}
            aria-keyshortcuts="/"
            maxLength={200}
            className="w-full"
            wrapClassName="w-full"
          />
        </div>
        <SegmentedControl<Kind>
          aria-label="Kind"
          size="sm"
          value={query.kind}
          onChange={(v) => setQuery({ kind: v || null })}
          options={[{ value: "", label: "All" }, { value: "markdown", label: "Documents" }, { value: "artifact", label: "Files" }]}
        />
      </div>

      {/* Subfolders */}
      {!searching && subfolders.length > 0 && (
        <section aria-labelledby="md-subfolders" className="flex min-w-0 flex-col gap-2">
          <h2 id="md-subfolders" className="text-eyebrow uppercase text-text-muted">Folders</h2>
          <ul className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {subfolders.map((f) => (
              <FolderCard
                key={f.id}
                workspaceId={workspaceId}
                folder={f}
                subCount={(childrenMap(folders).get(f.id) ?? []).length}
                menu={folderMenu(f)}
                canDropItems={isMember}
                canDragFolders={isAdmin}
                blocked={isAdmin ? [...descendants(folders, f.id)] : []}
              />
            ))}
          </ul>
        </section>
      )}

      {/* Selection bar */}
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
            <Button size="sm" variant="ghost" iconLeft="x" onClick={() => setRemoveFor(selectedItems.filter((i) => i.can.unshare))}>Remove from {wsName}</Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      {/* Items */}
      {state === "error" && (
        <Alert tone="danger" title="Couldn't load the items" actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={() => void load()}>Try again</Button>}>
          {itemsError || "Check your connection and try again."}
        </Alert>
      )}
      {state === "loading" && <ListSkeleton rows={4} label="Loading items" />}

      {empty && (
        <EmptyState
          icon={folder ? "folder" : "inbox"}
          title={folder ? `“${folder.name}” is empty` : query.unfiled ? "Nothing at the top level" : isMember ? `Nothing in ${wsName} yet` : "Nothing you can open here yet"}
          description={
            isMember
              ? `Publish a document or upload a file straight into ${here}, or add something you've already published.${tree && tree.folders.length ? " You can also drag items onto a folder in the sidebar." : ""}`
              : "When members publish something you can open, it appears here."
          }
          actions={isMember ? (
            <div className="flex max-w-full flex-wrap justify-center gap-2">
              <Button variant="primary" iconLeft="lines" href={newDocHref}>New document</Button>
              <Button variant="secondary" iconLeft="upload" href={uploadHref}>Upload a file</Button>
              <Button variant="ghost" iconLeft="plus" onClick={() => setAddOpen(true)}>Add existing</Button>
            </div>
          ) : undefined}
        />
      )}

      {state === "ok" && items.length === 0 && (searching || query.kind) && (
        <EmptyState
          icon="search"
          title={searching ? `Nothing matches “${query.q}”` : query.kind === "artifact" ? "No files here" : "No documents here"}
          description={searching ? `Search looks at titles and links across ${wsName}, in what you can open.` : undefined}
          actions={searching ? <Button variant="secondary" onClick={() => { setQInput(""); setQuery({ q: null }); }}>Clear search</Button> : <Button variant="secondary" onClick={() => setQuery({ kind: null })}>Show everything</Button>}
        />
      )}

      {state === "ok" && items.length > 0 && (
        <section aria-labelledby="md-items" className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 items-center gap-3">
            {!phone && movable.length > 0 && (
              <Checkbox
                aria-label="Select all"
                checked={selected.size > 0 && selected.size === movable.length}
                indeterminate={selected.size > 0 && selected.size < movable.length}
                onChange={(e) => setSelected(e.target.checked ? new Set(movable.map((i) => i.slug)) : new Set())}
                className="ml-4"
              />
            )}
            <h2 id="md-items" className="text-eyebrow uppercase text-text-muted">
              {searching ? `Results in ${wsName}` : "Items"}
            </h2>
          </div>
          <ul className="flex min-w-0 flex-col gap-2" aria-labelledby="md-items">
            {items.map((it) => (
              <ItemRow
                key={it.slug}
                item={it}
                workspaceId={workspaceId}
                phone={phone}
                showLocation={searching}
                selectable={!phone && it.can.move}
                selected={selected.has(it.slug)}
                selectionActive={selected.size > 0}
                onSelect={(on) => toggleSelect(it.slug, on)}
                dragSlugs={selected.has(it.slug) && selected.size > 1 ? [...selected].filter((s) => items.find((x) => x.slug === s)?.can.move) : [it.slug]}
                fromFolderId={searching ? undefined : folderId}
                menu={itemMenu(it)}
                onAccess={it.can.share ? () => setShareFor(it) : null}
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

      {/* Admins see that private documents are filed here (not what they are), so they can unshare them. */}
      {state === "ok" && redacted.length > 0 && (
        <section aria-labelledby="md-redacted" className="flex min-w-0 flex-col gap-2">
          <h2 id="md-redacted" className="text-eyebrow uppercase text-text-muted">Private documents you can&apos;t open</h2>
          <ul className="flex min-w-0 flex-col gap-2">
            {redacted.map((r) => (
              <li key={r.id_token} className="md-docrow min-w-0 border-dashed">
                <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-active text-text-muted">
                  <Icon name="lock" size={18} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-body-strong text-text-secondary" dir="auto">Private document by {r.owner.name || "a member"}</span>
                  <span className="truncate text-caption text-text-muted">
                    Only its owner and the people they named can open it{searching && r.folder ? ` · in ${r.folder.name}` : ""}.
                  </span>
                </div>
                {r.can.unshare && (
                  <RowMenu
                    label={`Actions for the private document by ${r.owner.name || "a member"}`}
                    items={[{ label: `Remove from ${wsName}`, icon: "x", danger: true, onClick: () => setRemoveHidden(r) }]}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {state === "ok" && (items.length > 0 || subfolders.length > 0) && (
        <p className="text-caption text-text-muted">
          {isMember
            ? `Listed: what you can open. Things other people keep private in ${wsName} aren't shown to you.${!phone && movable.length ? " Drag items onto a folder to move them." : ""}`
            : `You can view ${wsName}. Ask an admin for member access to add or move things.`}
        </p>
      )}

      <ConfirmDialog
        open={!!removeHidden}
        onClose={() => setRemoveHidden(null)}
        title={`Remove this private document from ${wsName}?`}
        body={<p className="text-body text-text-secondary">It goes back to {removeHidden?.owner.name || "its owner"}&apos;s personal documents. Nothing is deleted, and nobody who could open it loses access.</p>}
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

      {/* ── Overlays ── */}
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
        workspaceId={workspaceId}
        workspaceName={wsName}
        folder={shareFolderFor}
        onClose={() => setShareFolderFor(null)}
      />

      {shareFor && (
        <ShareDialog
          slug={shareFor.slug}
          documentId={shareFor.id ?? null}
          title={itemTitle(shareFor)}
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
            <p>{removeFor && removeFor.length === 1 ? "It goes back to its owner's personal documents." : "They go back to their owners' personal documents."} Nothing is deleted, and markdrop.in links keep working.</p>
            {removeFor?.some((i) => i.access === "workspace") && (
              <p>Anything open to “Everyone in {wsName}” becomes private (only its owner and people they named).</p>
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
              ? `Removed from ${wsName}${priv ? ". It's private now" : ""}`
              : `Removed ${plural(list.length, "item")} from ${wsName}${priv ? `; ${priv} now private` : ""}`,
          );
        }}
      />
    </div>
  );
}

/* ── Folder card ─────────────────────────────────────────────────────── */

function FolderCard({
  workspaceId, folder: f, subCount, menu, canDropItems, canDragFolders, blocked,
}: {
  workspaceId: string;
  folder: TreeFolder;
  subCount: number;
  menu: MenuEntry[];
  canDropItems: boolean;
  canDragFolders: boolean;
  blocked: string[];
}) {
  const drop = useFolderDrop(`card:${f.id}`, canDropItems ? { workspaceId, folderId: f.id, label: f.name, acceptsFolders: canDragFolders } : null);
  const dragData: DragData | null = canDragFolders
    ? { type: "folder", workspaceId, folderId: f.id, label: f.name, parentId: f.parent_id, blocked }
    : null;
  const drag = useWorkspaceDraggable(`card:${f.id}`, dragData);
  const { active } = useWorkspaceDrag();

  return (
    <li
      ref={(el) => { drop.setNodeRef(el); drag.setNodeRef(el); }}
      {...(drag.listeners ?? {})}
      className={cx(
        "group relative flex min-h-16 min-w-0 items-center gap-3 rounded-xl border bg-surface px-3 py-2.5 transition-colors duration-(--duration-fast)",
        drop.over ? "border-accent bg-accent-soft ring-2 ring-accent" : active && drop.candidate ? "border-dashed border-border-strong" : "border-border hover:border-border-strong",
        drag.isDragging && "opacity-50",
      )}
    >
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text">
        <Icon name="folder" size={18} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <Anchor
          href={folderHref(workspaceId, f.id)}
          draggable={false}
          className="md-focus min-w-0 truncate rounded-sm text-body-strong text-text no-underline after:absolute after:inset-0 after:content-[''] hover:underline hover:underline-offset-3"
          dir="auto"
        >
          {f.name}
        </Anchor>
        <span className="flex min-w-0 items-center gap-1.5 truncate text-caption text-text-muted">
          <span>{plural(f.total_count, "item")}</span>
          {subCount > 0 && <><span aria-hidden>·</span><span>{plural(subCount, "folder")}</span></>}
          {f.share && (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1"><Icon name="link" size={12} />{f.share.level === "link" ? "Link" : "Members"}</span>
            </>
          )}
        </span>
      </span>
      <span className="relative z-[1] shrink-0">
        <RowMenu items={menu} label={`Actions for ${f.name}`} />
      </span>
    </li>
  );
}

/* ── Item row ────────────────────────────────────────────────────────── */

function ItemRow({
  item: it, workspaceId, phone, showLocation, selectable, selected, selectionActive, onSelect, dragSlugs, fromFolderId, menu, onAccess,
}: {
  item: WorkspaceItem;
  workspaceId: string;
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
}) {
  const t = itemTitle(it);
  const doc = useMemo(() => toDocRow(it, workspaceId), [it, workspaceId]);
  const drag = useWorkspaceDraggable(`item:${it.slug}`, it.can.move
    ? { type: "items", workspaceId, slugs: dragSlugs, label: dragSlugs.length > 1 ? plural(dragSlugs.length, "item") : t, fromFolderId }
    : null);
  const by = it.owner.is_you ? "You" : it.owner.name;
  const meta = (
    <>
      {by && <><span aria-hidden> · </span><span>{by}</span></>}
    </>
  );
  const location = showLocation ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-surface-active px-1.5 text-micro text-text-secondary">
      <Icon name="folder" size={11} />
      <span className="max-w-32 truncate" dir="auto">{it.folder?.name ?? "Top level"}</span>
    </span>
  ) : null;

  return (
    <DocRow
      doc={doc}
      title={t}
      href={`/${it.slug}`}
      address={displayAddress(it.url)}
      extraMeta={meta}
      statuses={rowStatuses(doc, false)}
      onAccess={onAccess}
      copy={it.encrypted ? null : { text: it.url }}
      menu={menu}
      phone={phone}
      menuLabel={`Actions for ${t}`}
      chip={location}
      rowRef={drag.setNodeRef}
      rowProps={{ ...(drag.listeners ?? {}), "aria-label": undefined } as React.HTMLAttributes<HTMLLIElement>}
      className={cx("group", selected && "!border-accent bg-accent-soft/40", drag.isDragging && "opacity-50")}
      leading={selectable ? (
        <span className={cx("-ml-1 shrink-0 transition-opacity", selectionActive || selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100")}>
          <Checkbox aria-label={`Select ${t}`} checked={selected} onChange={(e) => onSelect(e.target.checked)} />
        </span>
      ) : undefined}
    />
  );
}
