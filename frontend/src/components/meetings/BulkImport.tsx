"use client";

/**
 * Import past meetings (backend services/meeting_backfill.py): many transcripts and Gemini notes at
 * once — files dropped or picked, Google Docs picked several at a time, or several meetings pasted
 * with a "===" line between them. Nothing is created until the person has seen the review: one row
 * per meeting found, with its date (and where it came from), name, series, which halves were found,
 * and whether it is already in the workspace. Rows without a date are flagged and must get one.
 * Started, the import runs on the server, oldest first, and survives closing the page (the hub shows
 * its progress: BackfillProgress). A dialog on desktop, a bottom sheet with cards on phones.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert, Badge, Button, Checkbox, Dialog, Drawer, Icon, IconButton, Input, Spinner, Switch, Tabs, Textarea, useToast,
} from "@/components/ui";
import { PHONE_QUERY, useMediaQuery } from "@/components/kit/publish-utils";
import { connectGoogleDocs } from "@/lib/api";
import {
  ACCEPT, MAX_FILE_BYTES, addBackfillSources, backfillAction, createBackfill, discardBackfill, editBackfill, fileToSource,
  googlePickerToken, listBackfills, removeBackfillRow, splitPasted,
  type BackfillJob, type BackfillRow, type BackfillSource, type MeetingsStatus,
} from "@/lib/meetings";
import { openPicker } from "./ImportMeeting";
import "./meetings.css";
import "./backfill.css";

type Tab = "upload" | "google" | "paste";
const MAX_FILES = 300;
const BATCH = 20;
const BATCH_BYTES = 5_000_000;

export interface BulkImportProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  status: MeetingsStatus | null;
  /** Series the workspace already has (suggested in the Series field). */
  seriesNames: string[];
  onStarted: (job: BackfillJob) => void;
}

export function BulkImport({ open, onClose, workspaceId, status, seriesNames, onStarted }: BulkImportProps) {
  const phone = useMediaQuery(PHONE_QUERY);
  const toast = useToast();
  const [job, setJob] = useState<BackfillJob | null>(null);
  const [phase, setPhase] = useState<"add" | "review">("add");
  const [tab, setTab] = useState<Tab>("upload");
  const [paste, setPaste] = useState("");
  const [reading, setReading] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const loaded = useRef(false);

  // Opening again: the draft the person left (the review survives a reload).
  useEffect(() => {
    if (!open) { loaded.current = false; return; }
    if (loaded.current) return;
    loaded.current = true;
    setError(null); setPaste(""); setReading(null); setBusy(false);
    listBackfills(workspaceId).then((r) => {
      const draft = r.jobs.find((j) => j.state === "draft");
      setJob(draft ?? null);
      setPhase(draft && draft.rows.length ? "review" : "add");
    }).catch(() => { setJob(null); setPhase("add"); });
  }, [open, workspaceId]);

  const ensureJob = useCallback(async () => job ?? (await createBackfill({ workspace: workspaceId, quiet: true })), [job, workspaceId]);

  /** Sends sources in batches (≤ 20 files, ≤ 5 MB a request) and shows the review. */
  const send = async (sources: BackfillSource[]) => {
    if (!sources.length) return;
    setError(null);
    setBusy(true);
    setReading({ done: 0, total: sources.length });
    try {
      let j = await ensureJob();
      setJob(j);
      let batch: BackfillSource[] = [];
      let size = 0;
      let done = 0;
      const flush = async () => {
        if (!batch.length) return;
        j = await addBackfillSources(j.id, batch);
        done += batch.length;
        setJob(j);
        setReading({ done, total: sources.length });
        batch = []; size = 0;
      };
      for (const s of sources) {
        const n = (s.text?.length ?? 0) + (s.data_b64?.length ?? 0);
        if (batch.length >= BATCH || (batch.length && size + n > BATCH_BYTES)) await flush();
        batch.push(s);
        size += n;
      }
      await flush();
      setPhase("review");
      setPaste("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read those files. Try again.");
    } finally {
      setBusy(false);
      setReading(null);
    }
  };

  const addFiles = async (list: FileList | File[]) => {
    const files = Array.from(list);
    const ok: BackfillSource[] = [];
    let skipped = 0;
    for (const f of files.slice(0, MAX_FILES)) {
      if (f.size > MAX_FILE_BYTES || !/\.(txt|vtt|srt|sbv|docx|md)$/i.test(f.name)) { skipped += 1; continue; }
      try { ok.push(await fileToSource(f)); } catch { skipped += 1; }
    }
    if (files.length > MAX_FILES) toast.info(`The first ${MAX_FILES} files are read; import the rest in another go.`);
    if (skipped) toast.error(`${skipped} file${skipped === 1 ? " was" : "s were"} skipped: Markdrop reads .txt, .vtt, .srt, .sbv, .docx and .md files up to 4 MB.`);
    await send(ok);
  };

  const pickGoogle = async () => {
    setError(null);
    try {
      const creds = await googlePickerToken();
      const docs = await openPicker(creds);
      if (docs.length) await send(docs.map((d) => ({ name: d.name, google_file_id: d.id })));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't open Google Drive.");
    }
  };

  const addPaste = async () => {
    const parts = splitPasted(paste);
    await send(parts.map((text, i) => ({ name: parts.length > 1 ? `Pasted meeting ${i + 1}` : "Pasted text", text, origin: "paste" as const })));
  };

  /* ── review edits ── */
  const patch = async (body: Parameters<typeof editBackfill>[1]) => {
    if (!job) return;
    try {
      setJob(await editBackfill(job.id, body));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't change that.");
    }
  };
  const editRow = (row: BackfillRow, change: { title?: string; date?: string; series?: string | null; include?: boolean; restricted?: boolean }) =>
    patch({ rows: [{ id: row.id, ...change }] });
  const dropRow = async (row: BackfillRow) => {
    if (!job) return;
    try { setJob(await removeBackfillRow(job.id, row.id)); } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't remove it."); }
  };

  const start = async () => {
    if (!job) return;
    setBusy(true);
    setError(null);
    try {
      const j = await backfillAction(job.id, "start");
      onStarted(j);
      toast.success(`Importing ${j.counts.included} past meeting${j.counts.included === 1 ? "" : "s"}, oldest first.`);
      setJob(null);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the import.");
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (job) await discardBackfill(job.id).catch(() => {});
    setJob(null);
    setPhase("add");
    onClose();
  };

  const rows = job?.rows ?? [];
  const included = rows.filter((r) => r.include);
  const undated = included.filter((r) => !r.date);
  const dupes = rows.filter((r) => r.dup.status === "duplicate");
  const est = job?.estimate;
  const googleReady = !!status?.google.configured;

  const tabs = [
    { value: "upload", label: "Files", icon: "upload" },
    ...(googleReady ? [{ value: "google", label: "Google Docs", icon: "google" }] : []),
    { value: "paste", label: "Paste", icon: "clipboard" },
  ];

  const addBody = (
    <div className="mt-import">
      <Tabs items={tabs} value={tab} onChange={(v) => { setTab(v as Tab); setError(null); }} idPrefix="mt-bulk" />
      {tab === "upload" && (
        <label className="mt-drop mt-drop--big" data-over={over ? "" : undefined} data-testid="bulk-drop"
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); void addFiles(e.dataTransfer.files); }}>
          <Icon name="upload" />
          <b>Drop all your meeting files here, or choose them</b>
          <span>Transcripts and Gemini notes, mixed: .txt · .vtt · .srt · .sbv · .docx · .md. Google's file names carry the date; notes and the transcript of one call become one meeting.</span>
          <input type="file" multiple accept={ACCEPT} className="sr-only" aria-label="Choose files" disabled={busy}
            onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }} />
        </label>
      )}
      {tab === "google" && (
        <div className="mt-google">
          <p style={{ margin: 0 }}>Pick every transcript and “Notes by Gemini” Doc you want, in one go (hold ⌘ or Ctrl, or Shift for a range).</p>
          {status?.google.connected ? (
            <Button variant="secondary" iconLeft="google" onClick={() => void pickGoogle()} disabled={busy}>Choose from Google Drive</Button>
          ) : (
            <Button variant="secondary" iconLeft="google" onClick={() => void connectGoogleDocs(window.location.pathname).catch((e: Error) => setError(e.message))}>
              Connect Google Docs
            </Button>
          )}
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Markdrop can open only the files you pick. A Doc without a date in its name is dated by the day Google created it.</span>
        </div>
      )}
      {tab === "paste" && (
        <>
          <Textarea id="mt-bulk-paste" value={paste} onChange={(e) => setPaste(e.target.value)} spellCheck={false}
            aria-label="Meetings, separated by a line of ===" placeholder={"Daily Standup – 2026/10/28 10:00 IST – Transcript\nAda Lovelace: Morning all…\n===\nDaily Standup – 2026/10/29 10:00 IST – Transcript\nBo Chen: …"} />
          <p className="mt-bulk__hint">Put a line with just <code>===</code> between meetings. A name with a date on the first line (like Google's) dates the meeting.</p>
          <div><Button variant="secondary" onClick={() => void addPaste()} disabled={!paste.trim() || busy} iconLeft="arrowRight">Read {splitPasted(paste).length > 1 ? `${splitPasted(paste).length} meetings` : "it"}</Button></div>
        </>
      )}
      {reading && (
        <div className="mt-detect" aria-live="polite">
          <div className="mt-detect__row"><Spinner size={14} /> Reading {reading.done} of {reading.total}…</div>
        </div>
      )}
      {job && job.rows.length > 0 && !reading && (
        <Alert tone="info" actions={<Button size="sm" variant="secondary" onClick={() => setPhase("review")}>Back to the review</Button>}>
          {job.rows.length} meeting{job.rows.length === 1 ? "" : "s"} found so far. Add more, or go back to the review.
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );

  const reviewBody = job && (
    <div className="mt-bulk" data-testid="bulk-review">
      <div className="mt-bulk__summary" aria-live="polite">
        <span><b>{included.length}</b> to import</span>
        {dupes.length > 0 && <span><Icon name="checkCircle" /> {dupes.length} already here</span>}
        {undated.length > 0 && <span className="mt-bulk__warn"><Icon name="alertCircle" /> {undated.length} need{undated.length === 1 ? "s" : ""} a date</span>}
        <span className="mt-bulk__spacer" />
        <Button size="sm" variant="ghost" iconLeft="plus" onClick={() => setPhase("add")}>Add more</Button>
      </div>
      {phone ? (
        <ul className="mt-bulk__cards">
          {rows.map((r) => <RowCard key={r.id} row={r} seriesNames={seriesNames} onEdit={editRow} onDrop={dropRow} />)}
        </ul>
      ) : (
        <div className="mt-bulk__tablewrap">
          <table className="mt-bulk__table" aria-label="Meetings found">
            <thead>
              <tr>
                <th scope="col" className="mt-bulk__c-check"><span className="sr-only">Import</span></th>
                <th scope="col" className="mt-bulk__c-date">Date</th>
                <th scope="col">Meeting</th>
                <th scope="col" className="mt-bulk__c-series">Series · folder</th>
                <th scope="col" className="mt-bulk__c-status">Status · who sees it</th>
                <th scope="col" className="mt-bulk__c-x"><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => <RowLine key={r.id} row={r} seriesNames={seriesNames} onEdit={editRow} onDrop={dropRow} />)}
            </tbody>
          </table>
        </div>
      )}
      <datalist id="mt-series-names">{[...new Set([...seriesNames, ...rows.map((r) => r.series).filter(Boolean) as string[]])].map((n) => <option key={n} value={n} />)}</datalist>
      {job.problems.length > 0 && (
        <details className="mt-bulk__problems">
          <summary>{job.problems.length} file{job.problems.length === 1 ? "" : "s"} skipped</summary>
          <ul>{job.problems.map((p, i) => <li key={i}><b>{p.name}</b>: {p.error}</li>)}</ul>
        </details>
      )}
      <div className="mt-switchrow">
        <span className="mt-switchrow__text">
          <b>Don't notify anyone</b>
          Action items in past meetings still @mention people, as links, but nobody gets a bell or an email about them. Meetings older than a day are always imported quietly.
        </span>
        <Switch checked={job.quiet} onChange={(e) => void patch({ quiet: e.target.checked })} aria-label="Don't notify anyone" data-testid="bulk-quiet" />
      </div>
      <div className="mt-switchrow">
        <span className="mt-switchrow__text">
          <b>Only the people who were there, for every meeting</b>
          Otherwise 1:1s and two-person calls are for their attendees and bigger calls for the whole team, as each row says.
        </span>
        <Switch checked={job.restricted} onChange={(e) => void patch({ restricted: e.target.checked })} aria-label="Restrict to attendees" />
      </div>
      {est && included.length > 0 && (
        <p className="mt-bulk__est" data-testid="bulk-estimate">
          <Icon name="sparkle" />
          {est.ai ? (
            <span>
              AI summaries for {est.meetings} meeting{est.meetings === 1 ? "" : "s"}: about <b>${est.usd < 0.01 ? est.usd.toFixed(3) : est.usd.toFixed(2)}</b> of Meetings AI.
              {est.may_wait ? " That's more than today's AI budget, so the rest waits until it resets (tomorrow) — the import picks up by itself." : " They're written one after another, oldest first."}
            </span>
          ) : <span>{est.ai_message || "AI is off"} The meetings are imported without AI summaries.</span>}
        </p>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );

  const footer = phase === "review" && job ? (
    <>
      <Button variant="ghost" onClick={() => void discard()} disabled={busy}>Discard</Button>
      <Button onClick={() => void start()} loading={busy} disabled={busy || included.length === 0 || undated.length > 0} data-testid="bulk-start">
        {undated.length > 0 ? `Add ${undated.length} date${undated.length === 1 ? "" : "s"} first` : `Import ${included.length} meeting${included.length === 1 ? "" : "s"}`}
      </Button>
    </>
  ) : (
    <Button variant="ghost" onClick={onClose} disabled={busy}>Close</Button>
  );

  const title = "Import past meetings";
  const description = phase === "review"
    ? "Check the dates and names. Nothing is imported until you start; then it runs in the background, oldest first."
    : "Bring in your earlier calls all at once. You'll review them before anything is created.";
  const content = phase === "review" && job ? reviewBody : addBody;

  if (phone) {
    return (
      <Drawer open={open} onClose={onClose} side="bottom" title={title} description={description} footer={footer} dismissible={!busy}>
        {content}
      </Drawer>
    );
  }
  return (
    <Dialog open={open} onClose={onClose} size="xl" title={title} description={description} footer={footer} dismissible={!busy}
      glyph={<span className="mt-hub__glyph" style={{ width: 36, height: 36 }}><Icon name="history" /></span>}>
      {content}
    </Dialog>
  );
}

/* ── rows ─────────────────────────────────────────────────────────────── */

interface RowProps {
  row: BackfillRow;
  seriesNames: string[];
  onEdit: (row: BackfillRow, change: { title?: string; date?: string; series?: string | null; include?: boolean; restricted?: boolean }) => void;
  onDrop: (row: BackfillRow) => void;
}

const DATE_FROM: Record<string, string> = { title: "from the name", created: "the Doc's creation day", content: "from the text", user: "you set it" };

function Kinds({ row }: { row: BackfillRow }) {
  return (
    <span className="mt-bulk__kinds">
      {row.kinds.includes("notes") && <Badge size="sm" tone="info">Notes</Badge>}
      {row.kinds.includes("transcript") && <Badge size="sm" tone="neutral">Transcript</Badge>}
      {row.past && <span className="mt-bulk__quiet" title="Older than a day: imported without notifying anyone"><Icon name="bell" />quiet</span>}
    </span>
  );
}

/** Where it's filed (the series' folder or Other meetings). */
function FolderHint({ row }: { row: BackfillRow }) {
  return <span className="mt-bulk__sub mt-bulk__folder" data-testid="bulk-folder"><Icon name="folder" />Meetings › {row.folder}</span>;
}

/** Who sees it: the attendees (a 1:1 or two-person call starts so) or the team; one click switches. */
function Visibility({ row, onEdit, disabled }: { row: BackfillRow; onEdit: RowProps["onEdit"]; disabled: boolean }) {
  const who = row.restricted ? "Attendees" : "Team";
  return (
    <button type="button" className="mt-bulk__vis" data-restricted={row.restricted ? "" : undefined} disabled={disabled}
      onClick={() => onEdit(row, { restricted: !row.restricted })} data-testid="bulk-visibility"
      aria-label={`Who can open it: ${who}${row.restricted_from === "auto" ? " (from the number of people)" : ""}. Switch`}
      title={row.restricted ? "Only the people who were there (members). Click for the whole team." : "The whole team. Click for only the people who were there."}>
      <Icon name={row.restricted ? "lock" : "users"} />{who}
    </button>
  );
}

function Status({ row }: { row: BackfillRow }) {
  if (row.dup.status === "duplicate") {
    return <span className="mt-bulk__status mt-bulk__status--dup"><Icon name="checkCircle" />{row.dup.why === "batch" ? "Twice in this import" : "Already imported"}</span>;
  }
  if (row.dup.status === "attach") {
    return <span className="mt-bulk__status mt-bulk__status--attach" title={row.dup.title ?? undefined}><Icon name="layers" />Adds {row.kinds.includes("notes") ? "notes" : "the transcript"} to the meeting already here</span>;
  }
  if (!row.include) return <span className="mt-bulk__status">Left out</span>;
  if (row.needs_date) return <span className="mt-bulk__status mt-bulk__status--warn"><Icon name="alertCircle" />Needs a date</span>;
  return <span className="mt-bulk__status mt-bulk__status--new"><Icon name="plus" />New</span>;
}

/** A text field that saves when it loses focus (or on Enter). */
function useDraft(value: string, commit: (v: string) => void) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return {
    value: v,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setV(e.target.value),
    onBlur: () => { if (v.trim() !== value) commit(v.trim()); },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); },
  };
}

function RowLine({ row, onEdit, onDrop }: RowProps) {
  const dup = row.dup.status === "duplicate";
  const title = useDraft(row.title ?? "", (v) => { if (v) onEdit(row, { title: v }); });
  const series = useDraft(row.series ?? "", (v) => onEdit(row, { series: v || null }));
  return (
    <tr className={dup || !row.include ? "is-off" : row.needs_date ? "is-warn" : undefined} data-testid="bulk-row">
      <td className="mt-bulk__c-check">
        <Checkbox checked={row.include} disabled={dup} onChange={(e) => onEdit(row, { include: e.target.checked })} aria-label={`Import ${row.title ?? "this meeting"}`} />
      </td>
      <td className="mt-bulk__c-date">
        <Input type="date" size="sm" value={row.date ?? ""} invalid={row.needs_date} aria-label={`Date of ${row.title ?? "this meeting"}`}
          onChange={(e) => { if (e.target.value) onEdit(row, { date: e.target.value }); }} disabled={dup} data-testid="bulk-date" />
        <span className="mt-bulk__sub">{row.date ? DATE_FROM[row.date_from ?? ""] ?? "" : "Not found: add it"}{row.time ? ` · ${row.time}` : ""}</span>
      </td>
      <td>
        <Input size="sm" {...title} aria-label="Meeting name" disabled={dup} data-testid="bulk-title" />
        <span className="mt-bulk__sub mt-bulk__names" title={row.names.join("\n")}><Kinds row={row} /> {row.names.length === 1 ? row.names[0] : `${row.names.length} files`}</span>
      </td>
      <td className="mt-bulk__c-series">
        <Input size="sm" {...series} placeholder="None" list="mt-series-names" aria-label="Series" disabled={dup} data-testid="bulk-series" />
        {!dup && <FolderHint row={row} />}
      </td>
      <td className="mt-bulk__c-status">
        <Status row={row} />
        {!dup && row.include && <Visibility row={row} onEdit={onEdit} disabled={dup} />}
      </td>
      <td className="mt-bulk__c-x"><IconButton icon="x" size="sm" label={`Remove ${row.title ?? "this meeting"} from the import`} onClick={() => onDrop(row)} /></td>
    </tr>
  );
}

function RowCard({ row, onEdit, onDrop }: RowProps) {
  const dup = row.dup.status === "duplicate";
  const title = useDraft(row.title ?? "", (v) => { if (v) onEdit(row, { title: v }); });
  const series = useDraft(row.series ?? "", (v) => onEdit(row, { series: v || null }));
  return (
    <li className={`mt-bulk__card${dup || !row.include ? " is-off" : row.needs_date ? " is-warn" : ""}`} data-testid="bulk-row">
      <div className="mt-bulk__cardhead">
        <Checkbox checked={row.include} disabled={dup} onChange={(e) => onEdit(row, { include: e.target.checked })} aria-label={`Import ${row.title ?? "this meeting"}`} />
        <Status row={row} />
        <IconButton icon="x" size="sm" label="Remove from the import" onClick={() => onDrop(row)} />
      </div>
      <Input {...title} aria-label="Meeting name" disabled={dup} />
      <div className="mt-grid2">
        <Input type="date" value={row.date ?? ""} invalid={row.needs_date} aria-label="Date" disabled={dup}
          onChange={(e) => { if (e.target.value) onEdit(row, { date: e.target.value }); }} data-testid="bulk-date" />
        <Input {...series} placeholder="Series" list="mt-series-names" aria-label="Series" disabled={dup} />
      </div>
      {!dup && (
        <div className="mt-bulk__cardfoot">
          <FolderHint row={row} />
          {row.include && <Visibility row={row} onEdit={onEdit} disabled={dup} />}
        </div>
      )}
      <span className="mt-bulk__sub"><Kinds row={row} /> {row.date ? (row.date_from ? DATE_FROM[row.date_from] : "") : "No date found"} · {row.names.length === 1 ? row.names[0] : `${row.names.length} files`}</span>
    </li>
  );
}

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

export default BulkImport;
