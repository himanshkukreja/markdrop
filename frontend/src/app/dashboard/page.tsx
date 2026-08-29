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
import Spinner from "@/components/Spinner";
import VSCodeIcon from "@/components/VSCodeIcon";

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
        <p className="text-xs text-gray-400 py-4 text-center">Loading…</p>
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
function ReloadIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      className={`w-3.5 h-3.5${spinning ? " animate-spin" : ""}`}
      viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function ActionButton({
  onClick, href, children, variant = "default", active = false, title,
}: {
  onClick?: () => void; href?: string; children: React.ReactNode;
  variant?: BtnVariant; active?: boolean; title?: string;
}) {
  const base =
    "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors whitespace-nowrap select-none";
  // Every variant is tuned for all three themes: light / night-blue (dark:) /
  // VS Code grey (vscode:). Delete is a neutral ghost that only reddens on hover
  // so the resting toolbar reads calm and professional on every theme.
  const variants: Record<BtnVariant, string> = {
    default:
      "border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] " +
      "text-gray-600 dark:text-gray-300 vscode:text-[#cccccc] " +
      "hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-800 dark:hover:text-white vscode:hover:bg-[#2a2d2e]",
    success:
      "border-emerald-200 dark:border-emerald-900/50 vscode:border-[#2e4034] " +
      "text-emerald-600 dark:text-emerald-400 vscode:text-[#4ec9b0] " +
      "hover:bg-emerald-50 dark:hover:bg-emerald-950/30 vscode:hover:bg-[#26332b]",
    warning:
      "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 " +
      "dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20 " +
      "vscode:border-[#665c33] vscode:bg-[#3a3320] vscode:text-[#e2c08d] vscode:hover:bg-[#4a4126]",
    danger:
      "border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] " +
      "text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] " +
      "hover:border-red-300 hover:bg-red-50 hover:text-red-600 " +
      "dark:hover:border-red-900/60 dark:hover:bg-red-950/40 dark:hover:text-red-400 " +
      "vscode:hover:border-[#5a3232] vscode:hover:bg-[#3a2626] vscode:hover:text-[#f48771]",
  };
  const activeCls = active
    ? " bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white vscode:bg-[#2a2d2e] vscode:text-white"
    : "";
  const cls = `${base} ${variants[variant]}${activeCls}`;
  return href ? (
    <a href={href} title={title} className={cls}>{children}</a>
  ) : (
    <button onClick={onClick} title={title} className={cls}>{children}</button>
  );
}

export default function DashboardPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [docs, setDocs] = useState<MyDocListItem[]>([]);
  const [kindFilter, setKindFilter] = useState<DocKind | "all">("all");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

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
    return <div className="flex-1 flex items-center justify-center text-sm text-gray-400">Loading…</div>;
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold">Your documents</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{docs.length} document{docs.length === 1 ? "" : "s"}</p>
        </div>
        <a href="/new" className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors">+ New document</a>
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

      <div className="flex items-center gap-1 mb-4 p-1 rounded-xl bg-gray-100/70 dark:bg-gray-900/50 vscode:bg-[#1e1e1e] w-fit">
        {([
          { id: "all", label: "All" },
          { id: "markdown", label: "Documents" },
          { id: "artifact", label: "Artifacts" },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => { setLoading(true); setKindFilter(t.id as DocKind | "all"); }}
            aria-pressed={kindFilter === t.id}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-lg transition-all ${
              kindFilter === t.id
                ? "bg-white dark:bg-gray-800 vscode:bg-[#2d2d2d] text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4] shadow-sm"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">Loading documents…</p>
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
            <div key={d.slug} className="rounded-xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-white dark:bg-gray-900/40 vscode:bg-[#252526] p-4 hover:border-gray-300 dark:hover:border-gray-700 vscode:hover:border-[#4c4c4c] transition-colors">
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <a href={`/${d.slug}`} className="font-semibold text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4] hover:text-blue-600 dark:hover:text-blue-400 vscode:hover:text-[#4daafc] truncate block transition-colors">
                    {d.title || d.original_filename || d.slug}
                  </a>
                  <div className="text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    {d.kind === "artifact" && (
                      <ArtifactBadge renderer={d.renderer} label={d.type_label} />
                    )}
                    <span className="font-mono text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] break-all">/{d.slug}</span>
                    <span title="Views">👁 {d.views.toLocaleString()}</span>
                    {d.kind === "artifact" ? (
                      <span title="File size">{formatBytes(d.size_bytes)}</span>
                    ) : (
                      <span title="PDF exports">📄 {d.export_pdf_count}</span>
                    )}
                    <span title="Link copies">🔗 {d.copy_url_count}</span>
                    {d.is_password_protected && <span title="Password protected">🔒</span>}
                    {d.vscode_synced && (
                      <span title="Synced with VS Code" className="inline-flex items-center gap-1 text-[#007acc] dark:text-[#4daafc] vscode:text-[#4fc1ff]">
                        <VSCodeIcon className="w-3 h-3" /> VS Code
                      </span>
                    )}
                    {d.expires_at && <span className="text-amber-600 dark:text-amber-400 vscode:text-[#cca700]">expires {new Date(d.expires_at).toLocaleDateString()}</span>}
                    <span className="text-gray-300 dark:text-gray-600 vscode:text-[#5a5a5a]">·</span>
                    <span>{new Date(d.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap sm:shrink-0 sm:justify-end">
                  <ActionButton onClick={() => setExpanded(expanded === d.slug ? null : d.slug)} active={expanded === d.slug}>
                    {expanded === d.slug ? "Hide" : "Analytics"}
                  </ActionButton>
                  <ActionButton onClick={() => copyUrl(d.url, d.slug)} active={copied === d.slug}>
                    {copied === d.slug ? "Copied" : "Copy link"}
                  </ActionButton>
                  {gStatus?.connected && d.kind !== "artifact" && (
                    d.google_doc_url ? (
                      <>
                        <ActionButton href={d.google_doc_url} title="Open in Google Docs">Open Doc</ActionButton>
                        {d.google_doc_stale ? (
                          <ActionButton onClick={() => handleExport(d)} variant="warning" title="This document changed since the last sync — click to update the Google Doc">
                            <ReloadIcon spinning={exportBusy === d.slug} />
                            {exportBusy === d.slug ? "Syncing…" : "Sync to Google"}
                          </ActionButton>
                        ) : (
                          <ActionButton onClick={() => handleExport(d)} variant="success" title="Up to date — click to re-sync">
                            {exportBusy === d.slug ? "Syncing…" : "Synced"}
                          </ActionButton>
                        )}
                      </>
                    ) : (
                      <ActionButton onClick={() => handleExport(d)} title="Export to Google Docs">
                        {exportBusy === d.slug && <Spinner className="w-3.5 h-3.5" />}
                        {exportBusy === d.slug ? "Exporting…" : "Google Docs"}
                      </ActionButton>
                    )
                  )}
                  {d.kind === "artifact" ? (
                    <ActionButton href={`/${d.slug}`} title="Open the rendered artifact">Open</ActionButton>
                  ) : (
                    <ActionButton href={`/${d.slug}?edit=1`}>Edit</ActionButton>
                  )}
                  <ActionButton onClick={() => openRename(d.slug)}>Change URL</ActionButton>
                  <span className="mx-0.5 h-5 w-px bg-gray-200 dark:bg-gray-700 vscode:bg-[#3c3c3c]" aria-hidden />
                  <ActionButton onClick={() => setDeleteFor(d.slug)} variant="danger">Delete</ActionButton>
                </div>
              </div>
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
