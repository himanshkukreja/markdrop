"use client";

/**
 * "Check for new meetings": the workspace's Google Meet scripts run now instead of at their next
 * scheduled run (backend meetings_inbox.check_now; the script's doPost). The server can't search the
 * person's Drive, so the script is deployed once as a web app and its URL pasted here (Turn on Check now).
 *
 *   useCheckNow(...)        state + run(): spinner, the result toast, the reason it can't run
 *   <CheckNowSetup>         the one-time steps and the Web app URL field (a bottom sheet on phones)
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Dialog, Drawer, Field, Input, useToast } from "@/components/ui";
import { PHONE_QUERY, useMediaQuery } from "@/components/kit/publish-utils";
import { checkMeetingsNow, setCheckNow, type MeetConnection } from "@/lib/meetings";
import "./meetings.css";

export interface CheckNowState {
  /** Someone's script sends meetings here (else there's nothing to check). */
  available: boolean;
  /** At least one of them has Check now on. */
  ready: boolean;
  /** Why it can't run (a teammate's script without Check now), for the disabled button's title. */
  reason: string | null;
  busy: boolean;
  /** Runs the check (or opens the setup when it's the caller's script that isn't set up). */
  run: () => void;
  /** The one-time setup is open. */
  setup: boolean;
  closeSetup: () => void;
}

export function useCheckNow({ workspaceId, mine, others, onChecked }: {
  workspaceId: string; mine: MeetConnection | null; others: MeetConnection[]; onChecked?: () => void;
}): CheckNowState {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  const here = mine && mine.workspace_id === workspaceId ? mine : null;
  const conns = [...(here ? [here] : []), ...others];
  const ready = conns.some((c) => c.check_now?.ready);
  const reason = !conns.length
    ? "Connect Google Meet first."
    : !ready && !here
      ? `Check now isn't on yet: ${others.map((o) => o.connected_by.name || "a member").join(", ")} can turn it on (Meetings › Turn on Check now).`
      : null;

  const check = useCallback(async () => {
    setBusy(true);
    try {
      const r = await checkMeetingsNow(workspaceId);
      const stillGoing = !r.ok && r.connections.every((c) => c.ok || c.error === "timeout");
      if (stillGoing) {
        // The script carries on: its meetings arrive as it sends them.
        toast.info(r.message);
        window.setTimeout(() => onChecked?.(), 30_000);
      } else if (!r.ok) toast.error(r.message);
      else if (r.imported || r.attached || r.updated) toast.success(r.message);
      else toast.info(r.message);
      onChecked?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't check right now. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  }, [workspaceId, toast, onChecked]);

  const run = useCallback(() => {
    if (busy) return;
    if (!ready && here) { setSetup(true); return; }
    if (!ready) return;
    void check();
  }, [busy, ready, here, check]);

  return { available: conns.length > 0, ready, reason, busy, run, setup, closeSetup: () => setSetup(false) };
}

/** Turn on Check now: deploy the script as a web app once and paste its URL. */
export function CheckNowSetup({ open, onClose, conn, onSaved }: {
  open: boolean; onClose: () => void; conn: MeetConnection | null; onSaved?: (c: MeetConnection) => void;
}) {
  const phone = useMediaQuery(PHONE_QUERY);
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!open) { setUrl(""); setError(null); setBusy(false); } }, [open]);

  const old = conn?.needs_update;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await setCheckNow(url.trim());
      toast.success("Check now is on. Press Check for new meetings to try it.");
      onSaved?.(r.connection);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save it. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <div className="mt-connect" data-testid="checknow-setup">
      <p className="mt-connect__lead">
        Your script checks for new meetings every 5 minutes by itself. Turn on <b>Check now</b> once so the
        <b> Check for new meetings</b> button can run it right away, for instance right after a call.
      </p>
      {old && (
        <Alert tone="warning" title="Update your script first">
          Check now needs the newest script: Meetings › Get the new script, paste it into your Apps Script project and Run <code>setup</code>.
        </Alert>
      )}
      <ol className="mt-connect__steps">
        <li>
          <b>Open your script</b> at <a href="https://script.google.com/home" target="_blank" rel="noreferrer">script.google.com</a> (the
          project you pasted the Markdrop script into).
        </li>
        <li>
          <b>Deploy it as a web app.</b> Click <b>Deploy › New deployment</b>, then the gear next to “Select type” › <b>Web app</b>.
          Set <b>Execute as: Me</b> and <b>Who has access: Anyone</b>, and press <b>Deploy</b> (allow it if Google asks).
        </li>
        <li>
          <b>Copy the Web app URL</b> Google shows (it ends with <code>/exec</code>) and paste it here.
        </li>
      </ol>
      <Field label="Web app URL" htmlFor="checknow-url" error={error ?? undefined}
        hint="Only Markdrop calls it, with a key only your script has: anyone else who opens it gets nothing.">
        <Input id="checknow-url" value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" autoComplete="off"
          placeholder="https://script.google.com/macros/s/…/exec" data-testid="checknow-url" />
      </Field>
      <p className="mt-connect__fine">
        Later, when you paste a newer script, also update the deployment: <b>Deploy › Manage deployments</b> › Edit (pencil) ›
        Version: <b>New version</b> › Deploy. The URL stays the same.
      </p>
    </div>
  );
  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button onClick={() => void save()} loading={busy} disabled={!url.trim()} data-testid="checknow-save">Turn on Check now</Button>
    </>
  );
  const title = "Turn on Check now";
  const description = "One time, in Google Apps Script: about a minute.";
  if (phone) {
    return <Drawer open={open} onClose={onClose} side="bottom" title={title} description={description} footer={footer} dismissible={!busy}>{body}</Drawer>;
  }
  return <Dialog open={open} onClose={onClose} size="lg" title={title} description={description} footer={footer} dismissible={!busy}>{body}</Dialog>;
}
