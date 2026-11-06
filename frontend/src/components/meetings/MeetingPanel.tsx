"use client";

/**
 * The meeting panel on a meeting page (and its transcript): the "Meeting" pill opens a side panel on
 * desktop and a bottom sheet on phones with the meeting's details: date, type, who was there, where it
 * came from (links back to Google's Docs), the AI summary's state (Regenerate), Restrict to attendees
 * (the page's owner), Delete (the importer or a workspace admin), and All meetings.
 *
 * Asking is Ask Markdrop's (components/assistant): the meeting bar's "Ask this meeting", ✦ Ask in the
 * top bar, ⌘J and a card's "Ask this meeting" (?ask=1) open it on this meeting.
 *
 * DocumentView mounts it lazily for signed-in readers when the page says it is a meeting
 * (page_fields `meeting`); the meeting itself is decided again by GET /meetings/{id}. While the
 * summary is being written the panel polls, and the page updates through its live socket.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { slackPostMeeting } from "@/lib/slack";
import { Badge, Button, ConfirmDialog, Icon, IconButton, Input, Select, Spinner, Switch, useToast } from "@/components/ui";
import { PHONE_QUERY, useMediaQuery } from "@/components/kit/publish-utils";
import {
  MEETING_TYPES, deleteMeeting, fmtDuration, fmtMeetingDate, getMeeting, meetingsHref, patchMeeting, regenerateMeeting,
  type Meeting,
} from "@/lib/meetings";
import { openAssistant } from "@/components/assistant/store";
import "@/components/pages/ai/ask-pill.css";
import "@/components/pages/ai/ask.css";
import "./meetings.css";
import { initialsOf } from "@/lib/initials.mjs";


// One meeting, shared by the panel and the page's meeting bar (one fetch; a change in Details shows in both).
const cache = new Map<string, Meeting | null>();
const listeners = new Set<() => void>();
const loading = new Map<string, Promise<Meeting | null>>();
function setCached(id: string, m: Meeting | null) {
  cache.set(id, m);
  listeners.forEach((l) => l());
}
function fetchMeeting(id: string, fresh = false): Promise<Meeting | null> {
  if (!fresh && loading.has(id)) return loading.get(id)!;
  const p = getMeeting(id).then((m) => { setCached(id, m); return m; }).catch(() => { setCached(id, null); return null; })
    .finally(() => loading.delete(id));
  loading.set(id, p);
  return p;
}
function useMeeting(id: string): [Meeting | null, (m: Meeting) => void, () => Promise<Meeting | null>] {
  const m = useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => cache.get(id) ?? null,
    () => null,
  );
  useEffect(() => { if (!cache.has(id)) void fetchMeeting(id); }, [id]);
  const set = useCallback((next: Meeting) => setCached(id, next), [id]);
  const reload = useCallback(() => fetchMeeting(id, true), [id]);
  return [m, set, reload];
}

/**
 * The meeting bar under a meeting page's properties: who was there, who can open it, and the two things
 * people do next — read the transcript, ask the meeting. On the transcript: back to the meeting, ask.
 */
export function MeetingHeader({ meetingId, role, extra }: { meetingId: string; role?: string; extra?: React.ReactNode }) {
  const [m] = useMeeting(meetingId);
  if (!m) return null;
  // Who joined; with nobody known to have joined, the calendar invite, worded "invited" (never "people").
  const invitedOnly = m.attendees.length === 0 && (m.invited?.length ?? 0) > 0;
  const people = invitedOnly ? m.invited ?? [] : m.attendees;
  const ask = () => openAssistant({ scope: "meetings" });
  return (
    <div className="mt-pagebar no-print" data-testid="meeting-header">
      <div className="mt-pagebar__facts">
        {people.length > 0 && (
          <span className="mt-pagebar__people" title={people.map((a) => a.name).join(", ")}>
            <span className="mt-faces" aria-hidden>
              {people.slice(0, 5).map((a) => (
                <span key={a.name} className="mt-face" style={{ background: `hsl(${hueOf(a.name)} 45% 46%)` }}>
                  {initialsOf(a.name)}
                </span>
              ))}
            </span>
            {invitedOnly ? `${people.length} invited` : `${people.length} ${people.length === 1 ? "person" : "people"}`}
          </span>
        )}
        {m.organizer?.name && <span className="mt-pagebar__fact"><Icon name="user" />Organized by {m.organizer.name}</span>}
        <span className="mt-pagebar__fact" data-testid="meeting-privacy">
          <Icon name={m.restricted ? "lock" : "users"} />{m.restricted ? "Only the people who were there" : "Everyone in the workspace"}
        </span>
      </div>
      <div className="mt-pagebar__actions">
        {extra}
        {role === "transcript"
          ? <Button size="sm" variant="secondary" iconLeft="arrowLeft" href={`/${m.slug}`}>The meeting</Button>
          : m.transcript_slug && <Button size="sm" variant="secondary" iconLeft="lines" href={`/${m.transcript_slug}`} data-testid="meeting-transcript">Transcript</Button>}
        <Button size="sm" iconLeft="sparkle" onClick={ask} data-testid="meeting-ask">Ask this meeting</Button>
      </div>
    </div>
  );
}

function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

export function MeetingLauncher({ meetingId }: { meetingId: string; role?: string }) {
  const phone = useMediaQuery(PHONE_QUERY);
  const router = useRouter();
  const toast = useToast();
  const [m, setM, load] = useMeeting(meetingId);
  const [open, setOpen] = useState(false);
  const pill = useRef<HTMLButtonElement>(null);

  // A card's "Ask this meeting" (?ask=1): Ask Markdrop on this meeting.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("ask") === "1") openAssistant({ scope: "meetings" });
  }, [meetingId]);

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
        <span>Meeting</span>
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
            <Details m={m} onChange={setM} onDeleted={() => { close(); router.push(meetingsHref(m.workspace_id)); }}
              top={(
                <>
                  <SummaryBanner m={m} />
                  <button type="button" className="mt-askrow" onClick={() => { close(); openAssistant({ scope: "meetings" }); }} data-testid="meeting-panel-ask">
                    <Icon name="sparkle" /> Ask this meeting
                  </button>
                </>
              )} />
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

/** The meeting's series ("Daily Standup"): saved when the field loses focus; empty takes it out. */
function SeriesField({ value, disabled, onCommit }: { value: string; disabled: boolean; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <Input size="sm" value={v} disabled={disabled} placeholder="None (a one-off)" aria-label="Series" data-testid="meeting-series"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v.trim() !== value) onCommit(v.trim()); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}

function Details({ m, onChange, onDeleted, top }: { m: Meeting; onChange: (m: Meeting) => void; onDeleted: () => void; top?: React.ReactNode }) {
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
      {top}
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
        <dt>Series</dt>
        <dd>
          {m.can_regenerate ? (
            <SeriesField value={m.series ?? ""} disabled={!!busy}
              onCommit={(v) => void run("series", () => patchMeeting(m.id, { series: v || null }), v ? `In the series “${v}”.` : "Taken out of its series.")} />
          ) : (m.series || "—")}
        </dd>
        <dt>Transcript</dt><dd>{m.has_transcript ? <a href={`/${m.transcript_slug}`}>{m.segments} lines</a> : "None (Google's notes only)"}{m.approx_times ? " · times every 5 min, estimated between" : ""}</dd>
        <dt>Action items</dt><dd>{m.action_items}</dd>
        <dt>Organizer</dt>
        <dd data-testid="meeting-organizer">
          {m.organizer?.name
            ? <>{m.organizer.name}{m.organizer.from === "drive" ? <span className="mt-cost"> · owns the Google Doc</span> : null}</>
            : <span className="mt-cost">Not known{m.can_regenerate ? " (set it in the page's Organizer property)" : ""}</span>}
        </dd>
        {m.imported_by?.name && <><dt>Imported by</dt><dd data-testid="meeting-imported-by">{m.imported_by.name}</dd></>}
        {(m.invited?.length ?? 0) > 0 && (
          <><dt>Invited</dt><dd data-testid="meeting-invited" title={(m.invited ?? []).map((a) => a.name).join(", ")}>{m.invited!.length}<span className="mt-cost"> · on the calendar invite, joined or not</span></dd></>
        )}
      </dl>

      <div>
        <p className="pa-sources__label" style={{ margin: "0 0 6px" }}>Who was there</p>
        <div className="mt-people">
          {m.attendees.length === 0 && <span className="mt-cost">{(m.invited?.length ?? 0) > 0 ? "Not known: Google's notes only list who was invited." : "Nobody named in it."}</span>}
          {m.attendees.map((a) => (
            <span key={a.name} className="mt-person" data-member={a.user_id ? "" : undefined} title={a.user_id ? "A member of this workspace" : "Not a member of this workspace"}>
              <span className="mt-date__m" style={{ display: "grid", placeItems: "center", width: 20, height: 20, borderRadius: 999, background: "var(--surface-inset)" }}>{initialsOf(a.name).slice(0, 1)}</span>
              {a.name}
            </span>
          ))}
        </div>
        {m.attendees_from === "notes" && m.attendees.length > 0 && (
          <p className="mt-cost" data-testid="meeting-attendees-from-notes" style={{ margin: "6px 0 0" }}>From Google&apos;s notes: the people they name.</p>
        )}
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
          {m.auto_restricted && m.restricted ? " Turned on by itself: a 1:1 or two-person call." : ""}
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
