"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button, Drawer, IconButton, cx } from "@/components/ui";
import { ThemeSegmented } from "@/components/theme/ThemeSegmented";
import { openFeedback, FeedbackDialog } from "@/components/FeedbackWidget";
import { useAuth } from "@/contexts/AuthContext";
import { listApiTokens } from "@/lib/api";
import { listSharedWithMe } from "@/lib/me";
import { LIGHT_ENABLED } from "@/lib/theme";
import { can, listWorkspaces, WORKSPACES_EVENT, type ItemAccess } from "@/lib/workspaces";
import { ancestry, peekTree, useWorkspaceTree } from "@/lib/workspaceStore";
import { WorkspaceDndProvider } from "@/components/workspace/WorkspaceDnd";
import { UploadProvider, useUploads } from "@/components/workspace/uploads/UploadProvider";
import { teamName } from "@/components/workspace/folder/items";
import { UserAvatar } from "./AccountMenu";
import CommandPalette, { type PaletteAction } from "./CommandPalette";
import { sendFolderCommand, usePaletteRequests } from "./commands";
import { SideNav, railKeyFor, workspaceOfKey, wsFolderKey, wsRootKey, type RailData } from "./SideNav";
import { useLocationSearch } from "./useLocation";

const LABELS: Record<string, string> = {
  files: "My files",
  shared: "Shared with me",
  recent: "Recent",
  "ws:new": "Workspaces",
  "int:vscode": "API tokens",
  "int:apps": "Connected apps",
  settings: "Settings",
};

/**
 * Loads the rail's data lazily and tolerantly: workspaces, the token count and how many shares are
 * new. A workspace's folder tree comes from the shared tree store (lib/workspaceStore), loaded only
 * when it is expanded (the API has a burst limit) and refreshed whenever anything changes it. Any
 * failure just leaves that part of the rail without numbers.
 */
function useRailData(userId: string | null) {
  const [data, setData] = useState<RailData>({});

  useEffect(() => {
    setData({});
    if (!userId) return;
    let live = true;
    const loadWorkspaces = () =>
      listWorkspaces()
        .then((ws) => live && setData((d) => ({ ...d, workspaces: ws })))
        .catch(() => {});
    void loadWorkspaces();
    // A workspace made, renamed, joined or deleted on any screen shows up here without a reload.
    window.addEventListener(WORKSPACES_EVENT, loadWorkspaces);
    listApiTokens()
      .then((t) => live && setData((d) => ({ ...d, tokens: t.length })))
      .catch(() => {});
    listSharedWithMe()
      .then((r) => live && setData((d) => ({ ...d, sharedNew: r.new_count })))
      .catch(() => {});
    return () => {
      live = false;
      window.removeEventListener(WORKSPACES_EVENT, loadWorkspaces);
    };
  }, [userId]);

  return data;
}

const EXPANDED_KEY = "md_rail_tree";

/** Which tree nodes are open, remembered on this device (REVAMP P2 "persisted expand state"). */
function useExpanded() {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const loaded = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(EXPANDED_KEY);
      if (raw) {
        const keys = JSON.parse(raw);
        if (Array.isArray(keys)) setExpanded((s) => new Set([...s, ...keys.filter((k) => typeof k === "string").slice(0, 200)]));
      }
    } catch { /* storage unavailable: start collapsed */ }
    loaded.current = true;
  }, []);
  useEffect(() => {
    if (!loaded.current) return;
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded])); } catch { /* ignore */ }
  }, [expanded]);
  const setOpen = useCallback((key: string, open: boolean) => {
    setExpanded((s) => {
      if (s.has(key) === open) return s;
      const n = new Set(s);
      if (open) n.add(key);
      else n.delete(key);
      return n;
    });
  }, []);
  const openAll = useCallback((keys: string[]) => {
    setExpanded((s) => (keys.every((k) => s.has(k)) ? s : new Set([...s, ...keys])));
  }, []);
  return { expanded, setOpen, openAll };
}

/** Wide pages (the drive views) get the Main board's 960px column; settings keep 880. */
const WIDE = /^\/(w\/|shared$|recent$)/;

/**
 * The account shell for /dashboard, /w/*, /shared, /recent and /settings/* (simpler UI, Main
 * board): a 248px rail, sticky under the 56px header, beside the content column holding
 * <main id="main">. Below 1024px the rail becomes a left Drawer opened by the "Browse" button in a
 * slim bar above the content. It also hosts the two app-wide tools: the ⌘K palette and the
 * drop-to-upload manager.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/";
  const search = useLocationSearch();
  const { user, logout } = useAuth();
  const active = railKeyFor(pathname, search);
  const activeWs = workspaceOfKey(active);

  const { expanded, setOpen, openAll } = useExpanded();
  const activeTree = useWorkspaceTree(activeWs).tree;
  const activeFolderId = active?.split(":folder:")[1];
  // The workspace you are in opens itself, and so does every folder above the one you're in.
  useEffect(() => {
    if (!activeWs) return;
    const keys = [wsRootKey(activeWs)];
    if (activeTree && activeFolderId) {
      for (const f of ancestry(activeTree.folders, activeFolderId).slice(0, -1)) keys.push(wsFolderKey(activeWs, f.id));
    }
    openAll(keys);
  }, [activeWs, activeTree, activeFolderId, openAll]);

  const data = useRailData(user?.id ?? null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  useEffect(() => setBrowseOpen(false), [pathname, search]);

  const feedback = () => {
    setBrowseOpen(false);
    if (!openFeedback()) setFeedbackOpen(true);
  };

  const workspaces = data.workspaces;
  // The effective default for an upload target: the folder's own, else the workspace's.
  const resolveAccess = useCallback((wsId: string, folderId: string | null): ItemAccess => {
    const tree = peekTree(wsId);
    const f = folderId ? tree?.folders.find((x) => x.id === folderId) : null;
    const ws = workspaces?.find((w) => w.id === wsId);
    return f?.effective_default_access ?? ws?.default_access ?? ws?.settings?.default_access ?? "workspace";
  }, [workspaces]);

  let activeLabel = active ? LABELS[active] : undefined;
  if (!activeLabel && activeWs) {
    const ws = data.workspaces?.find((w) => w.id === activeWs);
    if (ws) {
      const folder = activeFolderId ? activeTree?.folders.find((f) => f.id === activeFolderId) : undefined;
      activeLabel = folder ? `${ws.name} / ${folder.name}` : active?.endsWith(":settings") ? `${ws.name} settings` : ws.name;
    }
  }

  return (
    <UploadProvider resolveAccess={resolveAccess}>
    <WorkspaceDndProvider>
    <div className="flex w-full min-w-0 flex-1">
      <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-62 shrink-0 overflow-y-auto border-r border-border bg-bg lg:block">
        <SideNav data={data} active={active} expanded={expanded} onToggle={setOpen} onFeedback={feedback} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-14 items-center gap-2 border-b border-border px-4 sm:px-6 lg:hidden">
          <IconButton icon="listTree" label="Browse" variant="secondary" className="size-11" aria-haspopup="dialog" aria-expanded={browseOpen} onClick={() => setBrowseOpen(true)} />
          {activeLabel && <span className="min-w-0 truncate text-body-strong text-text" dir="auto">{activeLabel}</span>}
        </div>
        <main
          id="main"
          tabIndex={-1}
          className={cx(
            "mx-auto w-full min-w-0 flex-1 px-4 py-6 outline-none sm:px-6",
            WIDE.test(pathname) ? "max-w-[1024px] lg:px-8 lg:pb-10" : "max-w-app lg:py-8",
          )}
        >
          {children}
        </main>
      </div>

      <Drawer open={browseOpen} onClose={() => setBrowseOpen(false)} side="left" width={320} title="Browse" bodyClassName="p-0">
        <SideNav
          data={data}
          active={active}
          expanded={expanded}
          onToggle={setOpen}
          onFeedback={feedback}
          onNavigate={() => setBrowseOpen(false)}
          className="py-2"
          footer={
            <div className="mt-3 flex flex-col gap-4 border-t border-border pt-4">
              {LIGHT_ENABLED && (
                <div className="flex items-center justify-between gap-3 px-2.5">
                  <span className="text-body text-text-secondary" aria-hidden>Theme</span>
                  <ThemeSegmented size="sm" label="Theme" />
                </div>
              )}
              {user && (
                <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-raised p-3">
                  <UserAvatar user={user} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-body-strong text-text">{user.name || "Signed in"}</span>
                    <span className="truncate text-caption text-text-muted">{user.email}</span>
                  </span>
                  <Button variant="secondary" className="h-11" onClick={() => { setBrowseOpen(false); void logout(); }}>Sign out</Button>
                </div>
              )}
            </div>
          }
        />
      </Drawer>
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
      {user && <Palette activeWs={activeWs} folderId={activeFolderId ?? null} data={data} />}
    </div>
    </WorkspaceDndProvider>
    </UploadProvider>
  );
}

/** ⌘K / Ctrl+K, the header's search field, and the actions for the folder in view. */
function Palette({ activeWs, folderId, data }: { activeWs: string | null; folderId: string | null; data: RailData }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const uploads = useUploads();
  const pathname = usePathname() || "/";
  const onFolderPage = /^\/w\//.test(pathname);
  const { tree } = useWorkspaceTree(onFolderPage ? activeWs : null);

  const toggle = useCallback(() => setOpen((o) => !o), []);
  usePaletteRequests(useCallback(() => setOpen(true), []));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const actions = useMemo<PaletteAction[]>(() => {
    if (!onFolderPage || !activeWs || !tree) return [];
    const ws = data.workspaces?.find((w) => w.id === activeWs);
    const role = tree.workspace.role ?? ws?.role;
    const folder = folderId ? tree.folders.find((f) => f.id === folderId) ?? null : null;
    const here = folder?.name ?? tree.workspace.name;
    const out: PaletteAction[] = [];
    if (can(role, "member") && uploads) {
      out.push({ id: "upload", label: `Upload to ${here}`, icon: "upload", where: "Here", run: () => uploads.pick(uploads.resolve(activeWs, folderId, here)) });
    }
    const shareFolders = can(role, "admin") || (can(role, "member") && ws?.settings?.members_can_share_folders !== false);
    if (folder && shareFolders) out.push({ id: "share", label: `Share ${folder.name}`, icon: "link", where: "Here", run: () => sendFolderCommand("share") });
    if (can(role, "admin")) out.push({ id: "invite", label: `Invite people to ${tree.workspace.name}`, icon: "user", where: "Workspace", run: () => sendFolderCommand("invite") });
    if (can(role, "member")) out.push({ id: "new-folder", label: "New folder", icon: "folder", where: "Here", run: () => sendFolderCommand("new-folder") });
    if (can(role, "member")) out.push({ id: "preview", label: `Preview ${here} as a visitor`, icon: "eye", where: "Here", run: () => sendFolderCommand("preview") });
    out.push({ id: "settings", label: `${teamName(ws, tree.workspace.name)} settings`, icon: "settings", where: "Workspace", run: () => router.push(`/settings/workspaces/${encodeURIComponent(activeWs)}`) });
    return out;
  }, [onFolderPage, activeWs, tree, folderId, data.workspaces, uploads, router]);

  return <CommandPalette open={open} onClose={() => setOpen(false)} actions={actions} />;
}

export default AppShell;
