"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Button, Drawer, IconButton } from "@/components/ui";
import { ThemeSegmented } from "@/components/theme/ThemeSegmented";
import { openFeedback, FeedbackDialog } from "@/components/FeedbackWidget";
import { useAuth } from "@/contexts/AuthContext";
import { listApiTokens, listMyDocuments } from "@/lib/api";
import { LIGHT_ENABLED } from "@/lib/theme";
import { libraryCounts, listFolders, listWorkspaces } from "@/lib/workspaces";
import { UserAvatar } from "./AccountMenu";
import { SideNav, railKeyFor, workspaceOfKey, type RailData } from "./SideNav";
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
 * count_all / count_markdown / count_artifact), workspaces, token count, and a workspace's folders
 * and library counts only when it is expanded (the API has a burst limit). Any failure just leaves
 * that part of the rail without numbers. Refreshes counts when the user changes.
 */
function useRailData(userId: string | null, expanded: Set<string>) {
  const [data, setData] = useState<RailData>({ folders: {}, libraryCounts: {} });
  const requested = useRef(new Set<string>());

  useEffect(() => {
    requested.current = new Set();
    setData({ folders: {}, libraryCounts: {} });
    if (!userId) return;
    let live = true;
    listMyDocuments(1)
      .then((r) => {
        if (!live || r.count_all === undefined) return;
        setData((d) => ({ ...d, counts: { all: r.count_all, documents: r.count_markdown, artifacts: r.count_artifact } }));
      })
      .catch(() => {});
    listWorkspaces()
      .then((ws) => live && setData((d) => ({ ...d, workspaces: ws })))
      .catch(() => {});
    listApiTokens()
      .then((t) => live && setData((d) => ({ ...d, tokens: t.length })))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    for (const id of expanded) {
      if (requested.current.has(id)) continue;
      requested.current.add(id);
      listFolders(id)
        .then((f) => setData((d) => ({ ...d, folders: { ...d.folders, [id]: f } })))
        .catch(() => setData((d) => ({ ...d, folders: { ...d.folders, [id]: [] } })));
      libraryCounts(id)
        .then((c) => setData((d) => ({ ...d, libraryCounts: { ...d.libraryCounts, [id]: c } })))
        .catch(() => {});
    }
  }, [expanded, userId]);

  return data;
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

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // The workspace you are in opens itself.
  useEffect(() => {
    if (activeWs) setExpanded((s) => (s.has(activeWs) ? s : new Set(s).add(activeWs)));
  }, [activeWs]);
  const toggle = useCallback((id: string) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  const data = useRailData(user?.id ?? null, expanded);
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
      const folderId = active?.split(":folder:")[1];
      const folder = folderId ? data.folders[activeWs]?.find((f) => f.id === folderId) : undefined;
      activeLabel = folder ? `${ws.name} / ${folder.name}` : active?.endsWith(":settings") ? `${ws.name} settings` : ws.name;
    }
  }

  return (
    <div className="flex w-full min-w-0 flex-1">
      <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-62 shrink-0 overflow-y-auto border-r border-border bg-bg lg:block">
        <SideNav data={data} active={active} expanded={expanded} onToggle={toggle} onFeedback={feedback} />
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
          onToggle={toggle}
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
  );
}

export default AppShell;
