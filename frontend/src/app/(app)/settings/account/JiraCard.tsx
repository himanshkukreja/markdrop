"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, ConfirmDialog, Skeleton, useToast } from "@/components/ui";
import { JiraMark } from "@/components/jira/JiraMark";
import { connectMyJira, jiraDisconnectMe, jiraMe, type JiraAccount } from "@/lib/jira";

/**
 * Settings › Account › Jira (routers/jira.py GET/DELETE /me): connect your own Atlassian account so
 * issues are created and moved as you, and tickets show on Team and in Ask through your own Jira access.
 * Lists the workspaces of yours that have a Jira site and whether your account reaches it. Hidden while
 * Jira isn't set up on the server and you aren't connected.
 */
export function JiraCard() {
  const toast = useToast();
  const [me, setMe] = useState<JiraAccount | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    try { setMe(await jiraMe()); } catch { setFailed(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (me && window.location.hash === "#jira") document.getElementById("jira")?.scrollIntoView({ block: "start" });
    if (me?.connected && new URLSearchParams(window.location.search).get("jira") === "connected") toast.success("Your Atlassian account is connected.");
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps

  if (failed || (me && !me.configured && !me.connected)) return null;

  return (
    <Card id="jira" title="Jira" description="Your own Atlassian account, so Markdrop creates and moves issues as you and shows only tickets you can open in Jira.">
      {!me ? (
        <div className="flex flex-col gap-3" aria-busy="true"><Skeleton width="60%" /><Skeleton width="40%" height={10} /></div>
      ) : (
        <div className="flex min-w-0 flex-col gap-4" data-testid="jira-account">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-bg"><JiraMark /></span>
            <p className="min-w-0 flex-[1_1_240px] text-[13px] text-text-secondary">
              {me.broken ? <>Your Atlassian connection stopped working. <Badge tone="warning" size="sm">Reconnect</Badge></>
                : me.connected ? <>Connected{me.name ? <> as <strong className="ph-sensitive ph-mask text-text">{me.name}</strong></> : null}
                    {me.sites?.length ? <> · {me.sites.map((s) => s.name).join(", ")}</> : null}</>
                : "Not connected. Connect it to create Jira issues from meetings and pages, and to see tickets on Team."}
            </p>
            {(!me.connected || me.broken) ? (
              <Button size="sm" iconLeft="link" loading={busy} data-testid="jira-account-connect" onClick={async () => {
                setBusy(true);
                try { await connectMyJira("/settings/account#jira"); } catch (e) { toast.error(e instanceof Error ? e.message : "That didn't work."); setBusy(false); }
              }}>{me.broken ? "Reconnect" : "Connect my Atlassian account"}</Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setConfirm(true)}>Disconnect</Button>
            )}
          </div>
          {me.workspaces.length > 0 && (
            <ul className="flex min-w-0 flex-col gap-1 text-[13px]">
              {me.workspaces.map((w) => (
                <li key={w.workspace_id} className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="text-text">{w.workspace_name}</span>
                  <span className="text-text-muted">→ {w.site}</span>
                  {me.connected && (w.reaches ? <Badge tone="success" size="sm">Reaches it</Badge> : <Badge tone="warning" size="sm">No access</Badge>)}
                </li>
              ))}
            </ul>
          )}
          {me.connected && me.workspaces.some((w) => !w.reaches) && (
            <Alert tone="info">Your Atlassian account doesn&apos;t reach one of your workspaces&apos; Jira sites. Ask that site&apos;s Jira admin for access.</Alert>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Disconnect your Atlassian account?"
        description="Markdrop forgets your Atlassian tokens. Issues stay in Jira. To remove Markdrop from Atlassian too, use Connected apps in your Atlassian account settings."
        confirmLabel="Disconnect"
        onConfirm={async () => {
          setMe(await jiraDisconnectMe());
          setConfirm(false);
          toast.success("Your Atlassian account is disconnected.");
        }}
      />
    </Card>
  );
}
