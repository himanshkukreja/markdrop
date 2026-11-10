"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Skeleton } from "@/components/ui";
import { ConnectGoogleMeet, MeetConnectionStatus } from "@/components/meetings/ConnectGoogleMeet";
import { getMeetConnection, getMeetingsStatus, type MeetConnection } from "@/lib/meetings";

/**
 * Workspace settings › Integrations › Google Meet: your own connection to this workspace (the same
 * MeetConnectionStatus and ConnectGoogleMeet dialog as the Meetings page). `?connect=1` opens the dialog.
 */
export function MeetSettings({ workspaceId, workspaceName, onChanged }: { workspaceId: string; workspaceName: string | null; onChanged?: () => void }) {
  const [conn, setConn] = useState<{ mine: MeetConnection | null; others: MeetConnection[] } | null>(null);
  const [canImport, setCanImport] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([getMeetConnection(workspaceId), getMeetingsStatus(workspaceId)]);
      setConn({ mine: c.connection, others: c.others });
      setCanImport(!!s.can_import);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [workspaceId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (canImport && new URLSearchParams(window.location.search).get("connect") === "1") setConnecting(true);
  }, [canImport]);

  if (failed) return <Alert tone="danger" title="Couldn't load Google Meet" actions={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>Check your connection and try again.</Alert>;
  if (!conn) return <div className="flex flex-col gap-2" aria-busy="true"><Skeleton width="50%" height={18} /><Skeleton width="70%" height={14} /></div>;
  const here = conn.mine && conn.mine.workspace_id === workspaceId;

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-5" data-testid="meet-settings">
      <MeetConnectionStatus mine={conn.mine} others={conn.others} workspaceId={workspaceId}
        onChanged={() => { void load(); onChanged?.(); }} onReconnect={() => setConnecting(true)} />
      {!here && (
        canImport ? (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <p className="m-0 min-w-0 flex-[1_1_240px] text-[13px] text-text-secondary">
              {conn.mine ? <>Your Google Meet sends meetings to {conn.mine.workspace_name ?? "another workspace"}. Connecting here moves it.</> : "Not connected. It takes about two minutes."}
            </p>
            <Button iconLeft="plus" onClick={() => setConnecting(true)} data-testid="connect-meet">Connect Google Meet</Button>
          </div>
        ) : <p className="m-0 text-[13px] text-text-muted">Members who can add meetings to this workspace connect Google Meet here.</p>
      )}
      <ConnectGoogleMeet open={connecting} onClose={() => { setConnecting(false); void load(); onChanged?.(); }} workspaceId={workspaceId}
        workspaceName={workspaceName} current={conn.mine} onConnected={(c) => setConn((x) => (x ? { ...x, mine: c } : x))} />
    </div>
  );
}
