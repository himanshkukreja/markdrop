"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { Alert, Button, Card, MarkdropLoader, VisuallyHidden } from "@/components/ui";
import { readSlackState, slackConnect, slackLinkFinish } from "@/lib/slack";
import { SlackMark } from "@/components/integrations/SlackMark";

/**
 * Slack's redirect URL for both round trips: Add to Slack (state kind "install" → POST /slack/connect)
 * and Sign in with Slack (kind "link" → POST /slack/link/finish). On success, back to the workspace's
 * Integrations tab. The server checks the state (signed, for this account, recent, used once).
 */
export default function SlackCallbackClient() {
  const params = useSearchParams();
  const router = useRouter();
  const { user, loading } = useAuth();
  const code = params.get("code") || "";
  const state = params.get("state") || "";
  const denied = params.get("error");
  const { kind, workspace } = readSlackState(state);
  const [error, setError] = useState("");
  const [linked, setLinked] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (loading || started.current) return;
    if (!user) {
      started.current = true;
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
      return;
    }
    if (denied || !code || !kind) return;
    started.current = true;
    (async () => {
      try {
        if (kind === "install") {
          await slackConnect(code, state);
          router.replace(`/settings/workspaces/${encodeURIComponent(workspace || "")}?tab=integrations&slack=connected`);
        } else {
          const out = await slackLinkFinish(code, state);
          if (out.workspace_id) router.replace(`/settings/workspaces/${encodeURIComponent(out.workspace_id)}?tab=integrations&slack=linked`);
          else setLinked(out.team_name || "Slack");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Slack didn't finish connecting. Try again.");
      }
    })();
  }, [loading, user, denied, code, kind, state, workspace, router]);

  const back = kind === "install" && workspace ? `/settings/workspaces/${encodeURIComponent(workspace)}?tab=integrations` : "/settings/workspaces";
  const problem = denied
    ? (denied === "access_denied" ? "You cancelled in Slack. Nothing changed." : "Slack didn't finish connecting.")
    : (!code || !kind) ? "This page finishes connecting Slack. Start from Workspace settings › Integrations." : error;

  if (linked) {
    return (
      <Card className="w-full max-w-[440px] sm:p-3">
        <div className="flex flex-col items-center gap-4 text-center">
          <SlackMark size={32} />
          <h1 className="m-0 text-h3 text-text">Your Slack account is linked</h1>
          <p className="m-0 text-body text-text-secondary">
            In <strong className="ph-sensitive ph-mask text-text">{linked}</strong>, <code>/markdrop</code> now answers you from what you can open. You can close this tab and go back to Slack.
          </p>
        </div>
      </Card>
    );
  }
  if (!problem) {
    return (
      <>
        <VisuallyHidden as="h1">Connecting Slack</VisuallyHidden>
        <MarkdropLoader label={kind === "link" ? "Linking your Slack account…" : "Connecting Slack…"} size="sm" />
      </>
    );
  }
  return (
    <Card className="w-full max-w-[440px] sm:p-3">
      <div className="flex flex-col items-center gap-4 text-center">
        <SlackMark size={32} />
        <h1 className="m-0 text-h3 text-text">Slack isn&apos;t connected</h1>
        <Alert tone={denied === "access_denied" ? "info" : "danger"} className="w-full text-left">{problem}</Alert>
        <Button href={back} variant="secondary">Back to settings</Button>
      </div>
    </Card>
  );
}
