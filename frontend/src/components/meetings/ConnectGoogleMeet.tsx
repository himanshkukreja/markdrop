"use client";

/**
 * "Connect Google Meet": automatic import with a small Google Apps Script that runs in the person's
 * own Google account (backend services/meetings_inbox.py; .work/meetings/AUTO.md). Markdrop mints a
 * token that can only import meetings into this workspace and shows it once, inside a ready-made
 * script, with the four setup steps. The script sends the Meet transcripts and Gemini notes in their
 * Drive every 15 minutes; Disconnect revokes the token and the script stops.
 *
 *   <ConnectGoogleMeet>       the dialog (a bottom sheet on phones)
 *   <MeetConnectionStatus>    "Google Meet connected · last import 5 min ago · 3 meetings · Disconnect"
 *   <FolderMeetConnect>       the same, for the Meetings folder's banner
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert, Badge, Button, ConfirmDialog, CopyButton, Dialog, Drawer, Icon, Switch, useToast,
} from "@/components/ui";
import { PHONE_QUERY, useMediaQuery } from "@/components/kit/publish-utils";
import { relativeTime } from "@/components/dashboard/format";
import { connectGoogleMeet, disconnectGoogleMeet, getMeetConnection, type MeetConnection } from "@/lib/meetings";
import "./meetings.css";

export interface ConnectGoogleMeetProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  workspaceName: string | null;
  /** The caller's connection, wherever it sends meetings (connecting again replaces it). */
  current: MeetConnection | null;
  onConnected?: (c: MeetConnection) => void;
}

export function ConnectGoogleMeet({ open, onClose, workspaceId, workspaceName, current, onConnected }: ConnectGoogleMeetProps) {
  const phone = useMediaQuery(PHONE_QUERY);
  const [restricted, setRestricted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ script: string; manifest: string } | null>(null);
  const primary = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) return;
    setRestricted(false); setBusy(false); setError(null); setMade(null);
  }, [open]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await connectGoogleMeet({ workspace: workspaceId, restricted });
      setMade({ script: r.script, manifest: r.manifest });
      onConnected?.(r.connection);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't connect. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const wsName = workspaceName || "this workspace";
  const elsewhere = current && current.workspace_id !== workspaceId;

  const body = made ? (
    <div className="mt-connect" data-testid="meet-script">
      <Alert tone="success" title="Your script is ready">
        It holds a token that only imports meetings into {wsName}. It's shown this once: copy it now (Connect again later for a new one).
      </Alert>
      <ol className="mt-connect__steps">
        <li>
          <b>Open Apps Script.</b> Go to <a href="https://script.google.com/home/projects/create" target="_blank" rel="noreferrer">script.google.com</a> and
          create a <b>New project</b>, signed in as the Google account that records your meetings.
        </li>
        <li>
          <b>Paste the manifest.</b> In <b>Project Settings</b> (the gear), tick <b>Show “appsscript.json” manifest file in editor</b>.
          Back in the Editor, open <code>appsscript.json</code> and replace everything in it with:
          <CodeBox label="appsscript.json" text={made.manifest} testid="meet-manifest" />
        </li>
        <li>
          <b>Paste the script.</b> Open <code>Code.gs</code>, replace everything in it with this, and press Save:
          <CodeBox label="Code.gs" text={made.script} testid="meet-code" tall />
        </li>
        <li>
          <b>Run setup once and allow.</b> Pick <code>setup</code> next to Run and press Run. Google asks you to allow it;
          as it's your own script it says “Google hasn't verified this app”: choose <b>Advanced › Go to … (unsafe)</b>, then Allow.
          It imports your last 48 hours of meetings now and checks every 15 minutes from then on.
        </li>
      </ol>
      <p className="mt-connect__fine">
        It reads only Docs in your Drive titled like a Meet transcript or Gemini's notes, never changes or deletes anything,
        and stops when you Disconnect here.
      </p>
    </div>
  ) : (
    <div className="mt-connect">
      <p className="mt-connect__lead">
        Every call recorded or noted by Google Meet becomes a page in <b>{wsName}</b>'s Meetings folder by itself: a small script
        in your Google account sends the transcript and Gemini's notes to Markdrop every 15 minutes.
      </p>
      <ul className="mt-connect__facts">
        <li><Icon name="eye" /> It reads only Google Docs in your Drive titled like a Meet transcript (“… - Transcript”) or Gemini's notes (“Notes by Gemini”).</li>
        <li><Icon name="lock" /> Read-only: it never edits, moves or deletes anything in your Drive.</li>
        <li><Icon name="key" /> It gets its own token that can only import meetings into this workspace. Disconnect any time.</li>
        <li><Icon name="checkCircle" /> No duplicates: a meeting you already imported by hand is recognized, and notes and transcript of one call become one page.</li>
      </ul>
      <Switch checked={restricted} onChange={(e) => setRestricted(e.target.checked)}
        label="Only the people in each meeting can open its page" data-testid="meet-restricted" />
      {elsewhere && (
        <Alert tone="warning">
          Your script now sends meetings to {current?.workspace_name || "another workspace"}. Connecting here replaces it: that script stops working.
        </Alert>
      )}
      {current && !elsewhere && (
        <Alert tone="info">You're already connected here. A new script replaces the old one (the old token stops working).</Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );

  const footer = made ? (
    <Button onClick={onClose} data-testid="meet-done">Done</Button>
  ) : (
    <>
      <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button ref={primary} iconLeft="code" onClick={() => void create()} loading={busy} data-testid="meet-create">
        {current ? "Make a new script" : "Make my script"}
      </Button>
    </>
  );

  const title = "Connect Google Meet";
  const description = made ? "Four steps in Google Apps Script, about two minutes." : "Import meetings automatically.";
  if (phone) {
    return <Drawer open={open} onClose={onClose} side="bottom" title={title} description={description} footer={footer} dismissible={!busy}>{body}</Drawer>;
  }
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={title} description={description} footer={footer} dismissible={!busy}
      initialFocus={made ? undefined : primary}
      glyph={<span className="mt-hub__glyph" style={{ width: 36, height: 36 }}><Icon name="mic" /></span>}>
      {body}
    </Dialog>
  );
}

function CodeBox({ label, text, testid, tall }: { label: string; text: string; testid: string; tall?: boolean }) {
  return (
    <div className="mt-code" data-testid={testid}>
      <div className="mt-code__bar">
        <span>{label}</span>
        <CopyButton text={text} label={`Copy ${label}`} copiedLabel="Copied" variant="secondary" />
      </div>
      <pre className={tall ? "mt-code__pre mt-code__pre--tall" : "mt-code__pre"} tabIndex={0}><code>{text}</code></pre>
    </div>
  );
}

/** The connection line: mine (here) with Disconnect, and who else sends meetings here. */
export function MeetConnectionStatus({ mine, others, workspaceId, onChanged, onReconnect, compact }: {
  mine: MeetConnection | null;
  others: MeetConnection[];
  workspaceId: string;
  onChanged?: () => void;
  onReconnect?: () => void;
  compact?: boolean;
}) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const here = mine && mine.workspace_id === workspaceId ? mine : null;
  if (!here && others.length === 0) return null;
  const n = here ? here.imported : 0;   // "attached" filled in a meeting already counted
  return (
    <div className={compact ? "mt-conn mt-conn--compact" : "mt-conn"} data-testid="meet-connection">
      {here && (
        <span className="mt-conn__mine">
          <Badge size="sm" tone="success" icon="checkCircle">Google Meet connected</Badge>
          <span className="mt-conn__meta">
            {here.last_imported_at ? `last import ${relativeTime(here.last_imported_at)}` : here.last_received_at ? `last checked ${relativeTime(here.last_received_at)}` : "waiting for the script's first run"}
            {here.last_received_at || n ? ` · ${n} ${n === 1 ? "meeting" : "meetings"}` : ""}
            {here.restricted ? " · attendees only" : ""}
          </span>
          {here.last_error && <span className="mt-conn__err" title={here.last_error}><Icon name="alert" /> {here.last_error}</span>}
          {onReconnect && !compact && <Button size="sm" variant="ghost" onClick={onReconnect}>New script</Button>}
          <Button size="sm" variant="ghost" onClick={() => setConfirm(true)} data-testid="meet-disconnect">Disconnect</Button>
        </span>
      )}
      {others.length > 0 && (
        <span className="mt-conn__others">
          <Icon name="users" /> Also importing here: {others.map((o) => o.connected_by.name || "a member").join(", ")}
        </span>
      )}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} tone="danger" title="Disconnect Google Meet?"
        description="Your script's token stops working, so it stops sending meetings (it removes its own schedule on its next run). Meetings already imported stay."
        confirmLabel="Disconnect"
        onConfirm={async () => {
          await disconnectGoogleMeet();
          toast.success("Google Meet disconnected.");
          setConfirm(false);
          onChanged?.();
        }} />
    </div>
  );
}

/** The Meetings folder's banner: "Connect Google Meet" beside "Import meeting", or the connection line. */
export function FolderMeetConnect({ workspaceId, hubHref }: { workspaceId: string; hubHref: string }) {
  const [conn, setConn] = useState<{ mine: MeetConnection | null; others: MeetConnection[] } | null>(null);
  const load = useCallback(() => getMeetConnection(workspaceId)
    .then((c) => setConn({ mine: c.connection, others: c.others })).catch(() => setConn({ mine: null, others: [] })), [workspaceId]);
  useEffect(() => { void load(); }, [load]);
  if (!conn) return null;
  if (conn.mine && conn.mine.workspace_id === workspaceId) {
    return <MeetConnectionStatus compact mine={conn.mine} others={conn.others} workspaceId={workspaceId} onChanged={() => void load()} />;
  }
  return (
    <>
      <Button size="sm" variant="secondary" iconLeft="refresh" href={`${hubHref}?connect=1`} data-testid="folder-connect-meet">Connect Google Meet</Button>
      {conn.others.length > 0 && <MeetConnectionStatus compact mine={null} others={conn.others} workspaceId={workspaceId} />}
    </>
  );
}
