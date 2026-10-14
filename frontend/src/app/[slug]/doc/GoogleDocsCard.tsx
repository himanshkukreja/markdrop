"use client";

import { Alert, Badge, Button } from "@/components/ui";

export interface GoogleDocsState {
  url: string | null;
  stale: boolean;
  busy: boolean;
  error: string | null;
  needsReconnect: boolean;
}

/**
 * Google Docs, reskinned only (D7): the same three states as before — not linked ("Publish to
 * Google Docs"), linked and stale ("Sync to Google Docs"), linked and current ("Synced to
 * Google", click to re-sync) — plus "Open Doc". Owner + connected + not encrypted; the caller
 * decides that.
 */
export function GoogleDocsCard({
  g, onExport, onReconnect, onDismissError,
}: {
  g: GoogleDocsState;
  onExport: () => void;
  onReconnect: () => void;
  onDismissError: () => void;
}) {
  return (
    <section aria-labelledby="md-details-gdocs" className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id="md-details-gdocs" className="text-eyebrow text-text-muted">Google Docs</h2>
        {g.url && (g.stale
          ? <Badge tone="warning" size="sm" icon="refresh">Changes not synced</Badge>
          : <Badge tone="success" size="sm" icon="check">Synced</Badge>)}
      </div>
      {g.url ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" href={g.url} target="_blank" rel="noopener noreferrer" iconLeft="external">
            Open Doc
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onExport}
            loading={g.busy}
            iconLeft="refresh"
            title={g.stale
              ? "This document changed since the last sync — push the latest content to Google Docs"
              : "Up to date with Google Docs — click to re-sync"}
          >
            {g.busy ? "Syncing to Google…" : g.stale ? "Sync to Google Docs" : "Synced to Google"}
          </Button>
        </div>
      ) : (
        <Button variant="secondary" size="sm" onClick={onExport} loading={g.busy} iconLeft="google" className="self-start">
          {g.busy ? "Publishing…" : "Publish to Google Docs"}
        </Button>
      )}
      {g.error && (
        <Alert
          tone="danger"
          onDismiss={onDismissError}
          actions={g.needsReconnect ? <Button variant="link" size="sm" onClick={onReconnect}>Reconnect Google Docs</Button> : undefined}
        >
          {g.error}
        </Alert>
      )}
    </section>
  );
}
