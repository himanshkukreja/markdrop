"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { IntegrationGrid, type CardAction } from "@/components/integrations/IntegrationsUI";
import { useIntegrationStatus, type IntegrationStatus } from "@/components/integrations/useIntegrationStatus";
import { slackInstallUrl } from "@/lib/slack";
import { jiraStart } from "@/lib/jira";
import { WORKSPACE_INTEGRATIONS, integrationHref, type IntegrationInfo } from "@/lib/integrations";
import type { WsTabProps } from "../ws-shared";

/**
 * Workspace settings › Integrations: a grid of cards (Zoom, Google Meet, Slack, Jira), each with its status,
 * one action and Details, which opens the integration's own page (/settings/workspaces/<id>/integrations/<id>)
 * with its settings, setup steps and troubleshooting. Back from Slack or Atlassian with the old
 * `?tab=integrations&slack=…|jira=…` query (links made before the grid): that integration's page.
 */
export default function IntegrationsTab({ id, isAdmin }: WsTabProps) {
  const router = useRouter();
  const { statuses } = useIntegrationStatus("workspace", id, isAdmin);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const to = q.has("slack") ? "slack" : q.has("jira") ? "jira" : q.has("zoom") ? "zoom" : null;
    if (!to) return;
    q.delete("tab");
    const rest = q.toString();
    router.replace(integrationHref("workspace", to, id) + (rest ? `?${rest}` : ""));
  }, [id, router]);

  const actionOf = (i: IntegrationInfo, s: IntegrationStatus | undefined): CardAction | null => {
    const href = integrationHref("workspace", i.id, id);
    if (!s || s.kind === "unavailable" || s.kind === "admin" || (s.kind === "info" && s.label)) return null;
    if (s.kind === "connected") return { label: "Manage", href };
    if (s.kind === "attention") return { label: "Fix", href: `${href}#settings` };
    if (i.id === "slack") return { label: "Connect", icon: "plus", onClick: async () => { window.location.href = (await slackInstallUrl(id)).url; } };
    if (i.id === "jira") return { label: "Connect", icon: "plus", onClick: async () => { window.location.href = (await jiraStart({ kind: "site", workspace_id: id })).url; } };
    if (i.id === "google-meet") return { label: "Connect", icon: "plus", href: `${href}?connect=1` };
    return { label: "Set up", href: `${href}#settings` };
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <IntegrationGrid
        items={WORKSPACE_INTEGRATIONS}
        statuses={statuses}
        hrefOf={(i) => integrationHref("workspace", i.id, id)}
        actionOf={actionOf}
      />
      <p className="m-0 text-[13px] text-text-secondary">
        Your own connections, like Claude, ChatGPT, VS Code, the CLI, Google Docs and Slack notifications, are in{" "}
        <Link href="/settings/integrations" className="font-medium text-accent-text hover:underline">Settings › Integrations</Link>.
      </p>
    </div>
  );
}
