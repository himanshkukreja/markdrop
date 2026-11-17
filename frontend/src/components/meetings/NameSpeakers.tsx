"use client";

/**
 * Name the speakers (backend services/meeting_speakers.py; owner, 2026-11-17): a transcribed meeting's
 * "Speaker 2", "Speaker 3"… (speech-to-text tells voices apart, not who they are) become people.
 *
 *  - SpeakersBanner: on the meeting page and its transcript, for people who can edit the meeting, while
 *    "Speaker N" labels are left: "3 speakers aren't named yet · Name them" (Hide: for me, on this meeting).
 *  - NameSpeakersHost: the dialog, mounted once per meeting page (MeetingLauncher). It opens from the
 *    banner, the panel's Speakers row, a "Speaker N" lead on the transcript page, and the host's
 *    notification link (?speakers=name). Each speaker: talk time, a few of their lines, Markdrop's guess
 *    (marked as a guess, used only when clicked) and a picker: the meeting's attendees, workspace
 *    members, or any name typed. A named speaker can be changed too (a wrong name).
 *  - After naming, "Write it again" writes the summary and Details again so they use the names
 *    (Markdrop doesn't do it on its own: on an edited page it would add a second set of sections).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Dialog, Icon, IconButton, Input, Spinner, useToast } from "@/components/ui";
import { searchMembers } from "@/components/pages/props/api";
import {
  dismissMeetingSpeakers, getMeetingSpeakers, regenerateMeeting, renameMeetingSpeaker,
  type Meeting, type MeetingSpeaker, type MeetingSpeakers,
} from "@/lib/meetings";
import { track } from "@/lib/track";

const GENERIC = /^Speaker \d{1,3}$/;
export const isGenericSpeaker = (label: string) => GENERIC.test(label.trim());

const openers = new Set<(label: string | null) => void>();
/** Open the dialog (on the speaker ``label`` when given). */
export function openNameSpeakers(label: string | null = null) {
  openers.forEach((f) => f(label));
}

export function talkTime(s: number): string {
  if (s < 60) return `${Math.max(1, Math.round(s))}s`;
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return r ? `${m}m ${r}s` : `${m}m`;
}

function clock(t: number | null): string {
  if (t == null) return "";
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function SpeakersBanner({ m, onChange }: { m: Meeting; onChange: (m: Meeting) => void }) {
  const n = m.unnamed_speakers ?? 0;
  if (!m.can_regenerate || n <= 0 || m.speakers_dismissed) return null;
  const hide = () => {
    onChange({ ...m, speakers_dismissed: true });
    void dismissMeetingSpeakers(m.id).catch(() => {});
    track("meeting_speakers", { what: "dismiss" });
  };
  return (
    <div className="mt-banner mt-spk-banner no-print" role="status" data-testid="meeting-speakers-banner">
      <Icon name="mic" />
      <span className="mt-spk-banner__text">
        {n === 1 ? "1 speaker isn't named yet." : `${n} speakers aren't named yet.`} Name them so the notes and Ask use real names.
      </span>
      <Button size="sm" onClick={() => openNameSpeakers()} data-testid="meeting-speakers-name">Name them</Button>
      <IconButton icon="x" label="Hide for me" size="sm" onClick={hide} />
    </div>
  );
}

type Pick = { name: string; userId?: string };

function SpeakerPicker({ workspaceId, attendees, guess, busy, onPick, onCancel }: {
  workspaceId: string; attendees: MeetingSpeakers["attendees"]; guess: string | null; busy: boolean;
  onPick: (p: Pick) => void; onCancel: () => void;
}) {
  const [q, setQ] = useState("");
  const [members, setMembers] = useState<Array<{ id: string; name: string }>>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const needle = q.trim();
    if (!needle) { setMembers([]); return; }
    let live = true;
    const t = window.setTimeout(() => {
      searchMembers(workspaceId, needle).then((r) => { if (live) setMembers(r.slice(0, 6)); }).catch(() => {});
    }, 200);
    return () => { live = false; window.clearTimeout(t); };
  }, [q, workspaceId]);
  const needle = q.trim().toLowerCase();
  const people = attendees.filter((a) => !needle || a.name.toLowerCase().includes(needle)).slice(0, 8);
  const seen = new Set(people.map((a) => a.name.toLowerCase()));
  const more = members.filter((x) => !seen.has(x.name.toLowerCase()));
  const typed = q.trim();
  const exact = typed && [...people.map((a) => a.name), ...more.map((x) => x.name)].some((n) => n.toLowerCase() === typed.toLowerCase());
  return (
    <div className="mt-spk-pick" data-testid="meeting-speaker-picker">
      <Input ref={input} size="sm" value={q} placeholder="Who is it? Type a name" aria-label="Who is it?" disabled={busy}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
          if (e.key === "Enter" && typed && !busy) onPick({ name: typed });
        }} />
      <div className="mt-spk-pick__list" role="list">
        {guess && !needle && (
          <button type="button" role="listitem" className="mt-spk-opt mt-spk-opt--guess" disabled={busy} onClick={() => onPick({ name: guess })}
            data-testid="meeting-speaker-guess">
            <Icon name="sparkle" /> {guess} <Badge size="sm" tone="neutral">Markdrop&apos;s guess</Badge>
          </button>
        )}
        {people.map((a) => (
          <button type="button" role="listitem" key={`a-${a.name}`} className="mt-spk-opt" disabled={busy}
            onClick={() => onPick({ name: a.name, userId: a.user_id ?? undefined })}>
            <Icon name="user" /> {a.name} <span className="mt-cost">was there</span>
          </button>
        ))}
        {more.map((x) => (
          <button type="button" role="listitem" key={`m-${x.id}`} className="mt-spk-opt" disabled={busy} onClick={() => onPick({ name: x.name, userId: x.id })}>
            <Icon name="users" /> {x.name} <span className="mt-cost">member</span>
          </button>
        ))}
        {typed && !exact && (
          <button type="button" role="listitem" className="mt-spk-opt" disabled={busy} onClick={() => onPick({ name: typed })}>
            <Icon name="plus" /> Use “{typed}”
          </button>
        )}
      </div>
      <div className="mt-spk-pick__foot">
        {busy ? <Spinner size={14} label="Naming" /> : null}
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}

function SpeakerRow({ s, editing, busy, data, workspaceId, onEdit, onPick, onCancel }: {
  s: MeetingSpeaker; editing: boolean; busy: boolean; data: MeetingSpeakers; workspaceId: string;
  onEdit: () => void; onPick: (p: Pick) => void; onCancel: () => void;
}) {
  return (
    <li className="mt-spk" data-generic={s.generic ? "" : undefined} data-testid="meeting-speaker">
      <div className="mt-spk__head">
        <b>{s.label}</b>
        <span className="mt-cost">{s.lines} {s.lines === 1 ? "line" : "lines"} · {talkTime(s.talk_s)}</span>
        {!editing && (
          <Button size="sm" variant={s.generic ? "primary" : "ghost"} onClick={onEdit} disabled={busy}>
            {s.generic ? "Name" : "Change"}
          </Button>
        )}
      </div>
      {s.generic && s.samples.length > 0 && (
        <ul className="mt-spk__lines">
          {s.samples.map((x) => (
            <li key={x.n}>{x.t != null && <span className="mt-cost">{clock(x.t)}</span>} “{x.text}”</li>
          ))}
        </ul>
      )}
      {editing && (
        <SpeakerPicker workspaceId={workspaceId} attendees={data.attendees.filter((a) => a.name !== s.label)}
          guess={s.generic ? s.guess : null} busy={busy} onPick={onPick} onCancel={onCancel} />
      )}
      {!editing && s.generic && s.guess && (
        <p className="mt-spk__guess">
          <Icon name="sparkle" /> Markdrop&apos;s guess: <button type="button" className="mt-linkbtn" disabled={busy} onClick={() => onPick({ name: s.guess! })}>{s.guess}</button>
          <span className="mt-cost"> (not sure: click to use it)</span>
        </p>
      )}
    </li>
  );
}

export function NameSpeakersHost({ m, onChange }: { m: Meeting; onChange: (m: Meeting) => void }) {
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [data, setData] = useState<MeetingSpeakers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [renamed, setRenamed] = useState(0);
  const canEdit = m.can_regenerate && m.has_transcript;

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await getMeetingSpeakers(m.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the speakers.");
    }
  }, [m.id]);

  useEffect(() => {
    if (!canEdit) return;
    const f = (label: string | null) => {
      setOpen(true);
      setEditing(label);
      void load();
      track("meeting_speakers", { what: "open" });
    };
    openers.add(f);
    return () => { openers.delete(f); };
  }, [canEdit, load]);

  // The host's notification links here: /<meeting>?speakers=name.
  useEffect(() => {
    if (!canEdit) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("speakers") !== "name") return;
    url.searchParams.delete("speakers");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    openNameSpeakers();
  }, [canEdit]);

  if (!canEdit) return null;

  const pick = async (label: string, p: Pick) => {
    setBusy(label);
    try {
      const r = await renameMeetingSpeaker(m.id, label, p.userId ? { userId: p.userId } : { name: p.name });
      onChange(r.meeting);
      setRenamed((n) => n + 1);
      setEditing(null);
      toast.success(`${label} is ${r.renamed.to} now${r.renamed.transcript === "left" ? " (the Transcript page was edited, so it was left as it is)" : ""}.`);
      track("meeting_speakers", { what: "rename", generic: isGenericSpeaker(label) });
      await load();
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const rewrite = async () => {
    setBusy("regen");
    try {
      onChange(await regenerateMeeting(m.id));
      toast.success("Written again with the names.");
      setRenamed(0);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const speakers = data ? [...data.speakers].sort((a, b) => Number(b.generic) - Number(a.generic)) : [];
  const left = data?.unnamed ?? m.unnamed_speakers ?? 0;
  return (
    <Dialog open={open} onClose={() => { setOpen(false); setEditing(null); }} size="lg" glyph={<Icon name="mic" />}
      title="Name the speakers"
      description={left > 0
        ? "Speech-to-text tells voices apart, not who they are. Pick who each one is: the transcript, attendees, captions and Ask use the name."
        : "Every speaker has a name. Change one if it's wrong."}
      footer={renamed > 0 ? (
        <div className="mt-spk-again" data-testid="meeting-speakers-again">
          <span>The summary and Details still use the old labels. Write them again with the names?</span>
          <Button size="sm" iconLeft="refresh" loading={busy === "regen"} disabled={!!busy || m.ai.state === "pending"} onClick={() => void rewrite()}>
            Write it again
          </Button>
        </div>
      ) : undefined}>
      {error && <p className="mt-cost" role="alert">{error}</p>}
      {!data && !error && <Spinner size={16} label="Loading speakers" />}
      {data && (
        <ul className="mt-spks">
          {speakers.map((s) => (
            <SpeakerRow key={s.label} s={s} data={data} workspaceId={m.workspace_id} editing={editing === s.label}
              busy={!!busy} onEdit={() => setEditing(s.label)} onCancel={() => setEditing(null)}
              onPick={(p) => void pick(s.label, p)} />
          ))}
        </ul>
      )}
      {data && data.renames.length > 0 && (
        <p className="mt-cost mt-spk-hist" data-testid="meeting-speakers-history">
          Renamed: {data.renames.slice(0, 4).map((r) => `${r.from} → ${r.to}${r.by ? ` by ${r.by}` : ""}`).join("; ")}
        </p>
      )}
    </Dialog>
  );
}
