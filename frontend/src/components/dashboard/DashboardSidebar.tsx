"use client";

import { useEffect, useState } from "react";
import type { DocKind } from "@/lib/api";
import { createWorkspace, listFolders, listWorkspaces, type Folder, type Workspace } from "@/lib/workspaces";

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

/** What the main list is showing: your own documents, or a workspace library.
 *
 *  Kept as one value rather than two booleans so the list can never be in a
 *  half-state — browsing a workspace folder while a personal kind filter is
 *  also somehow active. */
export type Scope =
  | { kind: "own"; filter: Filter }
  | {
      kind: "workspace";
      workspaceId: string;
      workspaceName: string;
      folderId: string | null;
      label: string;
    };

interface Props {
  scope: Scope;
  onScope: (s: Scope) => void;
  counts: { all: number; markdown: number; artifact: number };
  googleConnected: boolean | null;
  /** Connecting and disconnecting live here now rather than in a page banner
   *  that every visit had to scroll past. */
  onGoogleConnect: () => void;
  onGoogleDisconnect: () => void;
  googleBusy: boolean;
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
function WorkspaceNode({
  ws, scope, onScope, onClose,
}: { ws: Workspace; scope: Scope; onScope: (s: Scope) => void; onClose: () => void }) {
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
          <button
            onClick={() => {
              onScope({ kind: "workspace", workspaceId: ws.id, workspaceName: ws.name,
                        folderId: null, label: "Shared library" });
              onClose();
            }}
            className={`block w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
              scope.kind === "workspace" && scope.workspaceId === ws.id && !scope.folderId
                ? "bg-blue-500/10 text-blue-600 dark:text-blue-300"
                : "text-gray-500 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.05] hover:text-gray-800 dark:hover:text-gray-300"
            }`}
          >
            Shared library
          </button>
          {folders === null ? (
            <p className="px-2.5 py-1.5 text-[12px] text-gray-400 dark:text-gray-600">Loading…</p>
          ) : folders.length === 0 ? (
            <p className="px-2.5 py-1.5 text-[12px] text-gray-400 dark:text-gray-600">No folders</p>
          ) : (
            folders.map((f) => {
              const on = scope.kind === "workspace" && scope.folderId === f.id;
              return (
                <button
                  key={f.id}
                  title={`/${f.path.join("/")}`}
                  onClick={() => {
                    onScope({ kind: "workspace", workspaceId: ws.id, workspaceName: ws.name,
                              folderId: f.id, label: `/${f.path.join("/")}` });
                    onClose();
                  }}
                  // Indented by depth so the tree is legible rather than flat.
                  style={{ paddingLeft: `${10 + (f.path.length - 1) * 12}px` }}
                  className={`block w-full truncate rounded-md py-1.5 pr-2.5 text-left font-mono text-[12px] transition-colors ${
                    on ? "bg-blue-500/10 text-blue-600 dark:text-blue-300"
                       : "text-gray-500 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.05] hover:text-gray-800 dark:hover:text-gray-300"
                  }`}
                >
                  /{f.slug}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

export default function DashboardSidebar({
  scope, onScope, counts, googleConnected, onGoogleConnect, onGoogleDisconnect,
  googleBusy, open, onClose,
}: Props) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  async function create() {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      const ws = await createWorkspace(n);
      setWorkspaces((w) => [...(w ?? []), ws]);
      setName("");
      setCreating(false);
    } catch {
      /* surfaced by the settings page; the rail stays quiet rather than
         growing an error state for a two-field form */
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    listWorkspaces().then(setWorkspaces).catch(() => setWorkspaces([]));
  }, []);

  const item = (id: Filter, label: string, icon: React.ReactNode, n: number) => {
    const active = scope.kind === "own" && scope.filter === id;
    return (
    <button
      key={id}
      onClick={() => { onScope({ kind: "own", filter: id }); onClose(); }}
      aria-current={active ? "page" : undefined}
      className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
        active
          ? "bg-blue-500/10 text-blue-600 dark:text-blue-300 ring-1 ring-inset ring-blue-500/25 font-medium"
          : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.05] hover:text-gray-900 dark:hover:text-gray-200"
      }`}
    >
      <Icon d={icon} />
      {label}
      <span className={`ml-auto text-[11px] tabular-nums ${active ? "opacity-80" : "text-gray-400 dark:text-gray-600"}`}>
        {n}
      </span>
    </button>
    );
  };

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
        className={`no-print md-noscroll flex w-[224px] shrink-0 flex-col gap-0.5 overflow-y-auto border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-white dark:bg-[#070c16] p-3
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

        {workspaces !== null && (
          <>
            <div className="flex items-center justify-between pr-1">
              {heading("Workspaces")}
              {!creating && (
                <button onClick={() => setCreating(true)} title="New workspace"
                        className="mt-3 grid h-5 w-5 place-items-center rounded text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.06] hover:text-gray-700 dark:hover:text-gray-200 transition-colors">
                  +
                </button>
              )}
            </div>
            {creating && (
              <div className="mb-1 flex gap-1.5 px-1">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") create();
                    if (e.key === "Escape") { setCreating(false); setName(""); }
                  }}
                  placeholder="Workspace name"
                  maxLength={80}
                  className="min-w-0 flex-1 rounded-md border border-gray-200 dark:border-white/[0.1] bg-gray-50 dark:bg-white/[0.04] px-2 py-1.5 text-[12.5px] outline-none focus:border-blue-500"
                />
                <button onClick={create} disabled={busy || !name.trim()}
                        className="shrink-0 rounded-md bg-blue-600 px-2 text-[12px] font-medium text-white disabled:opacity-40">
                  {busy ? "…" : "Add"}
                </button>
              </div>
            )}
            {workspaces.map((w) => (
              <WorkspaceNode key={w.id} ws={w} scope={scope} onScope={onScope} onClose={onClose} />
            ))}
            {workspaces.length === 0 && !creating && (
              <p className="px-3 py-1 text-[12px] text-gray-400 dark:text-gray-600">
                None yet
              </p>
            )}
          </>
        )}

        {googleConnected !== null && (
          <>
            {heading("Integrations")}
            <div className="rounded-lg px-3 py-2">
              <div className="flex items-center gap-2.5 text-sm text-gray-600 dark:text-gray-400">
                <Icon d={ICONS.google} />
                Google Docs
                <span className={`ml-auto text-[11px] ${googleConnected ? "text-emerald-500" : "text-gray-400 dark:text-gray-600"}`}>
                  {googleConnected ? "Connected" : "Off"}
                </span>
              </div>
              {googleConnected ? (
                confirmOff ? (
                  <div className="mt-2 flex gap-1.5">
                    <button onClick={() => { setConfirmOff(false); onGoogleDisconnect(); }}
                            disabled={googleBusy}
                            className="flex-1 rounded-md border border-red-300 dark:border-red-900/60 px-2 py-1 text-[11.5px] text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50">
                      {googleBusy ? "…" : "Revoke"}
                    </button>
                    <button onClick={() => setConfirmOff(false)}
                            className="rounded-md border border-gray-200 dark:border-white/[0.1] px-2 py-1 text-[11.5px] text-gray-500">
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmOff(true)}
                          className="mt-1.5 text-[11.5px] text-gray-400 hover:text-red-500 transition-colors">
                    Disconnect
                  </button>
                )
              ) : (
                <button onClick={onGoogleConnect}
                        className="mt-1.5 text-[11.5px] text-blue-600 dark:text-blue-400 hover:underline">
                  Connect to export documents
                </button>
              )}
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
