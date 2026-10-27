"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Button, Drawer, IconButton } from "@/components/ui";
import { ThemeSegmented } from "@/components/theme/ThemeSegmented";
import { openFeedback, FeedbackDialog } from "@/components/FeedbackWidget";
import { useAuth } from "@/contexts/AuthContext";
import { listApiTokens, listMyDocuments } from "@/lib/api";
import { LIGHT_ENABLED } from "@/lib/theme";
import { listWorkspaces } from "@/lib/workspaces";
import { ancestry, useDocumentsChanged, useWorkspaceChanged, useWorkspaceTree } from "@/lib/workspaceStore";
import { WorkspaceDndProvider } from "@/components/workspace/WorkspaceDnd";
import { UserAvatar } from "./AccountMenu";
import { SideNav, railKeyFor, workspaceOfKey, wsFolderKey, wsRootKey, type RailData } from "./SideNav";
import { useLocationSearch } from "./useLocation";

const LABELS: Record<string, string> = {
  "docs:all": "All items",
  "docs:document": "Documents",
  "docs:artifact": "Artifacts",
  "ws:new": "Workspaces",
  "int:vscode": "API tokens",
  "int:apps": "Connected apps",
  settings: "Settings",
};

/**
 * Loads the rail's data lazily and tolerantly: document counts (one page of /me/documents carries
 * count_all / count_markdown / count_artifact), workspaces and the token count. A workspace's
 * folder tree comes from the shared tree store (lib/workspaceStore), loaded only when it is
 * expanded (the API has a burst limit) and refreshed whenever anything changes it. Any failure
 * just leaves that part of the rail without numbers. Personal counts reload after a change too.
 */
function useRailData(userId: string | null) {
  const [data, setData] = useState<RailData>({});

  const loadCounts = useCallback(() => {
    listMyDocuments(1)
      .then((r) => {
        if (r.count_all === undefined) return;
        setData((d) => ({ ...d, counts: { all: r.count_all, documents: r.count_markdown, artifacts: r.count_artifact } }));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setData({});
    if (!userId) return;
    let live = true;
    loadCounts();
    listWorkspaces()
      .then((ws) => live && setData((d) => ({ ...d, workspaces: ws })))
      .catch(() => {});
    listApiTokens()
      .then((t) => live && setData((d) => ({ ...d, tokens: t.length })))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [userId, loadCounts]);

  // Filing a document into (or out of) a workspace changes the personal list's numbers too.
  const refreshCounts = useCallback(() => { if (userId) loadCounts(); }, [userId, loadCounts]);
  useDocumentsChanged(refreshCounts);
  useWorkspaceChanged("*", refreshCounts);

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

/**
 * The account shell for /dashboard and /settings/* (REVAMP_PLAN 4.3): a 248px rail, sticky under
 * the 56px header, on bg with a right hairline, beside an 880px content column holding
 * <main id="main">. Below 1024px the rail becomes a left Drawer opened by the "Browse" button in a
 * slim bar above the content (MobileAccount frame 4), which adds the theme control and the
 * signed-in identity. The rail reads the URL query after mount without useSearchParams.
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

  let activeLabel = active ? LABELS[active] : undefined;
  if (!activeLabel && activeWs) {
    const ws = data.workspaces?.find((w) => w.id === activeWs);
    if (ws) {
      const folder = activeFolderId ? activeTree?.folders.find((f) => f.id === activeFolderId) : undefined;
      activeLabel = folder ? `${ws.name} / ${folder.name}` : active?.endsWith(":settings") ? `${ws.name} settings` : ws.name;
    }
  }

  return (
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
        <main id="main" tabIndex={-1} className="mx-auto w-full min-w-0 max-w-app flex-1 px-4 py-6 outline-none sm:px-6 lg:py-8">
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
    </div>
    </WorkspaceDndProvider>
  );
}

export default AppShell;
