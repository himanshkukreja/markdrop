"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { StatTile } from "@/components/kit/StatTile";
import { Alert, Button, FileIcon, Pagination, Progress, Switch, Table, type Column } from "@/components/ui";
import { adminFeatureUsage, adminListShareEvents, type AdminShareEventItem, type FeatureUsage } from "@/lib/api";
import { RangePicker, rangeParams, useAdminFetch, type RangeValue } from "./analytics/controls";
import { BarList, ShareHealthCard, type Shares } from "./analytics/sections";
import { Card, CardError, CardSkeleton, CardTitle } from "./analytics/ui";
import { PageHead, bytes, fmtDateTime, iconRenderer, isUnauthorized, plural, useOnUnauthorized, LoadingBlock } from "./shared";

/**
 * Product health (D29): the old "Feature usage" tab merged with the file-sharing health card.
 * Adoption tiles and artifacts by type are all-time; the file-sharing card follows the range.
 */
export function ProductHealthPanel({ token, range, onRange }: { token: string; range: RangeValue; onRange: (r: RangeValue) => void }) {
  const onUnauthorized = useOnUnauthorized();
  const get = useAdminFetch(token);
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);

  const [usage, setUsage] = useState<{ data?: FeatureUsage; error?: boolean }>({});
  const [shares, setShares] = useState<{ data?: Shares; error?: boolean }>({});
  const [sharesLoading, setSharesLoading] = useState(false);

  const loadUsage = useCallback(() => {
    adminFeatureUsage(token).then((d) => setUsage({ data: d })).catch((e) => { if (isUnauthorized(e)) onUnauthorized(); else setUsage((u) => ({ ...u, error: true })); });
  }, [token, onUnauthorized]);
  useEffect(() => { loadUsage(); }, [loadUsage]);

  const loadShares = useCallback(() => {
    setSharesLoading(true);
    get<Shares>("shares", rangeParams(range, tz))
      .then((d) => setShares({ data: d }))
      .catch(() => setShares((s) => ({ ...s, error: true })))
      .finally(() => setSharesLoading(false));
  }, [get, range, tz]);
  useEffect(() => { loadShares(); }, [loadShares]);

  const u = usage.data;
  const c = u?.share_connections;
  const pct = (n: number) => (c && c.rooms ? `${Math.round((n / c.rooms) * 100)}%` : "—");

  return (
    <div className="flex flex-col gap-5">
      <PageHead title="Product health" caption="Feature adoption from Markdrop's own records, and how file sharing is holding up." />

      <section aria-labelledby="adoption-h" className="flex flex-col gap-3">
        <h2 id="adoption-h" className="text-h4 text-text">Adoption <span className="text-caption font-normal text-text-secondary">· all time</span></h2>
        {usage.error && !u ? (
          <Alert tone="danger" actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={() => { setUsage({}); loadUsage(); }}>Retry</Button>}>
            Couldn&apos;t load feature usage.
          </Alert>
        ) : (
          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
            <StatTile size="md" icon="doc" loading={!u} label="Artifacts published" value={u ? u.artifact_total.toLocaleString("en") : ""}
              caption={u ? `${plural(u.artifact_users, "publisher")} · ${bytes(u.artifact_bytes)} stored${u.artifact_protected ? ` · ${u.artifact_protected} protected` : ""}` : undefined} />
            <StatTile size="md" icon="refresh" loading={!u} label="VS Code sync" value={u ? u.vscode_users_synced.toLocaleString("en") : ""}
              caption={u ? `People who synced · ${u.vscode_users_with_token} made a token · ${plural(u.vscode_tokens_total, "token")} in all` : undefined} />
            <StatTile size="md" icon="google" loading={!u} label="Google Drive" value={u ? u.google_connected_users.toLocaleString("en") : ""}
              caption={u ? `People connected · ${plural(u.google_exported_docs, "doc")} exported` : undefined} />
            <StatTile size="md" icon="send" loading={!u} label="Files shared" value={u ? u.share_events_total.toLocaleString("en") : ""}
              caption={u ? `${plural(u.share_users_identified, "signed-in sender")} · ${u.share_events_anonymous.toLocaleString("en")} anonymous` : undefined} />
          </div>
        )}
        {c && c.rooms > 0 && (
          <p className="text-caption text-text-secondary">
            Connections in the last 30 days: <span className="font-semibold text-text">{pct(c.connected)}</span> connected of {c.rooms.toLocaleString("en")} rooms,
            {" "}{c.relayed.toLocaleString("en")} via the relay
            {c.failed > 0 && <>; {c.failed} failed ({c.failed_no_stun} STUN blocked, {c.failed_with_stun} with no direct path)</>}.
          </p>
        )}
      </section>

      {u && (
        <Card aria-labelledby="types-h">
          <CardTitle id="types-h" title="Artifacts by type" sub="Count and storage for every artifact published" />
          <BarList label="Artifacts by type" empty="No artifacts yet."
            rows={u.artifact_by_type.map((t) => ({
              key: `${t.label} · ${bytes(t.bytes)}`,
              n: t.count,
              icon: <FileIcon renderer={iconRenderer(t.renderer)} size={16} />,
            }))} />
        </Card>
      )}

      {sharesLoading && shares.data && <Progress indeterminate size="sm" aria-label="Updating file sharing" valueText="Loading" />}
      {shares.data ? <ShareHealthCard data={shares.data} tz={tz} right={<RangePicker value={range} onChange={onRange} />} />
        : shares.error ? <CardError title="File sharing" onRetry={() => { setShares({}); loadShares(); }} />
        : <CardSkeleton title="File sharing" height={320} />}

      <ShareLog token={token} />
    </div>
  );
}

function ShareLog({ token }: { token: string }) {
  const onUnauthorized = useOnUnauthorized();
  const [page, setPage] = useState(1);
  const [identified, setIdentified] = useState(false);
  const [rows, setRows] = useState<AdminShareEventItem[] | null>(null);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    setError(false);
    adminListShareEvents(token, page, identified)
      .then((ev) => { setRows(ev.events); setPages(ev.pages); setTotal(ev.total); })
      .catch((e) => { if (isUnauthorized(e)) onUnauthorized(); else setError(true); });
  }, [token, page, identified, onUnauthorized]);
  useEffect(() => { load(); }, [load]);

  const cols: Column<AdminShareEventItem>[] = [
    { key: "file", header: "File", primary: true, render: (e) => (
      <span className="flex min-w-0 items-center gap-2.5">
        <FileIcon name={e.file_name ?? ""} mime={e.mime_type ?? ""} size={20} />
        <span className="flex min-w-0 flex-col">
          <span className="max-w-72 truncate text-text" title={e.file_name ?? undefined} dir="auto">{e.file_name ?? <span className="italic text-text-secondary">Unknown file</span>}</span>
          {e.mime_type && <span className="truncate text-micro text-text-muted">{e.mime_type}</span>}
        </span>
      </span>
    ) },
    { key: "size", header: "Size", align: "right", render: (e) => (e.file_size != null ? bytes(e.file_size) : "—") },
    { key: "sender", header: "Sender", render: (e) => (e.user_email ? <span className="truncate" title={e.user_id ?? undefined}>{e.user_email}</span> : <span className="text-text-muted">Anonymous</span>) },
    { key: "when", header: "When", render: (e) => <span className="whitespace-nowrap">{fmtDateTime(e.ts)}</span> },
  ];

  return (
    <Card aria-labelledby="sharelog-h">
      <CardTitle id="sharelog-h" title="File share log" sub={`${plural(total, "file")} sent${identified ? " by signed-in people" : ""}. Markdrop keeps file details and connection info; the files themselves are never stored.`}
        right={<Switch label="Signed-in only" checked={identified} onChange={(e) => { setIdentified(e.target.checked); setPage(1); }} />} />
      {error ? (
        <Alert tone="danger" actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={load}>Retry</Button>}>Couldn&apos;t load the share log.</Alert>
      ) : !rows ? (
        <LoadingBlock label="Loading the share log" minHeight={220} />
      ) : (
        <>
          <Table compact hover={false} columns={cols} rows={rows} rowKey={(e) => e.id} caption="File share log"
            empty={identified ? "No shares from signed-in people yet." : "No file shares recorded yet."} />
          {pages > 1 && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-caption text-text-secondary">Page {page} of {pages}</p>
              <Pagination page={page} pageCount={pages} onChange={setPage} />
            </div>
          )}
        </>
      )}
    </Card>
  );
}
