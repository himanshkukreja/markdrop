"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import {
  listMyDocuments, getAnalytics, deleteDocument, changeSlug,
  MyDocListItem, Analytics,
} from "@/lib/api";

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
              className={`px-2 py-0.5 text-xs rounded ${range === r ? "bg-blue-600 text-white" : "text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-800"}`}>
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
                  <div key={t.date} className="flex-1 bg-blue-500/60 rounded-t" style={{ height: `${(t.views / maxDay) * 100}%` }} title={`${t.date}: ${t.views}`} />
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

export default function DashboardPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [docs, setDocs] = useState<MyDocListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await listMyDocuments();
      setDocs(res.documents);
    } catch {
      /* handled by redirect below */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { router.replace("/login?next=/dashboard"); return; }
    load();
  }, [authLoading, user, router, load]);

  async function onDelete(slug: string) {
    if (!confirm(`Delete "${slug}"? This cannot be undone.`)) return;
    try {
      await deleteDocument(slug);
      setDocs((d) => d.filter((x) => x.slug !== slug));
      setMsg("Document deleted.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function onRename(slug: string) {
    const next = prompt("New URL slug (3–50 chars, letters/numbers/-/_):", slug);
    if (!next || next === slug) return;
    try {
      await changeSlug(slug, next.trim());
      setMsg("URL changed.");
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Rename failed");
    }
  }

  if (authLoading || (!user && loading)) {
    return <div className="flex-1 flex items-center justify-center text-sm text-gray-400">Loading…</div>;
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">Your documents</h1>
        <a href="/" className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors">+ New</a>
      </div>

      {msg && <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">{msg}</p>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading documents…</p>
      ) : docs.length === 0 ? (
        <div className="text-center py-16 text-gray-500 dark:text-gray-400">
          <p className="mb-2">No documents yet.</p>
          <p className="text-sm">Create one, or open a document you made and click <span className="font-medium">Claim</span> to add it here.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {docs.map((d) => (
            <div key={d.slug} className="rounded-lg border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <a href={`/${d.slug}`} className="font-medium text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4] hover:text-blue-500 truncate block">
                    {d.title || d.slug}
                  </a>
                  <div className="text-xs text-gray-400 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span className="font-mono">/{d.slug}</span>
                    <span>{d.views.toLocaleString()} views</span>
                    <span>{d.export_pdf_count} PDF</span>
                    <span>{d.copy_url_count} copies</span>
                    {d.is_password_protected && <span>🔒 protected</span>}
                    {d.expires_at && <span>expires {new Date(d.expires_at).toLocaleDateString()}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0 text-xs">
                  <button onClick={() => setExpanded(expanded === d.slug ? null : d.slug)}
                    className="px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] text-gray-600 dark:text-gray-300">
                    {expanded === d.slug ? "Hide" : "Analytics"}
                  </button>
                  <button onClick={() => navigator.clipboard.writeText(d.url)}
                    className="px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] text-gray-600 dark:text-gray-300">Copy</button>
                  <button onClick={() => onRename(d.slug)}
                    className="px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] text-gray-600 dark:text-gray-300">URL</button>
                  <a href={`/${d.slug}`}
                    className="px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] text-gray-600 dark:text-gray-300">Edit</a>
                  <button onClick={() => onDelete(d.slug)}
                    className="px-2 py-1 rounded hover:bg-red-50 dark:hover:bg-red-950/40 text-red-500">Delete</button>
                </div>
              </div>
              {expanded === d.slug && <AnalyticsPanel slug={d.slug} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
