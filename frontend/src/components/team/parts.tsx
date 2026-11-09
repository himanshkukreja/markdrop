"use client";

/**
 * Team's shared pieces (components/team): the status chip, a line with where it came from and its ⋯ menu
 * (Hide / This is wrong… on your own lines), target chips, the activity strip, and the dialogs for your
 * own status, focus note and corrections. Status and due states always carry a label and an icon, never
 * color alone. Everything shown was decided for the viewer by the server.
 */
import { useContext, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { JiraTeamContext } from "@/components/jira/JiraTeam";
import { Avatar, Button, Dialog, Dropdown, Field, Icon, IconButton, Input, Select, Textarea, useToast, type MenuEntry } from "@/components/ui";
import {
  correctLine, dueLabel, fmtDay, hideLine, markDone, setFocus, setStatus,
  type DueState, type Line, type OwnStatus, type SourceLink, type Status, type StatusState,
} from "@/lib/team";

const STATUS_ICON: Record<StatusState, string> = {
  on_track: "checkCircle", blocked: "alertCircle", waiting: "clock", self: "message", away: "sun", quiet: "minus",
};

export function StatusChip({ status, size = "md" }: { status: Status; size?: "sm" | "md" }) {
  return (
    <span className={`tm-status tm-status--${status.state} tm-status--${size}`} data-testid="team-status" data-state={status.state} title={status.label}>
      {status.emoji ? <span aria-hidden className="tm-status__emoji">{status.emoji}</span> : <Icon name={STATUS_ICON[status.state]} />}
      <span className="tm-status__label">{status.label}</span>
    </span>
  );
}

export function TargetChip({ text, due, state, compact }: { text?: string; due: string; state: DueState | null | undefined; compact?: boolean }) {
  return (
    <span className={`tm-due tm-due--${state || "upcoming"}`} data-testid="team-target">
      <Icon name={state === "overdue" ? "alert" : "calendar"} />
      <span className="tm-due__when">{dueLabel(due, state)}</span>
      {!compact && text && <span className="tm-due__text">{text}</span>}
    </span>
  );
}

export function SourceLinks({ sources }: { sources: SourceLink[] }) {
  if (!sources.length) return null;
  const s = sources[0]!;
  return (
    <span className="tm-src">
      <Link href={s.href} className="tm-src__link" title={`Open ${s.title}`}>
        <Icon name={s.kind === "meeting" ? "mic" : "doc"} />
        <span className="tm-src__title">{s.series || s.title}</span>
        {s.date && <span className="tm-src__date">· {fmtDay(s.date)}</span>}
      </Link>
      {s.moment && (
        <Link href={s.moment.href} className="tm-src__moment" aria-label="Jump to the moment in the transcript" title="Jump to the moment it was said">
          <Icon name="play" />
        </Link>
      )}
    </span>
  );
}

/** One line of a profile: the statement, its project / due date, where it came from, and (yours) a menu. */
const CreateIssueDialog = dynamic(() => import("@/components/jira/CreateIssueDialog").then((m) => m.CreateIssueDialog), { ssr: false, loading: () => null });

export function LineRow({ line, ws, onChanged, showPerson, hiddenList }: {
  line: Line; ws: string; onChanged: () => void; showPerson?: boolean; hiddenList?: boolean;
}) {
  const toast = useToast();
  const [correcting, setCorrecting] = useState(false);
  const [jira, setJira] = useState(false);
  const jiraCtx = useContext(JiraTeamContext);
  const items: MenuEntry[] = [];
  if (line.can_correct && !hiddenList && (line.kind === "action_item" || line.kind === "target")) {
    items.push({ label: "Mark done", icon: "check", description: "It leaves your open items, the board and This week.",
      onClick: async () => {
        try { await markDone(ws, line.id); toast.success("Marked done."); onChanged(); }
        catch (e) { toast.error(e instanceof Error ? e.message : "That didn't save."); }
      } });
  }
  if (line.can_correct && !hiddenList) {
    items.push({ label: line.kind === "action_item" || line.kind === "target" ? "Dismiss (hide this line)" : "Hide this line", icon: "eyeOff", description: "Nobody sees it, you can undo it here.",
      onClick: async () => { await hideLine(ws, line.id); toast.success("Hidden. It won't come back from that source."); onChanged(); } });
    items.push({ label: line.corrected ? "Change the correction…" : "This is wrong…", icon: "edit",
      onClick: () => setCorrecting(true) });
    if (line.corrected) {
      items.push({ label: "Remove the correction", icon: "undo",
        onClick: async () => { await correctLine(ws, line.id, null); onChanged(); } });
    }
  }
  if (jiraCtx.on && !hiddenList && (line.kind === "blocker" || line.kind === "target" || line.kind === "action_item" || line.kind === "working_on")) {
    items.push({ label: "Create Jira issue…", icon: "checkSquare", description: "Markdrop AI drafts it; you review, then it's created as you.",
      onClick: () => setJira(true) });
  }
  return (
    <li className={`tm-line tm-line--${line.kind}`} data-testid="team-line" data-kind={line.kind}>
      {showPerson && line.person && (
        <Avatar name={line.person.name} src={line.person.avatar_url ?? undefined} size="sm" className="tm-line__avatar" />
      )}
      <div className="tm-line__main">
        <p className="tm-line__text">
          {showPerson && line.person && <b>{line.person.name}: </b>}
          {line.kind === "blocker" && <span className="tm-line__kind tm-line__kind--blocker">Blocked</span>}
          {line.kind === "decision" && <span className="tm-line__kind">Decision</span>}
          {hiddenList && line.wrong ? <s>{line.text}</s> : line.text}
          {line.corrected && !line.wrong && <span className="tm-line__corr" title={line.original ? `Was: ${line.original}` : undefined}> (corrected)</span>}
        </p>
        <div className="tm-line__meta">
          {line.due && <TargetChip due={line.due} state={line.due_state} compact />}
          {line.waiting_on && <span className="tm-line__wait"><Icon name="clock" />Waiting on {line.waiting_on.name}</span>}
          {line.project && <span className="tm-proj">{line.project.name}</span>}
          <SourceLinks sources={line.sources} />
        </div>
      </div>
      {hiddenList ? (
        <Button size="sm" variant="ghost" iconLeft="undo" data-testid="team-undo" onClick={async () => {
          if (line.wrong) await correctLine(ws, line.id, null); else await hideLine(ws, line.id, false);
          onChanged();
        }}>Undo</Button>
      ) : items.length > 0 && (
        <Dropdown align="right" portal items={items} minWidth={260} aria-label="Line actions"
          trigger={<IconButton icon="more" label="Line actions" className="tm-line__more" data-testid="team-line-menu" />} />
      )}
      {correcting && <CorrectDialog ws={ws} line={line} onClose={() => setCorrecting(false)} onDone={onChanged} />}
      {jira && <CreateIssueDialog open={jira} item={{ fact_id: line.id }} workspaceId={ws} onClose={() => setJira(false)} onCreated={onChanged} />}
    </li>
  );
}

function CorrectDialog({ ws, line, onClose, onDone }: { ws: string; line: Line; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState(line.corrected ? line.text : "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await correctLine(ws, line.id, text.trim()); onDone(); onClose(); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="This is wrong" size="sm"
      description="Say what's right and people see that instead. Leave it empty to just take the line down. Team memory won't say it again."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save} data-testid="team-correct-save">Save</Button></>}>
      <p className="tm-dialog__quote">“{line.original || line.text}”</p>
      <Field label="What's right (optional)" htmlFor="tm-correct">
        <Textarea id="tm-correct" value={text} maxLength={300} rows={3} onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Finished the Lever import, not Greenhouse" data-testid="team-correct-text" />
      </Field>
    </Dialog>
  );
}

const UNTIL = [
  { value: "", label: "Don't clear" },
  { value: "today", label: "Today" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "week", label: "This week" },
  { value: "monday", label: "Until Monday" },
];

function untilIso(v: string): string | null {
  const d = new Date();
  if (v === "today") d.setHours(23, 59, 0, 0);
  else if (v === "tomorrow") { d.setDate(d.getDate() + 1); d.setHours(23, 59, 0, 0); }
  else if (v === "week") { d.setDate(d.getDate() + ((7 - d.getDay()) % 7)); d.setHours(23, 59, 0, 0); }
  else if (v === "monday") { d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7)); d.setHours(9, 0, 0, 0); }
  else return null;
  return d.toISOString();
}

const PRESETS = [
  { emoji: "🌴", text: "On leave" }, { emoji: "🤒", text: "Out sick" }, { emoji: "🎯", text: "Heads down" },
  { emoji: "⛔", text: "Blocked" }, { emoji: "✈️", text: "Travelling" },
];

/** Set your own status ("On leave till Mon"): it wins over what Team memory reads until it clears. */
export function StatusDialog({ ws, open, current, onClose, onDone }: {
  ws: string; open: boolean; current: OwnStatus | null; onClose: () => void; onDone: () => void;
}) {
  const [text, setText] = useState(current?.text ?? "");
  const [emoji, setEmoji] = useState(current?.emoji ?? "");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (clear = false) => {
    setBusy(true);
    try {
      await setStatus(ws, clear ? { text: "" } : { text: text.trim(), emoji: emoji || null, until: untilIso(until) });
      onDone(); onClose();
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Your status" size="sm"
      description="Everyone in the workspace sees it on Team, instead of what Team memory reads from meetings."
      footer={<>
        {current && <Button variant="ghost" onClick={() => save(true)} disabled={busy}>Clear</Button>}
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={busy} onClick={() => save()} disabled={!text.trim() && !emoji} data-testid="team-status-save">Save</Button>
      </>}>
      <div className="tm-presets">
        {PRESETS.map((p) => (
          <button key={p.text} type="button" className="tm-preset" aria-pressed={text === p.text}
            onClick={() => { setText(p.text); setEmoji(p.emoji); }}>
            <span aria-hidden>{p.emoji}</span>{p.text}
          </button>
        ))}
      </div>
      <Field label="Status" htmlFor="tm-status-text">
        <div className="tm-statusinput">
          <Input id="tm-status-text" value={text} maxLength={80} onChange={(e) => setText(e.target.value)}
            placeholder="On leave till Monday" data-testid="team-status-text" />
        </div>
      </Field>
      <Field label="Clear it" htmlFor="tm-status-until">
        <Select id="tm-status-until" value={until} onChange={(e) => setUntil(e.target.value)} options={UNTIL} />
      </Field>
    </Dialog>
  );
}

/** Your "What I'm focused on" note: it tops your card and your page. */
export function FocusDialog({ ws, open, current, onClose, onDone }: {
  ws: string; open: boolean; current: string | null; onClose: () => void; onDone: () => void;
}) {
  const [text, setText] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await setFocus(ws, text.trim()); onDone(); onClose(); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="What I'm focused on" size="sm"
      description="In your own words, on top of your card and your page. Team memory shows it for two weeks after you set it."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save} data-testid="team-focus-save">Save</Button></>}>
      <Textarea value={text} rows={3} maxLength={280} onChange={(e) => setText(e.target.value)} aria-label="What I'm focused on"
        placeholder="Shipping the sourcing filters this week" data-testid="team-focus-text" />
    </Dialog>
  );
}

/** A row of day cells (oldest first), one hue, darker for more; each cell says its day and count. */
export function ActivityStrip({ counts, today, label }: { counts: number[]; today: string; label: string }) {
  const max = Math.max(1, ...counts);
  const [y, m, d] = today.split("-").map(Number);
  const end = new Date(y!, (m ?? 1) - 1, d ?? 1);
  const total = counts.reduce((a, b) => a + b, 0);
  return (
    <span className="tm-strip" role="img" aria-label={`${label}: ${total} update${total === 1 ? "" : "s"} in the last ${counts.length} days`}>
      {counts.map((n, i) => {
        const day = new Date(end); day.setDate(end.getDate() - (counts.length - 1 - i));
        const lvl = n === 0 ? 0 : Math.min(5, Math.max(1, Math.ceil((n / max) * 5)));
        const when = day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
        return <span key={i} className={`tm-strip__cell tm-heat-${lvl}`} title={`${when}: ${n} update${n === 1 ? "" : "s"}`} />;
      })}
    </span>
  );
}

export function HeatLegend() {
  return (
    <span className="tm-heatlegend" aria-hidden>
      Fewer {[0, 1, 2, 3, 4, 5].map((l) => <span key={l} className={`tm-strip__cell tm-heat-${l}`} />)} More
    </span>
  );
}
