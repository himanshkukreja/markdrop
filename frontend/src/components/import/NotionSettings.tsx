"use client";

/**
 * Settings › Integrations › Notion: the Notion workspaces connected (Reconnect, Disconnect), Import from Notion
 * (the dialog, on "From Notion"), and every import kept in sync: when it last synced, Keep in sync on/off,
 * Sync now, Stop syncing, and the pages edited in Markdrop that no longer sync. Polls while a sync runs.
 * Arriving with ?notion=connected (back from Notion's consent screen) opens the import picker.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, ConfirmDialog, Icon, Skeleton, Switch, useToast } from "@/components/ui";
import { BrandMark } from "@/components/integrations/BrandMark";
import {
  connectNotion, disconnectNotion, notionStatus, removeNotionSync, setKeepInSync, syncNotionNow,
  type NotionConnection, type NotionStatus, type NotionSync,
} from "@/lib/notionConnect";
import { useNotionImport } from "./useNotionImport";
import "./notionImport.css";

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function where(s: NotionSync): string {
  const d = s.destination;
  if (d.kind === "personal") return "My files";
  return [d.workspace_name, d.team_name, d.folder_name].filter(Boolean).join(" › ");
}

function StateBadge({ s }: { s: NotionSync }) {
  if (s.state === "syncing") return <Badge tone="info" live>Syncing</Badge>;
  if (s.paused === "connection") return <Badge tone="warning" icon="alertCircle">Paused: reconnect Notion</Badge>;
  if (s.paused === "access") return <Badge tone="warning" icon="lock">Paused: no access</Badge>;
  if (s.state === "failed") return <Badge tone="danger" icon="alertCircle">Didn&apos;t sync</Badge>;
  if (!s.keep_in_sync) return <Badge tone="neutral">Not kept in sync</Badge>;
  return <Badge tone="success" dot>In sync</Badge>;
}

export function NotionSettings() {
  const toast = useToast();
  const [st, setSt] = useState<NotionStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [disconnect, setDisconnect] = useState<NotionConnection | null>(null);
  const [stop, setStop] = useState<NotionSync | null>(null);
  const notion = useNotionImport({ workspace: null, team: null, source: "notion" });
  const opened = useRef(false);

  const load = useCallback(async () => {
    try { setSt(await notionStatus()); setErr(null); } catch (e) { setErr(errText(e, "Couldn't load your Notion connection.")); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // An import started from the dialog adds a row: look again now and then.
  useEffect(() => { const t = window.setInterval(() => void load(), 10000); return () => window.clearInterval(t); }, [load]);

  // Back from Notion: open the picker once.
  useEffect(() => {
    if (opened.current || !st || typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    if (q.get("notion") === "connected" && st.connections.length) {
      opened.current = true;
      notion.open();
      q.delete("notion");
      const rest = q.toString();
      window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash);
    }
  }, [st, notion]);

  // While a sync runs (or one was just asked for), look again every few seconds.
  const syncing = st?.syncs.some((s) => s.state === "syncing");
  useEffect(() => {
    if (!syncing) return;
    const t = window.setTimeout(() => void load(), 3000);
    return () => window.clearTimeout(t);
  }, [syncing, st, load]);

  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try { await fn(); if (ok) toast.success(ok); await load(); } catch (e) { toast.error(errText(e, "That didn't work. Try again.")); } finally { setBusy(null); }
  };

  if (err) return <Alert tone="danger">{err}</Alert>;
  if (!st) return <div className="nsy"><Skeleton height={64} /><Skeleton height={120} /></div>;
  if (!st.configured) {
    return <Alert tone="neutral" icon="info">Connect Notion isn&apos;t set up on this Markdrop yet. You can still import a Notion export file from Create › Import.</Alert>;
  }

  const connected = st.connections.length > 0;
  return (
    <div className="nsy" data-testid="notion-settings">
      <section className="nsy-section">
        <div className="nsy-head">
          <h2>Notion workspaces</h2>
          {connected && (
            <div className="nsy-actions">
              <Button variant="secondary" iconLeft="plus" onClick={() => void act("connect", () => connectNotion("/settings/integrations/notion"))} loading={busy === "connect"}>Add pages or workspace</Button>
              <Button iconLeft="download" onClick={notion.open} data-testid="notion-open-import">Import from Notion</Button>
            </div>
          )}
        </div>
        {!connected ? (
          <div className="ni-connect">
            <BrandMark brand="notion" size={44} />
            <h3>Connect your Notion</h3>
            <p>Approve Markdrop in Notion and choose the pages it may read. Markdrop only reads them: it never changes anything in Notion.</p>
            <Button iconLeft="link" onClick={() => void act("connect", () => connectNotion("/settings/integrations/notion"))} loading={busy === "connect"} data-testid="notion-connect-btn">Connect Notion</Button>
          </div>
        ) : (
          <ul className="nsy-list">
            {st.connections.map((c) => (
              <li key={c.id} className="nsy-conn" data-testid="notion-connection">
                <BrandMark brand="notion" size={36} />
                <span className="nsy-conn__text">
                  <span className="nsy-conn__name">{c.workspace_name}</span>
                  <span className="nsy-conn__sub">{c.owner_email ? `Connected as ${c.owner_email}` : "Connected"} · read-only</span>
                </span>
                {c.broken && <Badge tone="warning" icon="alertCircle">Reconnect</Badge>}
                <div className="nsy-actions">
                  {c.broken && <Button size="sm" onClick={() => void act("connect", () => connectNotion("/settings/integrations/notion"))}>Reconnect</Button>}
                  <Button size="sm" variant="ghost" iconLeft="logOut" onClick={() => setDisconnect(c)}>Disconnect</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {connected && (
        <section className="nsy-section">
          <div className="nsy-head">
            <h2>Imported from Notion</h2>
            <span className="ni-picked">Keep in sync checks about every {st.sync_minutes} minutes, one way: Notion → Markdrop.</span>
          </div>
          {st.syncs.length === 0 ? (
            <p className="m-0 text-[13px] text-text-secondary">Nothing imported yet. Choose <b>Import from Notion</b> and tick the pages to bring over.</p>
          ) : (
            <ul className="nsy-list" data-testid="notion-syncs">
              {st.syncs.map((s) => (
                <li key={s.id} className="nsy-item" data-testid="notion-sync">
                  <div className="nsy-line">
                    <span className="nsy-title">
                      <Icon name={s.root_kind === "database" ? "table" : "doc"} />
                      {s.url ? <a href={s.url}>{s.title}</a> : <span>{s.title}</span>}
                    </span>
                    <StateBadge s={s} />
                  </div>
                  <div className="nsy-line">
                    <div className="nsy-meta">
                      <span><Icon name="folder" />{where(s)}</span>
                      <span><Icon name="refresh" />Synced {ago(s.last_synced_at)}</span>
                      {s.counts.updated ? <span>{s.counts.updated} updated last time</span> : null}
                    </div>
                    <div className="nsy-actions">
                      <Switch checked={s.keep_in_sync} label="Keep in sync" disabled={busy === `keep:${s.id}`}
                        onChange={(e) => void act(`keep:${s.id}`, () => setKeepInSync(s.id, e.target.checked))} />
                      <Button size="sm" variant="secondary" iconLeft="refresh" loading={busy === `run:${s.id}` || s.state === "syncing"}
                        disabled={s.state === "syncing" || s.paused === "connection"} onClick={() => void act(`run:${s.id}`, () => syncNotionNow(s.id))}
                        data-testid="notion-sync-now">Sync now</Button>
                      <Button size="sm" variant="ghost" onClick={() => setStop(s)} aria-label={`Stop following ${s.title}`}>Stop</Button>
                    </div>
                  </div>
                  {s.last_error && s.state !== "syncing" && <p className="nsy-err">{s.last_error}</p>}
                  {s.edited_in_markdrop.length > 0 && (
                    <div className="nsy-edited" data-testid="notion-edited">
                      <Badge tone="warning" size="sm">Edited in Markdrop</Badge>{" "}
                      {s.edited_in_markdrop.length === 1 ? "This page was" : `${s.edited_in_markdrop.length} pages were`} changed here, so {s.edited_in_markdrop.length === 1 ? "it's" : "they're"} kept as {s.edited_in_markdrop.length === 1 ? "it is" : "they are"} and no longer synced:
                      <ul>{s.edited_in_markdrop.slice(0, 12).map((d) => <li key={d.slug}><a href={d.url}>{d.title}</a></li>)}</ul>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <ConfirmDialog open={!!disconnect} onClose={() => setDisconnect(null)} title={`Disconnect ${disconnect?.workspace_name ?? "Notion"}?`}
        body="Markdrop forgets its access to this Notion workspace and stops syncing from it. The pages you imported stay in Markdrop."
        confirmLabel="Disconnect"
        onConfirm={async () => { if (disconnect) await act("disc", () => disconnectNotion(disconnect.id), "Notion is disconnected."); setDisconnect(null); }} />
      <ConfirmDialog open={!!stop} onClose={() => setStop(null)} title={`Stop following ${stop?.title ?? "this import"}?`}
        body="It won't sync from Notion any more. The imported pages stay in Markdrop." confirmLabel="Stop syncing" tone="default"
        onConfirm={async () => { if (stop) await act("stop", () => removeNotionSync(stop.id)); setStop(null); }} />
      {notion.dialog}
    </div>
  );
}
