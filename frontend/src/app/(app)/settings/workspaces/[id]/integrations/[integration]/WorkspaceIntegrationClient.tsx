"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Breadcrumb, Button, EmptyState } from "@/components/ui";
import { IntegrationDetail } from "@/components/integrations/IntegrationsUI";
import { useIntegrationStatus } from "@/components/integrations/useIntegrationStatus";
import { MeetSettings } from "@/components/integrations/MeetSettings";
import { JiraWorkspaceCard } from "@/components/jira/JiraWorkspaceCard";
import { ZoomWorkspaceCard } from "@/components/zoom/ZoomWorkspaceCard";
import { can, getWorkspace, type Workspace } from "@/lib/workspaces";
import { findIntegration, gridHref } from "@/lib/integrations";
import { SettingsLoader, useRequireUser } from "../../../../settings-shared";
import { SlackSection } from "../../tabs/SlackSettings";

/**
 * /settings/workspaces/<id>/integrations/<integration>: one workspace integration's page. The settings
 * are the components that sat on the old Integrations tab, unchanged (ZoomWorkspaceCard and
 * JiraWorkspaceCard as they are; Slack's section moved to tabs/SlackSettings.tsx). An unknown id goes
 * back to the grid.
 */
export default function WorkspaceIntegrationClient({ id, integration }: { id: string; integration: string }) {
  const info = findIntegration("workspace", integration);
  const { ready } = useRequireUser(`/settings/workspaces/${id}/integrations/${integration}`);
  const router = useRouter();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setWs(await getWorkspace(id)); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "Couldn't load this workspace."); }
  }, [id]);
  useEffect(() => { if (ready && info) void load(); }, [ready, info, load]);
  useEffect(() => { if (!info) router.replace(gridHref("workspace", id)); }, [info, id, router]);

  const isAdmin = can(ws?.role, "admin");
  const { statuses, reload } = useIntegrationStatus("workspace", id, isAdmin, !!ws);

  if (!info || !ready || (!ws && !error)) return <SettingsLoader label="Loading integration" />;
  if (!ws) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <Breadcrumb items={[{ label: "My files", href: "/dashboard" }, { label: "Workspace settings" }]} />
        <h1 className="md-visually-hidden">Integration</h1>
        <EmptyState icon="alertCircle" title="We couldn't open this workspace" description={`${error} It may have been deleted, or you may no longer be a member.`}
          actions={<Button variant="secondary" href="/dashboard" iconLeft="arrowLeft">Back to My files</Button>} />
      </div>
    );
  }

  const settings = (() => {
    switch (info.id) {
      case "slack": return <SlackSection id={id} isAdmin={isAdmin} />;
      case "jira": return <JiraWorkspaceCard id={id} isAdmin={isAdmin} />;
      case "zoom": return <ZoomWorkspaceCard id={id} isAdmin={isAdmin} />;
      case "google-meet": return <MeetSettings workspaceId={id} workspaceName={ws.name} onChanged={() => void reload()} />;
      default: return null;
    }
  })();

  return (
    <IntegrationDetail
      info={info}
      status={statuses[info.id]}
      backHref={gridHref("workspace", id)}
      backLabel={<><span className="ph-sensitive ph-mask">{ws.name}</span> › Integrations</>}
      onSettingsTouched={() => void reload()}
    >
      <div className="flex min-w-0 flex-col gap-3">
        {!isAdmin && info.id !== "google-meet" && (
          <Alert tone="info">You can see these settings. Changing them needs the Admin role.</Alert>
        )}
        {settings}
      </div>
    </IntegrationDetail>
  );
}
