"use client";

import { useEffect, useState } from "react";
import type { DocKind } from "@/lib/api";
import { listFolders, listWorkspaces, type Folder, type Workspace } from "@/lib/workspaces";

/**
 * Navigation for the dashboard.
 *
 * The dashboard had no way to reach a workspace or a folder — "Workspaces" was
 * a text link to another page entirely, and a document filed at
 * /data/reports/q3 looked exactly like an unfiled one. Now that folders are
 * part of a document's address, that gap grows with every folder someone makes.
 *
 * A rail on desktop, an off-canvas drawer on a phone. Not a horizontal scroller:
 * this is a tree, and a tree that scrolls sideways is unreadable.
 */

export type Filter = DocKind | "all";

interface Props {
  filter: Filter;
  onFilter: (f: Filter) => void;
  counts: { all: number; markdown: number; artifact: number };
  googleConnected: boolean | null;
  /** Drawer state, owned by the page so the header button can toggle it. */
  open: boolean;
  onClose: () => void;
}

function Icon({ d, className = "w-4 h-4" }: { d: React.ReactNode; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {d}
    </svg>
  );
}

const ICONS = {
  all: <path d="M4 6h16M4 12h16M4 18h10" />,
  doc: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z" /><path d="M14 2v6h6" /></>,
  artifact: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  chevron: <path d="m9 18 6-6-6-6" />,
  google: <><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></>,
};

/** One workspace, with its folders revealed on demand. */
function WorkspaceNode({ ws }: { ws: Workspace }) {
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<Folder[] | null>(null);

  // Folders load when the node is first opened, not for every workspace on
  // mount — a user with eight workspaces should not pay eight requests to
  // render a sidebar.
  useEffect(() => {
    if (!open || folders) return;
    listFolders(ws.id).then(setFolders).catch(() => setFolders([]));
  }, [open, folders, ws.id]);

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.05] hover:text-gray-900 dark:hover:text-gray-200 transition-colors"
      >
        <Icon d={ICONS.chevron}
              className={`w-3 h-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <Icon d={ICONS.folder} className="w-4 h-4 shrink-0" />
        <span className="truncate">{ws.name}</span>
      </button>

      {open && (
        <div className="ml-[18px] border-l border-gray-200 dark:border-white/[0.07] pl-2 py-0.5">
          <a href={`/settings/workspaces/${ws.id}`}
             className="block rounded-md px-2.5 py-1.5 text-[12.5px] text-gray-500 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.05] hover:text-gray-800 dark:hover:text-gray-300 transition-colors">
            Shared library
          </a>
          {folders === null ? (
            <p className="px-2.5 py-1.5 text-[12px] text-gray-400 dark:text-gray-600">Loading…</p>
          ) : folders.length === 0 ? (
            <p className="px-2.5 py-1.5 text-[12px] text-gray-400 dark:text-gray-600">No folders</p>
          ) : (
            folders.map((f) => (
              <a
                key={f.id}
                href={`/settings/workspaces/${ws.id}`}
                title={`/${f.path.join("/")}`}
                // Indented by depth so the tree is legible rather than flat.
                style={{ paddingLeft: `${10 + (f.path.length - 1) * 12}px` }}
                className="block truncate rounded-md py-1.5 pr-2.5 font-mono text-[12px] text-gray-500 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.05] hover:text-gray-800 dark:hover:text-gray-300 transition-colors"
              >
                /{f.slug}
              </a>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function DashboardSidebar({
  filter, onFilter, counts, googleConnected, open, onClose,
}: Props) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);

  useEffect(() => {
    listWorkspaces().then(setWorkspaces).catch(() => setWorkspaces([]));
  }, []);

  const item = (id: Filter, label: string, icon: React.ReactNode, n: number) => (
    <button
      key={id}
      onClick={() => { onFilter(id); onClose(); }}
      aria-current={filter === id ? "page" : undefined}
      className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
        filter === id
          ? "bg-blue-500/10 text-blue-600 dark:text-blue-300 ring-1 ring-inset ring-blue-500/25 font-medium"
          : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.05] hover:text-gray-900 dark:hover:text-gray-200"
      }`}
    >
      <Icon d={icon} />
      {label}
      <span className={`ml-auto text-[11px] tabular-nums ${filter === id ? "opacity-80" : "text-gray-400 dark:text-gray-600"}`}>
        {n}
      </span>
    </button>
  );

  const heading = (t: string) => (
    <p className="px-3 pt-5 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-600">{t}</p>
  );

  return (
    <>
      {/* Scrim, phone only. */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-[95] bg-black/50" onClick={onClose} aria-hidden />
      )}

      <aside
        className={`no-print flex w-[260px] shrink-0 flex-col gap-0.5 overflow-y-auto border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-white dark:bg-[#070c16] p-3
          fixed inset-y-0 left-0 z-[100] border-r transition-transform duration-200
          lg:static lg:z-auto lg:translate-x-0 lg:bg-transparent lg:dark:bg-transparent lg:border-r lg:p-0 lg:pr-4
          ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="lg:hidden flex items-center justify-between px-2 pb-2">
          <span className="text-sm font-semibold">Browse</span>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">×</button>
        </div>

        {item("all", "All items", ICONS.all, counts.all)}
        {item("markdown", "Documents", ICONS.doc, counts.markdown)}
        {item("artifact", "Artifacts", ICONS.artifact, counts.artifact)}

        {workspaces !== null && workspaces.length > 0 && (
          <>
            {heading("Workspaces")}
            {workspaces.map((w) => <WorkspaceNode key={w.id} ws={w} />)}
          </>
        )}

        {googleConnected !== null && (
          <>
            {heading("Integrations")}
            <div className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-gray-600 dark:text-gray-400">
              <Icon d={ICONS.google} />
              Google Docs
              <span className={`ml-auto text-[11px] ${googleConnected ? "text-emerald-500" : "text-amber-500"}`}>
                {googleConnected ? "on" : "off"}
              </span>
            </div>
          </>
        )}

        <div className="flex-1" />
        {/* Drawer only — the header already carries this on desktop, and two
            identical primary buttons on one screen is one too many. */}
        <a href="/new"
           className="lg:hidden mt-4 block rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-2.5 text-center text-sm font-semibold text-white transition-colors">
          + New document
        </a>
      </aside>
    </>
  );
}
