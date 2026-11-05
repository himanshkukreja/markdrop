"use client";

/**
 * The meeting panel on a meeting page (and its transcript): the "Meeting" pill opens a side panel on
 * desktop and a bottom sheet on phones with two tabs:
 *
 *  - Ask: Ask this meeting (streamed answers whose citations jump to the transcript moment).
 *  - Details: date, type, who was there, where it came from (links back to Google's Docs), the AI
 *    summary's state (Regenerate), Restrict to attendees (the page's owner), Delete (the importer
 *    or a workspace admin), and All meetings.
 *
 * DocumentView mounts it lazily for signed-in readers when the page says it is a meeting
 * (page_fields `meeting`); the meeting itself is decided again by GET /meetings/{id}. While the
 * summary is being written the panel polls, and the page updates through its live socket.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { slackPostMeeting } from "@/lib/slack";
import { Badge, Button, ConfirmDialog, Icon, IconButton, Select, Spinner, Switch, useToast } from "@/components/ui";
import { PHONE_QUERY, useMediaQuery } from "@/components/kit/publish-utils";
import {
  MEETING_TYPES, deleteMeeting, fmtDuration, fmtMeetingDate, getMeeting, meetingsHref, patchMeeting, regenerateMeeting,
  type Meeting,
} from "@/lib/meetings";
import { MeetingChat } from "./MeetingChat";
import "@/components/pages/ai/ask-pill.css";
import "@/components/pages/ai/ask.css";
import "./meetings.css";

const SUGGESTIONS = [
  { q: "What did we decide?", icon: "checkCircle" },
  { q: "What are the action items, and who owns them?", icon: "checkSquare" },
  { q: "What's still open?", icon: "flag" },
  { q: "Summarize it in three bullets", icon: "lines" },
];

export function MeetingLauncher({ meetingId }: { meetingId: string; role?: string }) {
  const phone = useMediaQuery(PHONE_QUERY);
  const router = useRouter();
  const toast = useToast();
  const [m, setM] = useState<Meeting | null>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"ask" | "details">("ask");
  const pill = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const got = await getMeeting(meetingId);
      setM(got);
      return got;
    } catch {
      setM(null);
      return null;
    }
  }, [meetingId]);

  useEffect(() => { void load(); }, [load]);

  // The summary is being written: check every few seconds; the page fills in through its socket.
  const wasPending = useRef(false);
  useEffect(() => {
    if (m?.ai.state !== "pending") {
      if (wasPending.current && m?.ai.state === "done") {
        toast.success("The AI summary is in.");
        router.refresh();
      }
      wasPending.current = false;
      return;
    }
    wasPending.current = true;
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [m?.ai.state, load, router, toast]);

  const close = useCallback(() => {
    setOpen(false);
    window.setTimeout(() => pill.current?.focus({ preventScroll: true }), 0);
  }, []);

  if (!m) return null;
  return (
    <>
      <button
        ref={pill}
        type="button"
        className="pa-pill no-print"
        data-hidden={open ? "" : undefined}
        aria-hidden={open || undefined}
        tabIndex={open ? -1 : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        data-testid="meeting-pill"
      >
        {m.ai.state === "pending" ? <Spinner size={16} /> : <Icon name="mic" className="pa-pill__icon" />}
        <span>Ask this meeting</span>
      </button>
      {createPortal(
        <div className="pa-ask mt-panel" data-open={open ? "" : undefined} data-phone={phone ? "" : undefined} inert={!open}>
          {phone && <div className="pa-ask__scrim" onClick={close} aria-hidden />}
          <section className="pa-ask__panel" role="dialog" aria-modal={phone || undefined} aria-labelledby="mt-panel-title"
            onKeyDown={(e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.stopPropagation(); close(); } }}>
            {phone && <div className="pa-ask__handle" aria-hidden />}
            <header className="pa-ask__head">
              <span className="pa-ask__glyph" aria-hidden><Icon name="mic" /></span>
              <div className="pa-ask__titles">
                <h2 id="mt-panel-title">{m.title || "Meeting"}</h2>
                <p>{[fmtMeetingDate(m.date), m.type, m.restricted ? "Attendees only" : null].filter(Boolean).join(" · ")}</p>
              </div>
              <IconButton icon="x" label="Close" size="sm" onClick={close} />
            </header>
            <div className="mt-tabs" role="tablist" aria-label="Meeting">
              <button type="button" role="tab" className="mt-tab" aria-selected={tab === "ask"} onClick={() => setTab("ask")}>Ask</button>
              <button type="button" role="tab" className="mt-tab" aria-selected={tab === "details"} onClick={() => setTab("details")} data-testid="meeting-details-tab">Details</button>
            </div>
            {tab === "ask" ? (
              <MeetingChat
                mode="one"
                meetingId={m.id}
                suggestions={SUGGESTIONS}
                emptyTitle="Ask this meeting"
                emptySub={m.has_transcript ? "Answers come from the transcript and the page, with chips that jump to the moment it was said." : "Answers come from Google's notes on this page."}
                placeholder="Ask about this meeting…"
                autoFocus={open && !phone}
                onNavigate={phone ? close : undefined}
                banner={<SummaryBanner m={m} />}
              />
            ) : (
              <Details m={m} onChange={setM} onDeleted={() => { close(); router.push(meetingsHref(m.workspace_id)); }} />
            )}
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}

function SummaryBanner({ m }: { m: Meeting }) {
  if (m.ai.state === "pending") return <div className="mt-banner" role="status"><Spinner size={14} /> Writing the summary, decisions and action items…</div>;
  if (m.ai.state === "failed" || m.ai.state === "skipped") {
    return (
      <div className="mt-banner mt-banner--warn" role="status">
        <Icon name="info" /> {m.ai.message || "There's no AI summary for this meeting."}
      </div>
    );
  }
  return null;
}

function Details({ m, onChange, onDeleted }: { m: Meeting; onChange: (m: Meeting) => void; onDeleted: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const run = async (what: string, fn: () => Promise<Meeting | void>, ok: string) => {
    setBusy(what);
    try {
      const next = await fn();
      if (next) onChange(next);
      toast.success(ok);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-details">
      <dl className="mt-facts">
        <dt>Date</dt><dd>{fmtMeetingDate(m.date) || "—"}{m.time ? ` · ${m.time}` : ""}{m.duration_s ? ` · ${fmtDuration(m.duration_s)}` : ""}</dd>
        <dt>Type</dt>
        <dd>
          {m.can_regenerate ? (
            <Select aria-label="Meeting type" value={m.type || "Other"} disabled={!!busy}
              onChange={(e) => void run("type", () => patchMeeting(m.id, { type: e.target.value }), "Type changed.")}
              options={MEETING_TYPES.map((t) => ({ value: t, label: t }))} />
          ) : (m.type || "—")}
        </dd>
        <dt>Transcript</dt><dd>{m.has_transcript ? <a href={`/${m.transcript_slug}`}>{m.segments} lines</a> : "None (Google's notes only)"}{m.approx_times ? " · times every 5 min, estimated between" : ""}</dd>
        <dt>Action items</dt><dd>{m.action_items}</dd>
      </dl>

      <div>
        <p className="pa-sources__label" style={{ margin: "0 0 6px" }}>Who was there</p>
        <div className="mt-people">
          {m.attendees.length === 0 && <span className="mt-cost">Nobody named in it.</span>}
          {m.attendees.map((a) => (
            <span key={a.name} className="mt-person" data-member={a.user_id ? "" : undefined} title={a.user_id ? "A member of this workspace" : "Not a member of this workspace"}>
              <span className="mt-date__m" style={{ display: "grid", placeItems: "center", width: 20, height: 20, borderRadius: 999, background: "var(--surface-inset)" }}>{a.name.slice(0, 1)}</span>
              {a.name}
            </span>
          ))}
        </div>
      </div>

      <div>
        <p className="pa-sources__label" style={{ margin: "0 0 6px" }}>Sources</p>
        <ul className="mt-srcs">
          {m.sources.map((s, i) => (
            <li key={i} className="mt-src">
              <Icon name={s.origin === "google" ? "google" : s.kind === "notes" ? "lines" : "doc"} />
              {s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer">{s.name || "Google Doc"}</a> : <span>{s.name}</span>}
              <Badge size="sm" tone="neutral">{s.kind === "notes" ? "Google notes" : s.kind === "both" ? "Notes + transcript" : "Transcript"}</Badge>
            </li>
          ))}
        </ul>
        {m.source && m.source !== "manual" && (
          <p className="mt-src-via" data-testid="meeting-via">
            <Icon name={m.source === "auto" ? "refresh" : "sparkle"} />
            {m.source === "auto" ? "Imported automatically by Connect Google Meet" : "Imported by an AI app (MCP)"}
          </p>
        )}
      </div>

      <div className="mt-switchrow">
        <span className="mt-switchrow__text">
          <b>Only the people who were there</b>
          {m.can_manage ? "Off: everyone in the workspace can open it. On: only attendees who are members." : m.restricted ? "Only attendees who are members can open it." : "Everyone in the workspace can open it."}
        </span>
        <Switch checked={m.restricted} disabled={!m.can_manage || !!busy} aria-label="Restrict to attendees" data-testid="meeting-restrict"
          onChange={(e) => void run("restrict", () => patchMeeting(m.id, { restricted: e.target.checked }), e.target.checked ? "Only attendees can open it now." : "The team can open it again.")} />
      </div>

      <div>
        <p className="pa-sources__label" style={{ margin: "0 0 6px" }}>AI summary</p>
        <p className="mt-cost" style={{ margin: "0 0 8px" }}>
          {m.ai.state === "done" ? `Written by Claude Haiku${m.ai.cost_usd ? ` · $${m.ai.cost_usd.toFixed(4)}` : ""}` : m.ai.state === "pending" ? "Being written…" : m.ai.message || "None yet."}
        </p>
        {m.can_regenerate && (
          <Button size="sm" variant="secondary" iconLeft="refresh" loading={busy === "regen"} disabled={!!busy || m.ai.state === "pending"}
            onClick={() => void run("regen", () => regenerateMeeting(m.id), "Summary rewritten.")}>
            {m.ai.state === "done" ? "Write it again" : "Write the summary"}
          </Button>
        )}
      </div>

      <div className="mt-dangerzone">
        <Button size="sm" variant="ghost" iconLeft="mic" href={meetingsHref(m.workspace_id)}>All meetings</Button>
        {m.slack_channel && m.can_regenerate && !m.restricted && (
          <Button size="sm" variant="ghost" iconLeft="send" disabled={!!busy} loading={busy === "slack"} data-testid="meeting-slack"
            onClick={() => void run("slack", async () => { await slackPostMeeting(m.id); }, `Posted to #${m.slack_channel} in Slack.`)}>
            Post to Slack
          </Button>
        )}
        {m.can_delete && (
          <Button size="sm" variant="ghost" iconLeft="trash" onClick={() => setConfirm(true)} disabled={!!busy}>Delete meeting</Button>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        tone="danger"
        title="Delete this meeting?"
        description="Its page and transcript go to the Trash for 30 days; the stored transcript Markdrop AI answers from is deleted now."
        confirmLabel="Delete meeting"
        onConfirm={async () => {
          try {
            await deleteMeeting(m.id);
            toast.success("Meeting deleted.");
            setConfirm(false);
            onDeleted();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Couldn't delete it.");
          }
        }}
      />
    </div>
  );
}

export default MeetingLauncher;
