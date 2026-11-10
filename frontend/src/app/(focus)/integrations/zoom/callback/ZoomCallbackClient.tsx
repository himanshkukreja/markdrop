"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { Alert, Button, Card, Field, MarkdropLoader, Select, VisuallyHidden } from "@/components/ui";
import { listWorkspaces, type Workspace } from "@/lib/workspaces";
import { zoomConnectFinish } from "@/lib/zoom";

const settingsUrl = (ws: string) => `/settings/workspaces/${encodeURIComponent(ws)}?tab=integrations&zoom=connected`;

/**
 * Zoom's OAuth redirect for Markdrop's Zoom Marketplace app. Started in Markdrop (Integrations › Zoom ›
 * Connect Zoom): the signed `state` names the workspace, so it finishes on its own. Started in the Zoom App
 * Marketplace ("Add"): there is no state, so the person (signed in; sent to log in first) picks one of the
 * workspaces they administer and confirms. The server exchanges the code and stores the tokens encrypted.
 */
export default function ZoomCallbackClient() {
  const params = useSearchParams();
  const router = useRouter();
  const { user, loading } = useAuth();
  const code = params.get("code") || "";
  const state = params.get("state") || "";
  const denied = params.get("error");
  const [error, setError] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (loading || started.current) return;
    if (!user) {
      started.current = true;
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
      return;
    }
    if (denied || !code) return;
    started.current = true;
    if (state) {
      (async () => {
        try {
          const out = await zoomConnectFinish({ code, state });
          router.replace(settingsUrl(out.workspace_id));
        } catch (e) {
          setError(e instanceof Error ? e.message : "Zoom didn't finish connecting. Try again.");
        }
      })();
      return;
    }
    (async () => {
      try {
        const all = (await listWorkspaces()).filter((w) => w.role === "owner" || w.role === "admin");
        setWorkspaces(all);
        if (all.length) setPick(all[0].id);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't load your workspaces.");
      }
    })();
  }, [loading, user, denied, code, state, router]);

  const problem = denied
    ? (denied === "access_denied" ? "You cancelled on Zoom's page. Nothing changed." : "Zoom didn't finish connecting.")
    : !code ? "This page finishes connecting Zoom. Start from Workspace settings › Integrations › Zoom." : error;

  if (problem) {
    return (
      <Card className="w-full max-w-[440px] sm:p-3">
        <div className="flex flex-col items-center gap-4 text-center" data-testid="zoom-callback-problem">
          <h1 className="m-0 text-h3 text-text">Zoom isn&apos;t connected</h1>
          <Alert tone={denied === "access_denied" ? "info" : "danger"} className="w-full text-left">{problem}</Alert>
          <Button href="/settings/workspaces" variant="secondary">Back to workspaces</Button>
        </div>
      </Card>
    );
  }
  if (state || workspaces === null) {
    return (
      <>
        <VisuallyHidden as="h1">Connecting Zoom</VisuallyHidden>
        <MarkdropLoader label="Connecting Zoom…" size="sm" />
      </>
    );
  }
  return (
    <Card className="w-full max-w-[480px] sm:p-3">
      <div className="flex flex-col gap-4" data-testid="zoom-callback-pick">
        <h1 className="m-0 text-h3 text-text">Connect Zoom to Markdrop</h1>
        {workspaces.length === 0 ? (
          <Alert tone="info">
            Connecting Zoom needs a Markdrop workspace you own or administer. Create one (or ask a workspace admin to connect Zoom from
            Workspace settings › Integrations › Zoom), then add the app again.
          </Alert>
        ) : (
          <>
            <p className="m-0 text-[14px] leading-6 text-text-secondary">
              Recorded meetings from this Zoom account will come into the workspace you pick, for one team you choose next.
              Only meetings with a transcript are imported, and Markdrop never changes anything in Zoom.
            </p>
            <Field label="Workspace">
              <Select value={pick} onChange={(e) => setPick(e.target.value)} data-testid="zoom-callback-workspace"
                options={workspaces.map((w) => ({ value: w.id, label: w.name }))} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button loading={busy} data-testid="zoom-callback-connect" onClick={async () => {
                setBusy(true);
                try {
                  const out = await zoomConnectFinish({ code, workspace_id: pick });
                  router.replace(settingsUrl(out.workspace_id));
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Zoom didn't finish connecting. Add the app again.");
                  setBusy(false);
                }
              }}>Connect Zoom to this workspace</Button>
              <Button href="/settings/workspaces" variant="secondary">Cancel</Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
