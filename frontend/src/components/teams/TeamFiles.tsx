"use client";

/**
 * A team's Files & pages (/w/<ws>/teams/<team>/pages; nav redesign 2026-11-18): the team's folder / page tree that
 * the sidebar used to show under each team — folders, pages with sub-pages, documents and files, drag and drop to
 * move, files dropped on a folder upload there — with archived folders ("Accounts (archived)") grouped in one
 * Archive row at the end. Meeting pages and the Meetings folders are not in it (the team's Meetings section), nor
 * the hidden deal folders (Deals); search still finds everything, and searching here lists the team's matches.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, EmptyState, Input, Skeleton, copyText, useToast, type MenuEntry } from "@/components/ui";
import { useAssistantHere } from "@/components/assistant/store";
import { TreeView, shareNodes, type TreeNode } from "@/components/workspace/FolderTree";
import { useUploads } from "@/components/workspace/uploads/UploadProvider";
import { can, listWorkspaceItems, type Workspace } from "@/lib/workspaces";
import { refreshTree, useWorkspaceTree } from "@/lib/workspaceStore";
import { navSlot, navTeamKey, useNavRetain } from "@/lib/navStore";
import { isFavorite, toggleFavorite, useFavorites, type Favorite, type FavoriteKind } from "@/lib/favorites";
import { browseHref, getTeamHome, teamHref, type TeamCard, type TeamItem } from "@/lib/teams";
import { useNotionImport } from "@/components/import/useNotionImport";
import { TeamTile } from "./parts";
import { Crumbs, ItemRow } from "./TeamHome";
import { teamFilesNodes, type FilesCtx } from "./filesTree";
import { MoveFolderDialog, type MoveFolderTarget } from "./MoveFolderDialog";
import "./teams.css";

const EXPANDED_KEY = "md_files_tree";
/** A tree row on the page: 36 px (44 px on touch); tree.css indents it and adds the guides. */
const ROW = "md-focus relative flex h-9 min-w-0 items-center gap-1.5 rounded-md pr-2 text-body text-text-secondary no-underline transition-colors duration-(--duration-fast) hover:bg-surface-hover hover:text-text pointer-coarse:h-11";
const ROW_ACTIVE = "font-semibold text-accent-text";

/** Which rows are open, remembered on this device. */
function useOpenRows(): [Set<string>, (key: string, open: boolean) => void] {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const loaded = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(EXPANDED_KEY);
      const keys = raw ? JSON.parse(raw) : null;
      if (Array.isArray(keys)) setOpen(new Set(keys.filter((k) => typeof k === "string").slice(0, 300)));
    } catch { /* storage off: all closed */ }
    loaded.current = true;
  }, []);
  useEffect(() => {
    if (!loaded.current) return;
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...open])); } catch { /* storage off */ }
  }, [open]);
  const toggle = useCallback((key: string, on: boolean) => setOpen((s) => {
    if (s.has(key) === on) return s;
    const n = new Set(s);
    if (on) n.add(key); else n.delete(key);
    return n;
  }), []);
  return [open, toggle];
}

export function TeamFiles({ ws: wsId, team: teamRef }: { ws: string; team: string }) {
  const [team, setTeam] = useState<TeamCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<TeamItem[] | null>(null);
  const [expanded, onToggle] = useOpenRows();
  const [wantPages, setWantPages] = useState<string[]>([]);
  const [moving, setMoving] = useState<MoveFolderTarget | null>(null);
  const toast = useToast();
  const uploads = useUploads();
  // Import from Notion into this team (General: the workspace's company-wide space). The dialog loads on first use.
  const notion = useNotionImport(team ? { workspace: wsId, team: team.general ? null : team.id } : undefined);
  useAssistantHere({ workspace: wsId });
  useEffect(() => {
    getTeamHome(wsId, teamRef).then((h) => setTeam(h.team)).catch((e) => setError(e instanceof Error ? e.message : "Couldn't load this team."));
  }, [wsId, teamRef]);

  const { tree, error: treeError } = useWorkspaceTree(wsId);
  useEffect(() => { refreshTree(wsId, 10_000); }, [wsId]);
  const navKey = team ? (team.general ? wsId : navTeamKey(wsId, team.id)) : null;
  const navVersion = useNavRetain(navKey ? [navKey] : [], wantPages);
  const favVersion = useFavorites(wsId, teamRef);
  const nav = navKey ? navSlot(navKey) : undefined;

  // Searching: the team's matches, as a flat list (the server searches titles and contents).
  useEffect(() => {
    const term = q.trim();
    if (!team || !term) { setFound(null); return; }
    const t = window.setTimeout(() => {
      listWorkspaceItems(wsId, { folder: "all", space: team.general ? "company" : `team:${team.id}`, q: term, limit: 50 })
        .then((r) => setFound(r.items)).catch(() => setFound([]));
    }, 250);
    return () => window.clearTimeout(t);
  }, [wsId, team, q]);

  const toastRef = useRef(toast);
  toastRef.current = toast;
  const copy = useCallback((href: string, label: string) => {
    void copyText(new URL(href, window.location.origin).toString())
      .then((ok) => (ok ? toastRef.current.success(`Link to “${label}” copied`) : toastRef.current.error("Couldn't copy")));
  }, []);
  const fav = useCallback((kind: FavoriteKind, ref: string, label: string, draft?: Partial<Favorite>): MenuEntry => {
    const on = isFavorite(wsId, kind, ref);
    return {
      label: on ? "Remove from favorites" : "Add to favorites", icon: "star",
      onClick: () => {
        toggleFavorite(wsId, kind, ref, !on, { title: label, ...draft }).then(
          () => toastRef.current.success(on ? `Removed “${label}” from favorites` : `Added “${label}” to favorites`),
          () => toastRef.current.error("Couldn't change your favorites"),
        );
      },
    };
  }, [wsId]);
  const onFiles = useMemo(
    () => (uploads ? (w: string, folderId: string | null, label: string, files: File[]) => uploads.upload(files, uploads.resolve(w, folderId, label)) : null),
    [uploads],
  );

  const prev = useRef(new Map<string, TreeNode>());
  const built = useMemo(() => {
    const want: string[] = [];
    if (!team || !tree || nav === undefined || nav === null || nav === false) return { nodes: null as TreeNode[] | null, want };
    const ws: Workspace = { id: wsId, name: tree.workspace.name, role: tree.workspace.role } as Workspace;
    const c: FilesCtx = { ws, member: can(tree.workspace.role, "member"), expanded, want, copy, fav, moveToTeam: setMoving };
    const fresh = teamFilesNodes(c, team, tree, nav, onFiles);
    const { nodes, byKey } = shareNodes(fresh, prev.current);
    prev.current = byKey;
    return { nodes, want: [...new Set(want)].sort() };
  }, [team, tree, nav, wsId, expanded, copy, fav, onFiles, navVersion, favVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const wantSig = built.want.join(",");
  useEffect(() => {
    setWantPages((w) => (w.join(",") === wantSig ? w : wantSig ? wantSig.split(",") : []));
  }, [wantSig]);

  if (error && !team) return <div className="tz-page"><Alert tone="danger">{error}</Alert></div>;
  const member = !!(team && (team.my_role || team.can_admin || team.general));
  const canWrite = member && !!tree && can(tree.workspace.role, "member");
  const newPage = team ? `/pages/new?workspace=${encodeURIComponent(wsId)}${team.general ? "" : `&team=${encodeURIComponent(team.id)}`}` : "#";
  const locked = team?.can_read === false;
  const failed = nav === false || (!!treeError && !tree);

  return (
    <div className="tz-page" data-testid="team-files">
      <Crumbs ws={wsId} trail={[{ label: "Teams", href: browseHref(wsId) }, ...(team ? [{ label: team.name, href: teamHref(wsId, team) }] : []), { label: "Files & pages" }]} />
      <header className="tz-head">
        <div className="tz-head__main">
          {team ? <TeamTile team={team} size={40} /> : <Skeleton width={40} height={40} variant="rect" />}
          <div className="tz-head__titles">
            <h1 className="tz-title">Files &amp; pages</h1>
            <p className="tz-sub">{team?.general
              ? "Pages, documents and files for everyone in the workspace. Meetings and deals have their own sections."
              : "This team's pages, documents and files. Meetings and deals have their own sections."}</p>
          </div>
        </div>
        {team && canWrite && (
          <div className="tz-actions">
            {uploads && team.general && (
              <Button variant="secondary" iconLeft="upload" onClick={() => uploads.pick(uploads.resolve(wsId, null, team.name))} data-testid="files-upload">Upload</Button>
            )}
            <Button variant="secondary" iconLeft="download" onClick={notion.open} title="Import from Notion" data-testid="files-import">Import</Button>
            <Button iconLeft="plus" href={newPage} data-testid="files-new-page">New page</Button>
          </div>
        )}
        {notion.dialog}
      </header>
      {locked ? <Alert tone="neutral" icon="lock">This is a private team. Only its members see its pages.</Alert> : (
        <>
          <div className="mb-3 max-w-md">
            <Input type="search" iconPrefix="search" value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={team ? `Search ${team.name}'s pages and files` : "Search"} aria-label="Search this team's pages and files" data-testid="files-search" />
          </div>
          <section className="tz-card tz-card--flush" aria-label="Files and pages">
            {q.trim() ? (
              found === null ? <div className="p-3"><Skeleton variant="rect" height={120} /></div>
                : found.length === 0 ? <EmptyState icon="search" title="Nothing matches" description={`No page or file in this team matches “${q.trim()}”.`} />
                  : <ul className="tz-rows" data-testid="files-results">{found.map((it) => <ItemRow key={it.slug} it={it} />)}</ul>
            ) : failed ? (
              <Alert tone="danger" className="m-2">Couldn&apos;t load the pages. Try again in a moment.</Alert>
            ) : built.nodes === null ? (
              <div className="flex flex-col gap-2 p-2" aria-busy="true">
                <span className="md-visually-hidden">Loading the pages</span>
                {["46%", "62%", "38%", "54%"].map((w) => <Skeleton key={w} width={w} height={14} />)}
              </div>
            ) : built.nodes.length === 0 ? (
              <EmptyState icon="doc" title="No pages yet"
                description={canWrite ? "Create a page, or upload files. Drop files here from your desktop." : "Nothing has been shared in this team yet."}
                actions={canWrite ? <Button iconLeft="plus" href={newPage}>New page</Button> : undefined} />
            ) : (
              <TreeView label={team ? `${team.name} files and pages` : "Files and pages"} nodes={built.nodes} expanded={expanded} onToggle={onToggle}
                current={null} itemClassName={ROW} activeClassName={ROW_ACTIVE} />
            )}
          </section>
        </>
      )}
      {team && tree && (
        <MoveFolderDialog ws={wsId} folder={moving} fromTeam={team} onClose={() => setMoving(null)} admin={can(tree.workspace.role, "admin")} />
      )}
    </div>
  );
}

export default TeamFiles;
