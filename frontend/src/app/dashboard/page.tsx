"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import {
  listMyDocuments, getAnalytics, deleteDocument, changeSlug,
  MyDocListItem, Analytics,
} from "@/lib/api";
import Modal from "@/components/Modal";

type Range = "7d" | "30d" | "all";

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] p-3">
      <div className="text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4]">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
    </div>
  );
}

function BarRow({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-28 truncate text-gray-600 dark:text-gray-300" title={label}>{label}</span>
      <div className="flex-1 h-3 rounded bg-gray-100 dark:bg-gray-800 vscode:bg-[#2d2d2d] overflow-hidden">
        <div className="h-full bg-blue-500/70" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right tabular-nums text-gray-500">{value}</span>
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
              className={`px-2 py-0.5 text-xs rounded transition-colors ${range === r ? "bg-blue-600 text-white" : "text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-800"}`}>
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
              <div className="text-xs text-gray-500 mb-1.5">Views over time</div>
              <div className="flex items-end gap-0.5 h-20">
                {data.timeseries.map((t) => (
                  <div key={t.date} className="flex-1 bg-blue-500/60 rounded-t hover:bg-blue-500 transition-colors" style={{ height: `${(t.views / maxDay) * 100}%` }} title={`${t.date}: ${t.views}`} />
                ))}
              </div>
            </div>
          )}

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-gray-500 mb-1.5">Top countries</div>
              {data.countries.length ? (
                <div className="space-y-1">{data.countries.map((c) => <BarRow key={c.country} label={c.country} value={c.views} max={maxCountry} />)}</div>
              ) : <p className="text-xs text-gray-400">No geo data yet.</p>}
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1.5">Top referrers</div>
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

function ActionButton({ onClick, href, children, danger }: { onClick?: () => void; href?: string; children: React.ReactNode; danger?: boolean }) {
  const cls = `inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
    danger
      ? "border-red-200 dark:border-red-900/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
      : "border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d]"
  }`;
  return href ? <a href={href} className={cls}>{children}</a> : <button onClick={onClick} className={cls}>{children}</button>;
}

export default function DashboardPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [docs, setDocs] = useState<MyDocListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Modal state
  const [renameFor, setRenameFor] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteFor, setDeleteFor] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await listMyDocuments();
      setDocs(res.documents);
    } catch {
      /* redirect handled below */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { router.replace("/login?next=/dashboard"); return; }
    load();
  }, [authLoading, user, router, load]);

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
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold">Your documents</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{docs.length} document{docs.length === 1 ? "" : "s"}</p>
        </div>
        <a href="/" className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors">+ New document</a>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">Loading documents…</p>
      ) : docs.length === 0 ? (
        <div className="text-center py-16 text-gray-500 dark:text-gray-400 border border-dashed border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] rounded-xl">
          <p className="mb-2 font-medium">No documents yet.</p>
          <p className="text-sm">Create one, or open a document you made and click <span className="font-medium text-gray-700 dark:text-gray-300">Save to my account</span>.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {docs.map((d) => (
            <div key={d.slug} className="rounded-xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] p-4 hover:border-gray-300 dark:hover:border-gray-700 transition-colors">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <a href={`/${d.slug}`} className="font-semibold text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4] hover:text-blue-500 truncate block">
                    {d.title || d.slug}
                  </a>
                  <div className="text-xs text-gray-400 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-mono text-gray-500 dark:text-gray-400">/{d.slug}</span>
                    <span>👁 {d.views.toLocaleString()}</span>
                    <span>📄 {d.export_pdf_count}</span>
                    <span>🔗 {d.copy_url_count}</span>
                    {d.is_password_protected && <span>🔒</span>}
                    {d.expires_at && <span className="text-amber-500">expires {new Date(d.expires_at).toLocaleDateString()}</span>}
                    <span className="text-gray-300 dark:text-gray-600">·</span>
                    <span>{new Date(d.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <ActionButton onClick={() => setExpanded(expanded === d.slug ? null : d.slug)}>
                    {expanded === d.slug ? "Hide" : "📊 Analytics"}
                  </ActionButton>
                  <ActionButton onClick={() => copyUrl(d.url, d.slug)}>{copied === d.slug ? "Copied!" : "Copy link"}</ActionButton>
                  <ActionButton onClick={() => openRename(d.slug)}>Change URL</ActionButton>
                  <ActionButton href={`/${d.slug}?edit=1`}>Edit</ActionButton>
                  <ActionButton onClick={() => setDeleteFor(d.slug)} danger>Delete</ActionButton>
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
