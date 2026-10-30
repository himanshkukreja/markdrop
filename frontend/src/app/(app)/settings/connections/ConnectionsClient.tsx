"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, Icon, RowMenu, useToast } from "@/components/ui";
import { PageHeader } from "@/components/shell/PageHeader";
import { ReadMore } from "@/components/ReadMore";
import { ClientLogo } from "@/components/oauth/ClientLogo";
import { SCOPE_LABELS, disconnectApp, hostOf, listConnections, type OAuthConnection } from "@/lib/oauthClient";
import { SettingsLoader, relativeDays, shortDate, useRequireUser } from "../settings-shared";

/** "today", "3 days ago", or a date once it's more than a month back. */
function lastUsed(iso: string | null): string {
  if (!iso) return "Not used yet";
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (Number.isNaN(days)) return "Not used yet";
  return `Last used ${days > 30 ? shortDate(iso) : relativeDays(iso)}`;
}

function ScopeBadges({ scopes }: { scopes: string[] }) {
  if (!scopes.length) return null;
  return (
    <span className="flex flex-wrap gap-1.5">
      {scopes.map((sc) => (
        <Badge key={sc} tone="neutral" size="sm" icon={SCOPE_LABELS[sc]?.icon ?? "key"}>
          {SCOPE_LABELS[sc]?.short ?? sc}
        </Badge>
      ))}
    </span>
  );
}

/**
 * /settings/connections: AI apps (MCP clients) the user approved through /oauth/consent, with
 * Disconnect behind a ConfirmDialog (revokes every token and grant for that app). The account's
 * email never shows here, but app names and dates are the user's own: rows are ph-no-capture.
 */
export default function ConnectionsClient() {
  const { ready } = useRequireUser("/settings/connections");
  const toast = useToast();
  const [apps, setApps] = useState<OAuthConnection[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [removing, setRemoving] = useState<OAuthConnection | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setApps(await listConnections());
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  if (!ready || (apps === null && !failed)) return <SettingsLoader label="Loading your connected apps" />;

  async function disconnect() {
    const app = removing;
    if (!app) return;
    // A rejection keeps the dialog open and shows the message inside it (ConfirmDialog).
    try {
      await disconnectApp(app.client_id);
    } catch {
      throw new Error(`Couldn't disconnect ${app.name}. Check your connection and try again.`);
    }
    setApps((list) => (list ?? []).filter((a) => a.client_id !== app.client_id));
    setRemoving(null);
    toast.success(`Disconnected ${app.name}.`);
  }

  const connectCard = (
    <Card title="Connect an AI app" compact>
      <div className="flex min-w-0 flex-col gap-3">
        <span className="grid size-10 place-items-center rounded-lg bg-surface-inset text-accent-text" aria-hidden>
          <Icon name="sparkle" size={20} />
        </span>
        <p className="text-caption text-text-secondary">
          Add Markdrop to Claude, ChatGPT, Cursor or VS Code with one server URL, then approve it here on Markdrop.
        </p>
        <Button variant="secondary" size="sm" href="/mcp" iconRight="arrowRight">See how</Button>
      </div>
    </Card>
  );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="Connected apps"
        description={
          <>
            AI apps you&apos;ve allowed to use your Markdrop account. Disconnect one and its access ends.{" "}
            <ReadMore topic="connectedApps" />
          </>
        }
      />

      <div className={`grid min-w-0 items-start gap-6 ${apps?.length === 0 ? "" : "lg:grid-cols-[minmax(0,1fr)_248px]"}`}>
        <section aria-label="Your connected apps" className="min-w-0">
          {failed ? (
            <Alert
              tone="danger"
              title="Couldn't load your connected apps"
              actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={() => void load()}>Try again</Button>}
            >
              Check your connection and try again.
            </Alert>
          ) : apps && apps.length === 0 ? (
            <EmptyState
              icon="sparkle"
              title="No connected apps"
              description="Connect Claude, ChatGPT or another AI app to publish and read your documents from a chat."
              actions={<Button variant="primary" href="/mcp" iconRight="arrowRight">Connect an AI app</Button>}
            />
          ) : (
            <ul className="ph-no-capture m-0 flex list-none flex-col divide-y divide-border rounded-xl border border-border bg-surface p-0">
              {(apps ?? []).map((a) => {
                const host = hostOf(a.uri);
                return (
                  <li key={a.client_id} className="flex min-w-0 items-start gap-3 px-4 py-4 sm:gap-4">
                    <ClientLogo name={a.name} logo={a.logo_uri} size={40} />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <div className="min-w-0">
                        <p className="m-0 text-body-strong text-text [overflow-wrap:anywhere]" dir="auto">{a.name}</p>
                        {host && <p className="m-0 truncate font-mono text-caption text-text-muted">{host}</p>}
                      </div>
                      <ScopeBadges scopes={a.scopes} />
                      <p className="m-0 text-caption text-text-muted">
                        Connected {shortDate(a.connected_at)} · {lastUsed(a.last_used_at)}
                      </p>
                    </div>
                    <RowMenu
                      portal
                      align="right"
                      label={`More actions for ${a.name}`}
                      items={[{ label: "Disconnect", icon: "logOut", danger: true, onClick: () => setRemoving(a) }]}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {apps?.length !== 0 && connectCard}
      </div>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={disconnect}
        title={removing ? `Disconnect ${removing.name}?` : "Disconnect app?"}
        body={
          <>
            It loses access to your Markdrop account straight away. What it published stays yours, with the same
            links. To use it again, connect it from the app and approve it here.
          </>
        }
        confirmLabel="Disconnect"
      />
    </div>
  );
}
