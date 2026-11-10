"use client";

import { PageHeader } from "@/components/shell/PageHeader";
import { IntegrationGrid, type CardAction } from "@/components/integrations/IntegrationsUI";
import { useIntegrationStatus, type IntegrationStatus } from "@/components/integrations/useIntegrationStatus";
import { connectMyJira } from "@/lib/jira";
import { connectGoogleDocs } from "@/lib/api";
import { ACCOUNT_INTEGRATIONS, integrationHref, type IntegrationInfo } from "@/lib/integrations";
import { SettingsLoader, useRequireUser } from "../settings-shared";

/** One-click connects from a card (the rest open their page). Shared with the detail page's header. */
export function accountConnect(id: string): (() => Promise<void>) | null {
  const back = integrationHref("account", id);
  if (id === "jira") return () => connectMyJira(back);
  if (id === "google-docs") return () => connectGoogleDocs(back);
  return null;
}

/**
 * /settings/integrations: the person's own integrations as a grid of cards (AI apps, Slack notifications,
 * Jira, Google Docs, GitHub, VS Code, the CLI), each opening its own page. Workspace integrations
 * (Zoom, Google Meet, Slack, Jira sites) are in each workspace's settings.
 */
export default function AccountIntegrationsClient() {
  const { ready } = useRequireUser("/settings/integrations");
  const { statuses } = useIntegrationStatus("account", null, false, ready);
  if (!ready) return <SettingsLoader label="Loading integrations" />;

  const actionOf = (i: IntegrationInfo, s: IntegrationStatus | undefined): CardAction | null => {
    const href = integrationHref("account", i.id);
    if (!s || s.kind === "unavailable") return null;
    if (s.kind === "connected") return { label: "Manage", href };
    if (s.kind === "attention") return { label: "Fix", href: `${href}#settings` };
    const one = accountConnect(i.id);
    if (one && s.kind === "off") return { label: "Connect", icon: "plus", onClick: one };
    if (i.id === "slack" && s.label === "Off") return { label: "Turn on", href: `${href}#settings` };
    return { label: "Set up", href: `${href}#setup` };
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader title="Integrations" description="Connect Markdrop to the apps you use. Each opens its own page with the steps and settings." />
      <IntegrationGrid items={ACCOUNT_INTEGRATIONS} statuses={statuses} hrefOf={(i) => integrationHref("account", i.id)} actionOf={actionOf} />
      <p className="m-0 text-[13px] text-text-secondary">
        Zoom, Google Meet, and Slack or Jira for a whole team are set up in each workspace&apos;s settings, under Integrations.
      </p>
    </div>
  );
}
