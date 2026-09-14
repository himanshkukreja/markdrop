"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import {
  listMyDocuments, getAnalytics, deleteDocument, changeSlug,
  getGoogleDocsStatus, connectGoogleDocs, disconnectGoogleDocs, exportToGoogleDocs,
  MyDocListItem, Analytics, GoogleStatus, DocKind,
} from "@/lib/api";
import ArtifactBadge, { formatBytes } from "@/components/ArtifactBadge";
import Modal from "@/components/Modal";
import VSCodeIcon from "@/components/VSCodeIcon";
import MarkdropLoader from "@/components/MarkdropLoader";
import ShareToWorkspace from "@/components/workspace/ShareToWorkspace";
import DashboardSidebar, { type Filter } from "@/components/dashboard/DashboardSidebar";
import RowMenu, { type MenuItem } from "@/components/dashboard/RowMenu";

type Range = "7d" | "30d" | "all";

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-white dark:bg-gray-900/40 vscode:bg-[#252526] p-3">
      <div className="text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4]">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">{label}</div>
    </div>
  );
}

function BarRow({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-28 truncate text-gray-600 dark:text-gray-300 vscode:text-[#cccccc]" title={label}>{label}</span>
      <div className="flex-1 h-3 rounded bg-gray-100 dark:bg-gray-800 vscode:bg-[#2d2d2d] overflow-hidden">
        <div className="h-full bg-blue-500/70 vscode:bg-[#4daafc]/70" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right tabular-nums text-gray-500 vscode:text-[#9d9d9d]">{value}</span>
    </div>
  );
}

function AnalyticsPanel({ slug }: { slug: string }) {
  const [range, setRange] = useState<Range>("30d");
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    getAnalytics(slug, range).then((d) => { if (active) { setData(d); setLoading(false); } }).catch(() => setLoading(false));
    return () => { active = false; };
  }, [slug, range]);

  const maxDay = data ? Math.max(1, ...data.timeseries.map((t) => t.views)) : 1;
  const maxCountry = data ? Math.max(1, ...data.countries.map((c) => c.views)) : 1;
  const maxRef = data ? Math.max(1, ...data.referrers.map((r) => r.views)) : 1;

  return (
    <div className="mt-3 rounded-lg bg-gray-50 dark:bg-gray-900/40 vscode:bg-[#1e1e1e] border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold">Analytics</h4>
        <div className="flex gap-1">
          {(["7d", "30d", "all"] as Range[]).map((r) => (
            <button key={r} onClick={() => setRange(r)}
              className={`px-2 py-0.5 text-xs rounded transition-colors ${range === r ? "bg-blue-600 vscode:bg-[#0e639c] text-white" : "text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] hover:bg-gray-200 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d]"}`}>
              {r === "all" ? "All" : r}
            </button>
          ))}
        </div>
      </div>

      {loading || !data ? (
        <div className="py-4 flex justify-center">
          <MarkdropLoader label={null} size="sm" hideWordmark />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatCard label="Views" value={data.totals.views} />
            <StatCard label="Unique visitors" value={data.totals.unique_visitors} />
            <StatCard label="PDF exports" value={data.totals.export_pdf} />
            <StatCard label="URL copies" value={data.totals.copy_url} />
          </div>

          {data.timeseries.length > 0 && (
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] mb-1.5">Views over time</div>
              <div className="flex items-end gap-0.5 h-20">
                {data.timeseries.map((t) => (
                  <div key={t.date} className="flex-1 bg-blue-500/60 rounded-t hover:bg-blue-500 transition-colors" style={{ height: `${(t.views / maxDay) * 100}%` }} title={`${t.date}: ${t.views}`} />
                ))}
              </div>
            </div>
          )}

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] mb-1.5">Top countries</div>
              {data.countries.length ? (
                <div className="space-y-1">{data.countries.map((c) => <BarRow key={c.country} label={c.country} value={c.views} max={maxCountry} />)}</div>
              ) : <p className="text-xs text-gray-400">No geo data yet.</p>}
            </div>
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] mb-1.5">Top referrers</div>
              {data.referrers.length ? (
                <div className="space-y-1">{data.referrers.map((r) => <BarRow key={r.referrer} label={r.referrer} value={r.views} max={maxRef} />)}</div>
              ) : <p className="text-xs text-gray-400">No referrers yet.</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type BtnVariant = "default" | "danger" | "success" | "warning";

/** Circular refresh arrow; spins while a sync is in flight. */
export default function DashboardPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [docs, setDocs] = useState<MyDocListItem[]>([]);
  const [kindFilter, setKindFilter] = useState<DocKind | "all">("all");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [counts, setCounts] = useState({ all: 0, markdown: 0, artifact: 0 });
  const [navOpen, setNavOpen] = useState(false);
  // The share dialog is opened from a row's overflow menu, so the row holds no
  // trigger of its own — see ShareToWorkspace's `hideTrigger`.
  const [shareFor, setShareFor] = useState<string | null>(null);

  // Google Docs integration
  const [gStatus, setGStatus] = useState<GoogleStatus | null>(null);
  const [exportBusy, setExportBusy] = useState<string | null>(null);   // slug in progress
  const [exportError, setExportError] = useState<string | null>(null);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [gNotice, setGNotice] = useState<string | null>(null);
  const [exported, setExported] = useState<{ title: string; url: string; updated: boolean } | null>(null);
  const [disconnectBusy, setDisconnectBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  // Modal state
  const [renameFor, setRenameFor] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteFor, setDeleteFor] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await listMyDocuments(1, undefined, kindFilter === "all" ? undefined : kindFilter);
      setDocs(res.documents);
      setCounts({
        all: res.count_all ?? res.total,
        markdown: res.count_markdown ?? 0,
        artifact: res.count_artifact ?? 0,
      });
    } catch {
      /* redirect handled below */
    } finally {
      setLoading(false);
    }
  }, [kindFilter]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { router.replace("/login?next=/dashboard"); return; }
    load();
    getGoogleDocsStatus().then(setGStatus).catch(() => {});
  }, [authLoading, user, router, load]);

  // Surface the result of the Google connect redirect (?gdocs=…).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const g = params.get("gdocs");
    if (!g) return;
    const messages: Record<string, string> = {
      connected: "Google Docs connected. You can now export documents.",
      cancelled: "Google connection was cancelled.",
      failed: "Could not connect to Google. Please try again.",
      state_error: "Connection expired. Please try again.",
      no_refresh_token: "Google didn't return access. Try again and approve all prompts.",
    };
    setGNotice(messages[g] ?? null);
    if (g === "connected") getGoogleDocsStatus().then(setGStatus).catch(() => {});
    // Clean the URL so a refresh doesn't re-show the notice.
    window.history.replaceState({}, "", "/dashboard");
  }, []);

  async function handleExport(doc: MyDocListItem) {
    const wasLinked = !!doc.google_doc_url;
    setExportBusy(doc.slug);
    setExportError(null);
    setNeedsReconnect(false);
    setExported(null);
    try {
      const result = await exportToGoogleDocs(doc.id);
      // Reflect the new/updated link locally without a full reload.
      setDocs((ds) => ds.map((d) =>
        d.id === doc.id
          ? { ...d, google_doc_url: result.google_doc_url, google_doc_stale: false }
          : d
      ));
      // Show a success banner with a direct link. We don't auto-open a new tab:
      // window.open() after an await is blocked by popup blockers (esp. Safari).
      if (result.google_doc_url) {
        setExported({ title: doc.title || doc.slug, url: result.google_doc_url, updated: wasLinked });
      }
    } catch (err) {
      if (err instanceof Error && err.name === "ReconnectRequired") {
        // Missing scope / expired grant — show the server's message and offer
        // a Reconnect button rather than a dead-end error.
        setNeedsReconnect(true);
        setExportError(err.message);
      } else {
        setExportError(err instanceof Error ? err.message : "Export failed");
      }
    } finally {
      setExportBusy(null);
    }
  }

  async function handleConnect() {
    try {
      await connectGoogleDocs("/dashboard");
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Could not start Google connect");
    }
  }

  async function handleDisconnect() {
    setDisconnectBusy(true);
    setExportError(null);
    try {
      const status = await disconnectGoogleDocs();
      setGStatus(status);
      setConfirmDisconnect(false);
      // Drop the per-doc links locally — they're stale now that we're disconnected.
      setDocs((ds) => ds.map((d) => ({ ...d, google_doc_url: null, google_doc_stale: false })));
      setGNotice("Google Docs disconnected. Markdrop's access has been revoked.");
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Could not disconnect Google");
    } finally {
      setDisconnectBusy(false);
    }
  }

  function copyUrl(url: string, slug: string) {
    navigator.clipboard.writeText(url);
    setCopied(slug);
    setTimeout(() => setCopied((c) => (c === slug ? null : c)), 1500);
  }

  function openRename(slug: string) {
    setRenameFor(slug); setRenameValue(slug); setRenameError("");
  }

  async function submitRename(e: React.FormEvent) {
    e.preventDefault();
    if (!renameFor || !renameValue.trim() || renameValue === renameFor) { setRenameFor(null); return; }
    setRenameBusy(true); setRenameError("");
    try {
      await changeSlug(renameFor, renameValue.trim());
      setRenameFor(null);
      load();
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "Failed to change URL");
    } finally {
      setRenameBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleteFor) return;
    setDeleteBusy(true);
    try {
      await deleteDocument(deleteFor);
      setDocs((d) => d.filter((x) => x.slug !== deleteFor));
      setDeleteFor(null);
    } catch {
      /* leave modal open */
    } finally {
      setDeleteBusy(false);
    }
  }

  if (authLoading || (!user && loading)) {
    return (
      <div className="flex-1 min-h-[60vh] flex items-center justify-center">
        <MarkdropLoader label="Loading your dashboard…" />
      </div>
    );
  }

  const TITLES: Record<Filter, string> = {
    all: "All items",
    markdown: "Documents",
    artifact: "Artifacts",
  };

  return (
    <div className="flex-1 min-h-0 flex gap-0 lg:gap-6">
      <DashboardSidebar
        filter={kindFilter}
        onFilter={(f) => { setLoading(true); setKindFilter(f); }}
        counts={counts}
        googleConnected={gStatus?.configured ? gStatus.connected : null}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />

      <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden pb-10">
      <div className="flex items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-3 min-w-0">
          {/* The rail is a drawer below lg, so it needs a way in. */}
          <button
            onClick={() => setNavOpen(true)}
            aria-label="Browse"
            className="lg:hidden grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-gray-200 dark:border-white/[0.09] text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight truncate">{TITLES[kindFilter]}</h1>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {counts.markdown} document{counts.markdown === 1 ? "" : "s"} · {counts.artifact} artifact{counts.artifact === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <a href="/new" className="shrink-0 text-sm px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold transition-colors">
          <span className="hidden sm:inline">+ New document</span><span className="sm:hidden">+ New</span>
        </a>
      </div>

      {gNotice && (
        <div className="mb-4 rounded-lg border border-blue-200 dark:border-blue-900/60 vscode:border-[#2d4a5e] bg-blue-50 dark:bg-blue-950/30 vscode:bg-[#12283a] px-3 py-2 text-sm text-blue-700 dark:text-blue-300 vscode:text-[#4daafc] flex items-center justify-between gap-3">
          <span>{gNotice}</span>
          <button onClick={() => setGNotice(null)} className="text-blue-400 hover:text-blue-600 shrink-0">✕</button>
        </div>
      )}
      {exportError && (
        <div className="mb-4 rounded-lg border border-red-200 dark:border-red-900/60 vscode:border-[#5a3232] bg-red-50 dark:bg-red-950/30 vscode:bg-[#3a2626] px-3 py-2 text-sm text-red-600 dark:text-red-400 vscode:text-[#f48771] flex items-center justify-between gap-3 flex-wrap">
          <span>{exportError}</span>
          <div className="flex items-center gap-3 shrink-0">
            {needsReconnect && (
              <button onClick={handleConnect} className="font-medium underline hover:no-underline">Reconnect Google Docs →</button>
            )}
            <button onClick={() => { setExportError(null); setNeedsReconnect(false); }} className="text-red-400 hover:text-red-600">✕</button>
          </div>
        </div>
      )}
      {exported && (
        <div className="mb-4 rounded-lg border border-green-200 dark:border-green-900/60 vscode:border-[#2e4034] bg-green-50 dark:bg-green-950/30 vscode:bg-[#1c2b22] px-3 py-2.5 text-sm text-green-700 dark:text-green-300 vscode:text-[#4ec9b0] flex items-center justify-between gap-3 flex-wrap">
          <span>✅ <span className="font-medium">{exported.title}</span> {exported.updated ? "updated in" : "exported to"} Google Docs.</span>
          <div className="flex items-center gap-3 shrink-0">
            <a href={exported.url} target="_blank" rel="noopener noreferrer" className="font-medium underline hover:no-underline">Open in Google Docs →</a>
            <button onClick={() => setExported(null)} className="text-green-500 hover:text-green-700">✕</button>
          </div>
        </div>
      )}

      {/* Google Docs connect prompt — only when the server supports it and the account isn't linked */}
      {gStatus?.configured && !gStatus.connected && (
        <div className="mb-4 rounded-xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] p-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-800 dark:text-gray-200">Export to Google Docs</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Connect your Google account to turn any document into a formatted Google Doc. Markdrop only touches Docs it creates.</p>
          </div>
          <button onClick={handleConnect} className="shrink-0 text-sm px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors font-medium">
            Connect Google Docs
          </button>
        </div>
      )}

      {/* Google Docs connected — offer a disconnect (revokes Markdrop's access at Google) */}
      {gStatus?.configured && gStatus.connected && (
        <div className="mb-4 rounded-xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] p-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-800 dark:text-gray-200">Google Docs connected</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Use the ↗ Google Docs button on any document to export it. Disconnecting revokes Markdrop's access to your Google account.</p>
          </div>
          {confirmDisconnect ? (
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs text-gray-500 dark:text-gray-400">Revoke access?</span>
              <button onClick={handleDisconnect} disabled={disconnectBusy} className="text-sm px-3 py-1.5 rounded-lg border border-red-300 dark:border-red-900/60 vscode:border-[#5a3232] text-red-600 dark:text-red-400 vscode:text-[#f48771] hover:bg-red-50 dark:hover:bg-red-950/30 vscode:hover:bg-[#3a2626] transition-colors font-medium disabled:opacity-50">
                {disconnectBusy ? "Disconnecting…" : "Yes, disconnect"}
              </button>
              <button onClick={() => setConfirmDisconnect(false)} disabled={disconnectBusy} className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors font-medium disabled:opacity-50">
                Cancel
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirmDisconnect(true)} className="shrink-0 text-sm px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors font-medium">
              Disconnect
            </button>
          )}
        </div>
      )}

      {loading ? (
        <div className="py-6 flex justify-center">
          <MarkdropLoader label="Loading documents…" size="sm" />
        </div>
      ) : docs.length === 0 ? (
        <div className="text-center py-16 text-gray-500 dark:text-gray-400 border border-dashed border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] rounded-xl">
          {kindFilter === "artifact" ? (
            <>
              <p className="mb-2 font-medium">No artifacts yet.</p>
              <p className="text-sm">
                Publish an HTML page, PDF or spreadsheet and get a link that renders it.
              </p>
              <a href="/upload" className="inline-block mt-3 text-sm px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors">
                Publish an artifact
              </a>
            </>
          ) : (
            <>
              <p className="mb-2 font-medium">No documents yet.</p>
              <p className="text-sm">Create one, or open a document you made and click <span className="font-medium text-gray-700 dark:text-gray-300">Save to my account</span>.</p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-2.5">
          {docs.map((d) => (
            <div key={d.slug} className="group rounded-xl border border-gray-200 dark:border-white/[0.07] vscode:border-[#3c3c3c] bg-white dark:bg-white/[0.02] vscode:bg-[#252526] px-3.5 py-3 hover:border-gray-300 dark:hover:border-white/[0.14] hover:bg-gray-50 dark:hover:bg-white/[0.04] transition-colors">
              <div className="flex items-center gap-3">
                {/* Type at a glance, before the words. */}
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
                  d.kind === "artifact" ? "bg-purple-500/10 text-purple-400" : "bg-blue-500/10 text-blue-400"
                }`}>
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    {d.kind === "artifact"
                      ? <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></>
                      : <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></>}
                  </svg>
                </span>

                <div className="min-w-0 flex-1">
                  <a href={`/${d.slug}`} className="block truncate font-semibold text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4] hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                    {d.title || d.original_filename || d.slug}
                  </a>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
                    {d.kind === "artifact" && <ArtifactBadge renderer={d.renderer} label={d.type_label} />}
                    <span className="font-mono break-all">
                      /{[...(d.folder_path ?? []), d.slug].join("/")}
                    </span>
                    <span title="Views">· {d.views.toLocaleString()} view{d.views === 1 ? "" : "s"}</span>
                    {d.kind === "artifact"
                      ? <span title="File size">· {formatBytes(d.size_bytes)}</span>
                      : d.export_pdf_count > 0 && <span title="PDF exports">· {d.export_pdf_count} PDF{d.export_pdf_count === 1 ? "" : "s"}</span>}
                    {d.copy_url_count > 0 && <span title="Link copies">· {d.copy_url_count} copies</span>}
                    {d.encrypted && (
                      <span title="End-to-end encrypted. Stored as ciphertext — the title and preview aren't shown here because the key exists only in your link."
                            className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">🔐 Encrypted</span>
                    )}
                    {d.is_password_protected && <span title="Password protected">🔒</span>}
                    {d.vscode_synced && (
                      <span title="Synced with VS Code" className="inline-flex items-center gap-1 text-[#007acc] dark:text-[#4daafc] vscode:text-[#4fc1ff]">
                        <VSCodeIcon className="w-3 h-3" /> VS Code
                      </span>
                    )}
                    {d.workspace_id && (
                      <span title="Shared with a workspace" className="text-blue-600 dark:text-blue-400">· Shared</span>
                    )}
                    {d.google_doc_url && (
                      <span className={d.google_doc_stale ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}>
                        · {d.google_doc_stale ? "Google Doc stale" : "Google Doc synced"}
                      </span>
                    )}
                    {d.expires_at && <span className="text-amber-600 dark:text-amber-400">· expires {new Date(d.expires_at).toLocaleDateString()}</span>}
                    <span>· {new Date(d.created_at).toLocaleDateString()}</span>
                  </div>
                </div>

                {/* One or two quick actions appear on hover on a pointer device;
                    everything, including these, is always in the menu, so a
                    touch device is never short of a way in. */}
                <div className="hidden sm:flex items-center gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  {!d.encrypted && (
                    <button onClick={() => copyUrl(d.url, d.slug)}
                      className="rounded-lg border border-gray-200 dark:border-white/[0.09] px-2.5 py-1.5 text-[11.5px] text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.06] transition-colors">
                      {copied === d.slug ? "Copied" : "Copy link"}
                    </button>
                  )}
                  <a href={d.kind === "artifact" ? `/${d.slug}` : `/${d.slug}?edit=1`}
                     className="rounded-lg border border-gray-200 dark:border-white/[0.09] px-2.5 py-1.5 text-[11.5px] text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.06] transition-colors">
                    {d.kind === "artifact" ? "Open" : "Edit"}
                  </a>
                </div>

                <RowMenu
                  label={`Actions for ${d.title || d.slug}`}
                  items={((): MenuItem[] => {
                    const items: MenuItem[] = [
                      { label: expanded === d.slug ? "Hide analytics" : "Analytics",
                        onClick: () => setExpanded(expanded === d.slug ? null : d.slug) },
                    ];
                    // No copy link for an encrypted document: the key lives in
                    // the link's fragment and was never sent here, so this could
                    // only ever produce a link that opens to "no key".
                    if (d.encrypted) {
                      items.push({ label: "Link holds the key", disabled: true });
                    } else {
                      items.push({ label: copied === d.slug ? "Copied" : "Copy link",
                                   onClick: () => copyUrl(d.url, d.slug) });
                    }
                    items.push(d.kind === "artifact"
                      ? { label: "Open artifact", href: `/${d.slug}` }
                      : { label: "Edit", href: `/${d.slug}?edit=1` });

                    if (gStatus?.connected && d.kind !== "artifact" && !d.encrypted) {
                      if (d.google_doc_url) {
                        items.push({ label: "Open in Google Docs", href: d.google_doc_url, external: true, separated: true });
                        items.push({ label: exportBusy === d.slug ? "Syncing…" : d.google_doc_stale ? "Sync to Google" : "Re-sync to Google",
                                     onClick: () => handleExport(d), busy: exportBusy === d.slug });
                      } else {
                        items.push({ label: exportBusy === d.slug ? "Exporting…" : "Export to Google Docs",
                                     onClick: () => handleExport(d), busy: exportBusy === d.slug, separated: true });
                      }
                    }

                    items.push({ label: "Change URL", onClick: () => openRename(d.slug), separated: true });
                    items.push({ label: d.workspace_id ? "Workspace sharing" : "Share to workspace",
                                 onClick: () => setShareFor(d.id) });
                    items.push({ label: "Delete", onClick: () => setDeleteFor(d.slug), danger: true, separated: true });
                    return items;
                  })()}
                />
              </div>

              {/* Private by default. The dialog states the consequences before
                  it does anything; the row just opens it. */}
              {shareFor === d.id && (
                <ShareToWorkspace
                  hideTrigger
                  open
                  onOpenChange={(v) => !v && setShareFor(null)}
                  documentId={d.id}
                  title={d.title || d.original_filename || d.slug}
                  workspaceId={d.workspace_id ?? null}
                  onChanged={load}
                />
              )}

              {expanded === d.slug && <AnalyticsPanel slug={d.slug} />}
            </div>
          ))}
        </div>
      )}

      {/* Change URL modal */}
      {renameFor && (
        <Modal title="Change document URL" onClose={() => setRenameFor(null)}>
          <form onSubmit={submitRename} className="space-y-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">Existing links to the old URL will stop working. Analytics are preserved.</p>
            <div className="flex items-center gap-1.5 bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg px-3 py-2.5 focus-within:border-blue-500 transition-colors">
              <span className="text-sm text-gray-400 shrink-0">markdrop.in/</span>
              <input
                autoFocus value={renameValue}
                onChange={(e) => setRenameValue(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))}
                maxLength={50}
                className="flex-1 bg-transparent outline-none text-sm font-mono text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] min-w-0"
              />
            </div>
            {renameError && <p className="text-xs text-red-500">{renameError}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setRenameFor(null)} className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
              <button type="submit" disabled={renameBusy || renameValue.length < 3} className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition-colors">
                {renameBusy ? "Saving…" : "Change URL"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      </div>

      {/* Delete confirm modal */}
      {deleteFor && (
        <Modal title="Delete document?" onClose={() => setDeleteFor(null)}>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            Permanently delete <span className="font-mono text-gray-800 dark:text-gray-100">/{deleteFor}</span>? This cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setDeleteFor(null)} className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
            <button onClick={confirmDelete} disabled={deleteBusy} className="px-4 py-2 text-sm rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-medium transition-colors">
              {deleteBusy ? "Deleting…" : "Delete"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
