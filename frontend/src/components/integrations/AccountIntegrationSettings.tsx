"use client";

import { useState } from "react";
import { Button, ConfirmDialog, CopyButton, useToast } from "@/components/ui";
import { ClientLogo } from "@/components/oauth/ClientLogo";
import { MCP_SERVER_URL } from "@/lib/mcp";
import { disconnectApp, type OAuthConnection } from "@/lib/oauthClient";
import { aiAppOf } from "@/lib/integrations";
import { studioUrl } from "@/lib/studioHost";

/**
 * The Settings part of account integrations that had no settings card of their own: AI apps (the
 * server URL and the approved apps of that kind, with Disconnect, as on Connected apps), VS Code and the
 * CLI (install line and API tokens), GitHub (opens Guides).
 */

function CopyLine({ label, text, testId }: { label: string; text: string; testId?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[13px] font-medium text-text">{label}</span>
      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2">
        <code className="min-w-0 flex-1 text-[12px] text-text [overflow-wrap:anywhere]" data-testid={testId}>{text}</code>
        <CopyButton text={text} label="Copy" iconOnly size="sm" announceText={`${label} copied`} />
      </div>
    </div>
  );
}

const box = "flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface p-5";

export function AiAppSettings({ app, apps, onChanged }: { app: string; apps: OAuthConnection[] | null; onChanged: () => void }) {
  const toast = useToast();
  const [removing, setRemoving] = useState<OAuthConnection | null>(null);
  const mine = (apps ?? []).filter((a) => aiAppOf(a.name) === app);
  return (
    <div className={box} data-testid="ai-app-settings">
      <CopyLine label="Server URL" text={MCP_SERVER_URL} testId="mcp-server-url" />
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-[13px] font-medium text-text">Approved on this account</span>
        {apps === null ? (
          <p className="m-0 text-[13px] text-text-muted">Couldn&apos;t load your connected apps.</p>
        ) : mine.length === 0 ? (
          <p className="m-0 text-[13px] text-text-muted">None yet. Add the server URL in the app, then approve it when Markdrop asks.</p>
        ) : (
          <ul className="ph-no-capture m-0 flex list-none flex-col divide-y divide-border p-0">
            {mine.map((a) => (
              <li key={a.client_id} className="flex min-w-0 items-center gap-3 py-2">
                <ClientLogo name={a.name} logo={a.logo_uri} size={28} />
                <span className="min-w-0 flex-1 text-[13px] text-text [overflow-wrap:anywhere]" dir="auto">{a.name}</span>
                <Button size="sm" variant="ghost" onClick={() => setRemoving(a)}>Disconnect</Button>
              </li>
            ))}
          </ul>
        )}
        <Button size="sm" variant="link" href="/settings/connections" className="self-start">All connected apps</Button>
      </div>
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={removing ? `Disconnect ${removing.name}?` : "Disconnect app?"}
        body="It loses access to your Markdrop account straight away. What it published stays yours, with the same links."
        confirmLabel="Disconnect"
        onConfirm={async () => {
          if (!removing) return;
          try { await disconnectApp(removing.client_id); } catch { throw new Error(`Couldn't disconnect ${removing.name}. Try again.`); }
          toast.success(`Disconnected ${removing.name}.`);
          setRemoving(null);
          onChanged();
        }}
      />
    </div>
  );
}

export function VsCodeSettings() {
  return (
    <div className={box} data-testid="vscode-settings">
      <CopyLine label="Install from a terminal" text="code --install-extension HimanshuKukreja.markdrop" />
      <p className="m-0 text-[13px] text-text-secondary">
        Signing in creates an API token named “VS Code”. Revoke it to sign VS Code out.
      </p>
      <Button size="sm" variant="secondary" iconLeft="key" href="/settings/tokens" className="self-start">API tokens</Button>
    </div>
  );
}

export function CliSettings() {
  return (
    <div className={box} data-testid="cli-settings">
      <CopyLine label="macOS (Homebrew)" text="brew install himanshkukreja/tap/markdrop" />
      <CopyLine label="Sign in" text="markdrop login" />
      <Button size="sm" variant="secondary" iconLeft="key" href="/settings/tokens" className="self-start">API tokens</Button>
    </div>
  );
}

export function GithubSettings() {
  return (
    <div className={box} data-testid="github-settings">
      <p className="m-0 text-[13px] text-text-secondary">GitHub connects per guide, from that guide&apos;s import and sync settings in Markdrop Guides.</p>
      <Button size="sm" variant="secondary" iconRight="arrowRight" href={studioUrl("/")} className="self-start">Open Guides</Button>
    </div>
  );
}
