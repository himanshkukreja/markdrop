"use client";

import { useCallback, useEffect, useState } from "react";
import { useState as useShareState } from "react";
import type { MyDocListItem } from "@/lib/api";
import ShareDialog from "@/components/access/ShareDialog";
import {
  can, fileDocument, libraryCounts, listLibrary, unshareFromWorkspace,
  type Folder, type Role,
} from "@/lib/workspaces";

function Icon({ children, className = "w-4 h-4" }: { children: React.ReactNode; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

function bytes(n?: number | null) {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function when(iso: string) {
  const d = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Where this document answers, and on which host.
 *
 *  Folders are path segments, so a document filed under Data/Reports lives at
 *  `/data/reports/<slug>`. On a workspace with its own verified domain that is
 *  the address worth showing — it is the one people will actually share, and
 *  until now nothing in the UI said it existed. */
function addressOf(d: MyDocListItem, host: string | null) {
  const path = [...(d.folder_path ?? []), d.slug].join("/");
  return { href: host ? `https://${host}/${path}` : `/${path}`, label: `${host ?? "markdrop.in"}/${path}` };
}

function initials(s: string) {
  return s.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";
}

/**
 * The workspace's shared documents and artifacts.
 *
 * Everything listed here was put here deliberately by the person who owns it.
 * Private documents are not filtered out of this view — they were never in the
 * result set, because the server matches on `workspace_id` and a private
 * document has none. That distinction is worth keeping in mind when changing
 * this component: there is no "show only shared" flag to accidentally drop.
 */
export default function LibraryPanel({
  workspaceId,
  role,
  folders,
  accent,
  primaryHost,
  onError,
}: {
  workspaceId: string;
  role: Role;
  folders: Folder[];
  accent: string;
  /** The workspace's own document host, when it has a verified one. */
  primaryHost: string | null;
  onError: (msg: string) => void;
}) {
  const [docs, setDocs] = useState<MyDocListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"" | "markdown" | "artifact">("");
  const [folder, setFolder] = useState<string>("");   // "" = all, "unfiled", or an id
  const [busy, setBusy] = useState("");
  const [shareFor, setShareFor] = useShareState<MyDocListItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await listLibrary(workspaceId, {
        q: q || undefined,
        kind: kind || undefined,
        folderId: folder && folder !== "unfiled" ? folder : undefined,
        unfiled: folder === "unfiled",
        limit: 50,
      });
      setDocs(r.documents);
      setTotal(r.total);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not load the library");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, q, kind, folder, onError]);

  // Debounced so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  // Per-folder totals don't depend on the query, so they are fetched once
  // rather than alongside every search. Folded into `load` they turned a
  // debounced keystroke into two requests against a rate-limited API.
  const loadCounts = useCallback(async () => {
    setCounts(await libraryCounts(workspaceId).catch(() => ({})));
  }, [workspaceId]);

  useEffect(() => {
    loadCounts();
  }, [loadCounts]);

  const canEdit = can(role, "member");
  const canAdmin = can(role, "admin");

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    try { await fn(); await Promise.all([load(), loadCounts()]); }
    catch (e) { onError(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(""); }
  }

  const filters = [
    { id: "", label: "All", n: total },
    { id: "unfiled", label: "Unfiled", n: counts["unfiled"] },
    // Depth-first, and labelled by path: two folders can legitimately both be
    // called "Drafts", and a bare name gives no way to tell them apart.
    ...[...folders]
      .sort((a, b) => a.path.join("/").localeCompare(b.path.join("/")))
      .map((f) => ({
        id: f.id,
        label: f.path.length > 1 ? f.path.slice(0, -1).join(" / ") + " / " + f.name : f.name,
        n: counts[f.id],
      })),
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Icon className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
            <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>
          </Icon>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search shared documents"
            className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm outline-none focus:border-blue-500 transition-colors"
          />
        </div>
        <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
          {([["", "All"], ["markdown", "Docs"], ["artifact", "Files"]] as const).map(([v, l]) => (
            <button key={v} onClick={() => setKind(v)}
              className={`px-3 py-2 text-xs transition-colors ${
                kind === v
                  ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900"
                  : "hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400"}`}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {filters.length > 2 && (
        <div className="flex gap-1.5 flex-wrap">
          {filters.map((f) => (
            <button key={f.id} onClick={() => setFolder(f.id)}
              className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
                folder === f.id
                  ? "bg-blue-500/15 text-blue-600 dark:text-blue-400 ring-1 ring-blue-500/30"
                  : "text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"}`}>
              {f.label}
              {typeof f.n === "number" && <span className="ml-1 opacity-60">{f.n}</span>}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 rounded-xl bg-gray-100 dark:bg-gray-800/50 animate-pulse" />
          ))}
        </div>
      ) : docs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 dark:border-gray-800 px-4 py-12 text-center">
          <Icon className="w-8 h-8 mx-auto text-gray-300 dark:text-gray-700 mb-3">
            <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
          </Icon>
          <p className="text-sm text-gray-500">
            {q || kind || folder ? "Nothing matches that." : "Nothing shared yet."}
          </p>
          {!q && !kind && !folder && (
            <p className="text-xs text-gray-400 mt-1.5 max-w-sm mx-auto leading-relaxed">
              Documents stay private until someone shares them here. Open your dashboard and use
              “Share to workspace” on anything the team should have.
            </p>
          )}
          {!q && !kind && !folder && (
            <a href="/dashboard" className="inline-block mt-4 text-sm text-blue-500 hover:underline">
              Go to your documents
            </a>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
          {docs.map((d) => (
            <div key={d.id} className="flex items-start gap-3 px-3.5 py-3 hover:bg-gray-50 dark:hover:bg-gray-900/40 transition-colors">
              <span className="w-8 h-8 rounded-lg grid place-items-center shrink-0 mt-0.5 bg-gray-100 dark:bg-gray-800">
                <Icon className="w-4 h-4 text-gray-500">
                  {d.kind === "artifact"
                    ? <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6" />
                    : <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z" /><path d="M8 13h8M8 17h5" /></>}
                </Icon>
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <a href={addressOf(d, primaryHost).href} target="_blank" rel="noreferrer"
                     className="text-sm font-medium truncate hover:text-blue-500 transition-colors">
                    {d.encrypted ? d.slug : d.title || d.slug}
                  </a>
                  {d.encrypted && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                      Encrypted
                    </span>
                  )}
                  {d.type_label && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-500/10 text-gray-500">
                      {d.type_label}
                    </span>
                  )}
                </div>
                <p className="text-[11px] font-mono text-gray-500 dark:text-gray-400 truncate mt-0.5">
                  {addressOf(d, primaryHost).label}
                </p>
                <p className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
                  <span className="inline-flex items-center gap-1">
                    <span className="w-4 h-4 rounded-full grid place-items-center text-[7px] font-bold text-white"
                          style={{ background: accent }}>
                      {initials(d.shared_by_name || d.shared_by_email || "?")}
                    </span>
                    {d.is_mine ? "You" : d.shared_by_name || d.shared_by_email}
                  </span>
                  <span>·</span>
                  <span>{when(d.updated_at)}</span>
                  {d.size_bytes ? <><span>·</span><span>{bytes(d.size_bytes)}</span></> : null}
                  <span>·</span>
                  <span>{d.views} view{d.views === 1 ? "" : "s"}</span>
                </p>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {canEdit && folders.length > 0 && (
                  <select
                    value={d.folder_id || ""}
                    onChange={(e) => run(`f${d.id}`,
                      () => fileDocument(workspaceId, d.id, e.target.value || null, d.slug))}
                    className="text-[11px] bg-transparent border border-gray-200 dark:border-gray-700 rounded px-1.5 py-1 cursor-pointer max-w-[120px]"
                  >
                    <option value="">Unfiled</option>
                    {[...folders]
                      .sort((a, b) => a.path.join("/").localeCompare(b.path.join("/")))
                      .map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.path.length > 1 ? f.path.slice(0, -1).join(" / ") + " / " : ""}{f.name}
                        </option>
                      ))}
                  </select>
                )}
                {d.is_mine && (
                  <button
                    onClick={() => setShareFor(d)}
                    title="Choose who can open this"
                    className="text-[11px] px-2 py-1 rounded text-gray-400 hover:text-blue-500 hover:bg-blue-500/5 transition-colors"
                  >
                    Share
                  </button>
                )}
                {(d.is_mine || canAdmin) && (
                  <button
                    disabled={busy === `u${d.id}`}
                    onClick={() => {
                      if (!confirm(
                        d.is_mine
                          ? "Remove this from the shared library? It stays in your own documents, with the same link."
                          : "Remove this from the shared library? It goes back to its owner — nothing is deleted."
                      )) return;
                      run(`u${d.id}`, () => unshareFromWorkspace(workspaceId, d.id, d.slug));
                    }}
                    title="Remove from the shared library"
                    className="text-[11px] px-2 py-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-500/5 transition-colors disabled:opacity-50"
                  >
                    {busy === `u${d.id}` ? "…" : "Unshare"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {shareFor && (
        <ShareDialog
          slug={shareFor.slug}
          documentId={shareFor.id}
          title={shareFor.title || shareFor.slug}
          onClose={() => setShareFor(null)}
          onChanged={load}
        />
      )}

      {docs.length > 0 && (
        <p className="text-[11px] text-gray-400">
          {total} shared {total === 1 ? "item" : "items"}.
          {can(role, "member")
            ? " Everyone here can read these; members and admins can edit them."
            : " You have read-only access."}
        </p>
      )}
    </div>
  );
}
