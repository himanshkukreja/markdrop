"use client";

/**
 * /meetings/<workspace>: the team's meetings. Import one (paste, upload, Google Docs) or connect Google
 * Meet to import them automatically (side by side), ask across all of them, and open any meeting page. Only meetings the caller can open are listed (the server
 * decides); a workspace admin also sees that restricted meetings exist (no title) so they can delete
 * them. Phones get one column, a full-width Import button and the import as a bottom sheet.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Alert, Badge, Button, ConfirmDialog, Icon, Input, Skeleton, Spinner, useToast,
} from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { getWorkspace, type Workspace } from "@/lib/workspaces";
import {
  deleteMeeting, fmtDuration, getMeetConnection, getMeetingsStatus, listMeetings,
  type HiddenMeeting, type MeetConnection, type Meeting, type MeetingsStatus,
} from "@/lib/meetings";
import { ImportMeeting } from "./ImportMeeting";
import { ConnectGoogleMeet, MeetConnectionStatus } from "./ConnectGoogleMeet";
import { MeetingChat } from "./MeetingChat";
import "./meetings.css";

const ASK_SUGGESTIONS = [
  { q: "What did we decide this week?", icon: "checkCircle" },
  { q: "What are my open action items?", icon: "checkSquare" },
  { q: "What's blocking the release?", icon: "flag" },
];

export default function MeetingsHub({ workspaceId }: { workspaceId: string }) {
  const { user, loading: authLoading } = useAuth();
  const toast = useToast();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [status, setStatus] = useState<MeetingsStatus | null>(null);
  const [items, setItems] = useState<Meeting[] | null>(null);
  const [hidden, setHidden] = useState<HiddenMeeting[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [filter, setFilter] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [conn, setConn] = useState<{ mine: MeetConnection | null; others: MeetConnection[] }>({ mine: null, others: [] });

  const loadConn = useCallback(() => getMeetConnection(workspaceId)
    .then((c) => setConn({ mine: c.connection, others: c.others })).catch(() => {}), [workspaceId]);

  const load = useCallback(async () => {
    try {
      const [w, s, l] = await Promise.all([getWorkspace(workspaceId), getMeetingsStatus(workspaceId), listMeetings(workspaceId)]);
      setWs(w); setStatus(s); setItems(l.meetings); setHidden(l.hidden); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the meetings.");
      setItems([]);
    }
  }, [workspaceId]);

  useEffect(() => { if (user) { void load(); void loadConn(); } }, [user, load, loadConn]);
  // A summary is being written: refresh the list now and then.
  const pending = items?.some((m) => m.ai.state === "pending");
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(() => void listMeetings(workspaceId).then((l) => { setItems(l.meetings); setHidden(l.hidden); }).catch(() => {}), 4000);
    return () => window.clearInterval(t);
  }, [pending, workspaceId]);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("import") === "1") setImporting(true);
    else if (q.get("connect") === "1") setConnecting(true);
  }, []);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (items ?? []).filter((m) => !f || (m.title || "").toLowerCase().includes(f) || m.attendees.some((a) => a.name.toLowerCase().includes(f)));
  }, [items, filter]);

  if (authLoading) return <div className="mt-hub"><Skeleton height={32} width={240} /></div>;
  if (!user) return <div className="mt-hub"><Alert tone="info">Sign in to see your team's meetings.</Alert></div>;

  const canImport = !!status?.can_import;
  const folderHref = status?.folder_id ? `/w/${encodeURIComponent(workspaceId)}/f/${encodeURIComponent(status.folder_id)}` : null;
  const any = (items?.length ?? 0) > 0;
  const connectedHere = !!conn.mine && conn.mine.workspace_id === workspaceId;
  const connectButton = canImport && !connectedHere && (
    <Button variant="secondary" iconLeft="refresh" onClick={() => setConnecting(true)} data-testid="connect-meet">Connect Google Meet</Button>
  );

  return (
    <div className="mt-hub">
      <nav className="mt-hub__crumbs" aria-label="Breadcrumb">
        <Link href={`/w/${encodeURIComponent(workspaceId)}`}>{ws?.name ?? "Workspace"}</Link>
        <Icon name="chevronRight" />
        <span aria-current="page">Meetings</span>
      </nav>
      <header className="mt-hub__head">
        <div className="mt-hub__titles">
          <span className="mt-hub__glyph" aria-hidden><Icon name="mic" /></span>
          <div>
            <h1 className="mt-hub__title">Meetings</h1>
            <p className="mt-hub__sub">Every call as a page: summary, decisions, action items and the transcript. Ask any of them.</p>
          </div>
        </div>
        <div className="mt-hub__actions">
          {folderHref && <Button variant="secondary" iconLeft="folder" href={folderHref}>Open folder</Button>}
          {connectButton}
          {canImport && <Button iconLeft="plus" onClick={() => setImporting(true)} data-testid="import-meeting">Import meeting</Button>}
        </div>
      </header>
      <MeetConnectionStatus mine={conn.mine} others={conn.others} workspaceId={workspaceId}
        onChanged={() => void loadConn()} onReconnect={() => setConnecting(true)} />

      {error && <Alert tone="danger" className="mb-4">{error}</Alert>}

      {any && (
        <section className="mt-ask" aria-labelledby="mt-ask-label">
          <p className="mt-ask__label" id="mt-ask-label">
            <Icon name="sparkle" /> Ask across meetings
            <span className="mt-ask__hint">{status?.ai.enabled === false ? status.ai.message : "Claude Haiku · answers cite the moment"}</span>
          </p>
          <MeetingChat
            mode="all"
            layout="inline"
            workspaceId={workspaceId}
            suggestions={ASK_SUGGESTIONS}
            emptyTitle="Ask across meetings"
            emptySub=""
            placeholder="Ask about any meeting…"
          />
        </section>
      )}

      {items === null ? (
        <div className="mt-list">
          {[0, 1, 2].map((i) => <Skeleton key={i} variant="rect" height={72} />)}
        </div>
      ) : !any && hidden.length === 0 ? (
        <div className="mt-empty-hub">
          <span className="mt-empty-hub__glyph" aria-hidden><Icon name="mic" /></span>
          <h3>Turn your calls into team memory</h3>
          <p>Import a Google Meet transcript or Gemini's meeting notes. Markdrop writes the summary, decisions and action items (and @mentions the people who own them), keeps the transcript, and answers questions about it.</p>
          {canImport ? (
            <div className="mt-hub__actions" style={{ justifyContent: "center" }}>
              <Button iconLeft="plus" onClick={() => setImporting(true)}>Import your first meeting</Button>
              {connectButton}
            </div>
          ) : <p style={{ margin: 0 }}>Members of this workspace can import meetings.</p>}
          <div className="mt-steps">
            <div className="mt-step"><b>1 · Import</b>Paste it, upload .txt/.vtt/.srt/.docx, pick the Docs Google saved in your Drive, or connect Google Meet to import every call by itself.</div>
            <div className="mt-step"><b>2 · Review</b>A page in Meetings: summary, decisions, action items with owners, open questions.</div>
            <div className="mt-step"><b>3 · Ask</b>“What did we decide about pricing?” — answers link to the moment it was said.</div>
          </div>
        </div>
      ) : (
        <section aria-labelledby="mt-list-title">
          <div className="mt-section-title">
            <h2 id="mt-list-title">{shown.length} {shown.length === 1 ? "meeting" : "meetings"}</h2>
            <Input className="mt-filter" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by title or person" aria-label="Filter meetings" />
          </div>
          <ul className="mt-list" data-testid="meetings-list">
            {shown.map((m) => <MeetingCard key={m.id} m={m} />)}
            {!filter && hidden.map((h) => (
              <li key={h.id} className="mt-card mt-card--hidden">
                <DateTile date={h.date} />
                <div className="mt-card__main">
                  <p className="mt-card__title" style={{ color: "var(--text-muted)" }}>A meeting restricted to its attendees</p>
                  <div className="mt-card__meta"><span><Icon name="lock" /> You weren't there, so you can't open it. As an admin you can delete it.</span></div>
                </div>
                <div className="mt-card__side">
                  <Button size="sm" variant="ghost" iconLeft="trash" onClick={() => setDeleting(h.id)}>Delete</Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ImportMeeting open={importing} onClose={() => setImporting(false)} workspaceId={workspaceId} status={status}
        onImported={() => void load()} />
      <ConnectGoogleMeet open={connecting} onClose={() => { setConnecting(false); void load(); }} workspaceId={workspaceId}
        workspaceName={ws?.name ?? null} current={conn.mine} onConnected={(c) => setConn((x) => ({ ...x, mine: c }))} />
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} tone="danger" title="Delete this meeting?"
        description="Its pages go to the Trash for 30 days and its stored transcript is deleted now."
        confirmLabel="Delete meeting"
        onConfirm={async () => {
          if (!deleting) return;
          await deleteMeeting(deleting);
          toast.success("Meeting deleted.");
          setDeleting(null);
          void load();
        }} />
    </div>
  );
}

function DateTile({ date }: { date: string | null }) {
  const [y, mo, d] = (date || "").split("-").map(Number);
  const dt = y ? new Date(Date.UTC(y, (mo || 1) - 1, d || 1)) : null;
  return (
    <span className="mt-date" aria-hidden>
      <span>
        <span className="mt-date__m">{dt ? dt.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" }) : "—"}</span>
        <span className="mt-date__d" style={{ display: "block" }}>{dt ? dt.getUTCDate() : ""}</span>
      </span>
    </span>
  );
}

function MeetingCard({ m }: { m: Meeting }) {
  const names = m.attendees.map((a) => a.name);
  return (
    <li className="mt-card" data-testid="meeting-card">
      <DateTile date={m.date} />
      <div className="mt-card__main">
        <p className="mt-card__title">
          <Link className="mt-card__link" href={`/${m.slug}`} aria-label={`${m.title || "Meeting"}, ${m.date || ""}`} />
          {m.title || "Meeting"}
        </p>
        <div className="mt-card__meta">
          {m.type && <span><Icon name="calendar" />{m.type}{m.duration_s ? ` · ${fmtDuration(m.duration_s)}` : ""}</span>}
          {names.length > 0 && <span title={names.join(", ")}><Icon name="users" />{names.slice(0, 3).join(", ")}{names.length > 3 ? ` +${names.length - 3}` : ""}</span>}
          <span><Icon name="checkSquare" />{m.action_items} action {m.action_items === 1 ? "item" : "items"}</span>
        </div>
      </div>
      <div className="mt-card__side">
        {m.ai.state === "pending" && <span className="mt-state"><Spinner size={12} /> Summarizing</span>}
        {m.source === "auto" && <Badge size="sm" tone="neutral" icon="refresh">Auto</Badge>}
        {m.has_notes && <Badge size="sm" tone="info">Google notes</Badge>}
        {m.restricted && <Badge size="sm" tone="warning" icon="lock">Attendees only</Badge>}
      </div>
    </li>
  );
}
