"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { Alert, Button, Card, MarkdropLoader, VisuallyHidden } from "@/components/ui";
import { jiraFinish, readJiraState } from "@/lib/jira";
import { JiraMark } from "@/components/jira/JiraMark";

/**
 * Atlassian's callback for both kinds of connection: a workspace admin connecting the Jira site (state
 * kind "site" → back to the workspace's Integrations tab to pick the site and projects) and a person
 * connecting their own account (kind "me" → back where they started, else Settings › Account). The
 * server checks the state (signed, for this account, recent, used once) and stores the tokens encrypted.
 */
export default function JiraCallbackClient() {
  const params = useSearchParams();
  const router = useRouter();
  const { user, loading } = useAuth();
  const code = params.get("code") || "";
  const state = params.get("state") || "";
  const denied = params.get("error");
  const { kind, workspace, back } = readJiraState(state);
  const [error, setError] = useState("");
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
        const out = await jiraFinish(code, state);
        if (out.kind === "site" && out.workspace_id) {
          router.replace(`/settings/workspaces/${encodeURIComponent(out.workspace_id)}?tab=integrations&jira=pick`);
        } else {
          const to = out.back || "/settings/account#jira";
          router.replace(to + (to.includes("?") ? "&" : "?") + "jira=connected");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Jira didn't finish connecting. Try again.");
      }
    })();
  }, [loading, user, denied, code, kind, state, router]);

  const backTo = kind === "site" && workspace ? `/settings/workspaces/${encodeURIComponent(workspace)}?tab=integrations` : (back || "/settings/account#jira");
  const problem = denied
    ? (denied === "access_denied" ? "You cancelled on Atlassian's page. Nothing changed." : "Atlassian didn't finish connecting.")
    : (!code || !kind) ? "This page finishes connecting Jira. Start from Settings." : error;

  if (!problem) {
    return (
      <>
        <VisuallyHidden as="h1">Connecting Jira</VisuallyHidden>
        <MarkdropLoader label={kind === "site" ? "Connecting your Jira site…" : "Connecting your Atlassian account…"} size="sm" />
      </>
    );
  }
  return (
    <Card className="w-full max-w-[440px] sm:p-3">
      <div className="flex flex-col items-center gap-4 text-center" data-testid="jira-callback-problem">
        <JiraMark size={32} />
        <h1 className="m-0 text-h3 text-text">Jira isn&apos;t connected</h1>
        <Alert tone={denied === "access_denied" ? "info" : "danger"} className="w-full text-left">{problem}</Alert>
        <Button href={backTo} variant="secondary">Back</Button>
      </div>
    </Card>
  );
}
