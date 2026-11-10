"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, useToast } from "@/components/ui";
import { IntegrationDetail } from "@/components/integrations/IntegrationsUI";
import { useIntegrationStatus } from "@/components/integrations/useIntegrationStatus";
import { AiAppSettings, CliSettings, GithubSettings, VsCodeSettings } from "@/components/integrations/AccountIntegrationSettings";
import { disconnectGoogleDocs } from "@/lib/api";
import { findIntegration, gridHref } from "@/lib/integrations";
import { SettingsLoader, useRequireUser } from "../../settings-shared";
import { SlackCard } from "../../account/SlackCard";
import { JiraCard } from "../../account/JiraCard";
import { accountConnect } from "../AccountIntegrationsClient";

/**
 * /settings/integrations/<integration>: one of the person's own integrations. Slack notifications and
 * Jira are the cards that used to sit on Settings › Account (unchanged); AI apps, VS Code, the CLI and
 * GitHub get a short settings block; Google Docs connects and disconnects from the header.
 */
export default function AccountIntegrationClient({ integration }: { integration: string }) {
  const info = findIntegration("account", integration);
  const { ready } = useRequireUser(`/settings/integrations/${integration}`);
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { statuses, apps, reload } = useIntegrationStatus("account", null, false, ready && !!info);
  useEffect(() => { if (!info) router.replace(gridHref("account")); }, [info, router]);

  if (!info || !ready) return <SettingsLoader label="Loading integration" />;
  const status = statuses[info.id];

  const settings = (() => {
    switch (info.id) {
      case "slack": return status && status.kind !== "unavailable" && status.label !== "Not connected" ? <SlackCard /> : null;
      case "jira": return status && status.kind !== "unavailable" ? <JiraCard /> : null;
      case "claude": case "chatgpt": case "cursor": case "ai-apps":
        return <AiAppSettings app={info.id} apps={apps} onChanged={() => void reload()} />;
      case "vscode": return <VsCodeSettings />;
      case "cli": return <CliSettings />;
      case "github": return <GithubSettings />;
      default: return null;
    }
  })();

  let actions: React.ReactNode = null;
  if (info.id === "google-docs" && status && status.kind !== "unavailable") {
    const connect = accountConnect("google-docs")!;
    actions = status.kind === "connected" ? (
      <Button variant="secondary" iconLeft="logOut" loading={busy} data-testid="gdocs-disconnect" onClick={async () => {
        setBusy(true);
        try { await disconnectGoogleDocs(); toast.success("Google Docs is disconnected."); await reload(); }
        catch { toast.error("Couldn't disconnect Google Docs. Try again."); }
        finally { setBusy(false); }
      }}>Disconnect</Button>
    ) : (
      <Button iconLeft="plus" loading={busy} data-testid="gdocs-connect" onClick={async () => {
        setBusy(true);
        try { await connect(); } catch (e) { toast.error(e instanceof Error ? e.message : "That didn't work. Try again."); setBusy(false); }
      }}>Connect Google Docs</Button>
    );
  }

  return (
    <IntegrationDetail
      info={info}
      status={status}
      backHref={gridHref("account")}
      backLabel="Integrations"
      actions={actions}
      onSettingsTouched={() => void reload()}
    >
      {settings}
    </IntegrationDetail>
  );
}
