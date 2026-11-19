"use client";

/**
 * "Imported from Notion" at the top of a page that came from Notion (the read's `source`, backend
 * services/notion_import/source.py). Quiet provenance for every reader ("From Notion · Open in Notion");
 * for people who can edit a Connect Notion import, its sync status ("Synced 5 min ago" / "Not synced");
 * for the person whose sync it is, Sync now and a link to their sync settings. Nothing about anyone's
 * Notion connection is shown to anyone else.
 */
import { useState } from "react";
import { Button, useToast } from "@/components/ui";
import { syncNotionNow } from "@/lib/notionConnect";
import type { NotionSource } from "@/lib/notionSource";
import "./notionSource.css";

function ago(iso: string | null): string | null {
  if (!iso) return null;
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return null;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `on ${new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

function status(sync: NonNullable<NotionSource["sync"]>): string {
  if (sync.state === "on") {
    const when = ago(sync.last_synced_at);
    return when ? `Synced ${when}` : "Keeping in sync";
  }
  if (sync.state === "edited") return "Not synced: edited in Markdrop";
  if (sync.state === "paused") return "Sync paused";
  return "Not synced";
}

export function NotionSourceStrip({ source, settingsHref = "/settings/integrations/notion" }: {
  source: NotionSource;
  /** Where the sync's settings are (null on a workspace's own domain: no link). */
  settingsHref?: string | null;
}) {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const sync = source.sync;
  const mine = !!sync?.id;
  const syncNow = async () => {
    if (!sync?.id) return;
    setRunning(true);
    try {
      await syncNotionNow(sync.id);
      toast.success("Syncing from Notion. Changes show here in a minute.");
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : "Couldn't start the sync.");
      setRunning(false);
    }
  };
  return (
    <div className="nsrc no-print" data-testid="notion-source" role="note" aria-label="Where this page came from">
      <span className="nsrc-mark" aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element -- tiny static SVG */}
        <img src="/brands/notion.svg" alt="" width={14} height={14} className="nsrc-light" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brands/notion-white.svg" alt="" width={14} height={14} className="nsrc-dark" />
      </span>
      <span className="nsrc-label">{sync ? "Imported from Notion" : "From Notion"}</span>
      {sync && <span className="nsrc-sep" aria-hidden>·</span>}
      {sync && <span className={`nsrc-state nsrc-state--${sync.state}`} data-testid="notion-source-state">{running ? "Syncing…" : status(sync)}</span>}
      {source.url && (
        <>
          <span className="nsrc-sep" aria-hidden>·</span>
          <a className="nsrc-link" href={source.url} target="_blank" rel="noopener noreferrer" data-testid="notion-source-open">
            Open in Notion<span aria-hidden> ↗</span>
          </a>
        </>
      )}
      {mine && (
        <span className="nsrc-actions">
          <Button size="sm" variant="ghost" iconLeft="refresh" loading={running} disabled={running || sync?.state === "edited"} onClick={() => void syncNow()} data-testid="notion-source-sync">
            Sync now
          </Button>
          {settingsHref && <a className="nsrc-link" href={settingsHref}>Sync settings</a>}
        </span>
      )}
    </div>
  );
}
