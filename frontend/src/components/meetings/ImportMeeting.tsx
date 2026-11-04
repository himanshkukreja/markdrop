"use client";

/**
 * Import a meeting: paste it, upload files (.txt .vtt .srt .sbv .docx), or pick Google Docs (Google
 * Meet's transcript, Gemini's "Take notes for me" notes, or both) with the Google Picker. What was
 * found is previewed (the server's own parser, nothing written) before Import; notes and a transcript
 * of the same call become one meeting. A dialog on desktop, a bottom sheet on phones.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert, Button, Dialog, Drawer, Field, Icon, IconButton, Input, Select, Spinner, Switch, Tabs, Textarea, useToast,
} from "@/components/ui";
import { PHONE_QUERY, useMediaQuery } from "@/components/kit/publish-utils";
import { connectGoogleDocs } from "@/lib/api";
import {
  ACCEPT, MAX_FILE_BYTES, MEETING_TYPES, fileToSource, fmtDuration, googlePickerToken, importMeeting, previewMeeting,
  type DetectedMeeting, type Meeting, type MeetingsStatus, type SourceIn,
} from "@/lib/meetings";
import "./meetings.css";

type Tab = "paste" | "upload" | "google";

interface Picked { id: string; name: string }

export interface ImportMeetingProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  status: MeetingsStatus | null;
  onImported?: (meetings: Meeting[]) => void;
}

export function ImportMeeting({ open, onClose, workspaceId, status, onImported }: ImportMeetingProps) {
  const phone = useMediaQuery(PHONE_QUERY);
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("paste");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Array<{ file: File; source: SourceIn }>>([]);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [detected, setDetected] = useState<DetectedMeeting[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [type, setType] = useState("");
  const [restricted, setRestricted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const touched = useRef({ title: false, date: false });

  useEffect(() => {
    if (open) return;
    // Closed: start clean next time.
    setText(""); setFiles([]); setPicked([]); setDetected(null); setTitle(""); setDate(""); setType("");
    setRestricted(false); setError(null); setBusy(false); setTab("paste");
    touched.current = { title: false, date: false };
  }, [open]);

  const sources: SourceIn[] = useMemo(() => {
    if (tab === "paste") return text.trim() ? [{ name: "Pasted text", text }] : [];
    if (tab === "upload") return files.map((f) => f.source);
    return picked.map((p) => ({ name: p.name, google_file_id: p.id }));
  }, [tab, text, files, picked]);

  // What the server would make of it (paste and upload; Google Docs are read at import).
  useEffect(() => {
    if (!open || tab === "google" || sources.length === 0) { setDetected(null); return; }
    let live = true;
    setDetecting(true);
    const t = window.setTimeout(() => {
      previewMeeting(sources).then((r) => {
        if (!live) return;
        setDetected(r.meetings);
        const one = r.meetings.length === 1 ? r.meetings[0] : null;
        if (one && !touched.current.title) setTitle(one.title || "");
        if (one && !touched.current.date) setDate(one.date || localToday());
        setError(null);
      }).catch((e: Error) => { if (live) { setDetected(null); setError(e.message); } })
        .finally(() => { if (live) setDetecting(false); });
    }, 450);
    return () => { live = false; window.clearTimeout(t); };
  }, [open, tab, sources]);

  const addFiles = async (list: FileList | File[]) => {
    const next = [...files];
    for (const f of Array.from(list)) {
      if (next.length >= 6) { toast.info("Import at most 6 files at once."); break; }
      if (f.size > MAX_FILE_BYTES) { toast.error(`${f.name} is bigger than 4 MB.`); continue; }
      if (!/\.(txt|vtt|srt|sbv|docx|md)$/i.test(f.name)) { toast.error(`${f.name}: Markdrop reads .txt, .vtt, .srt, .sbv, .docx and .md files.`); continue; }
      try { next.push({ file: f, source: await fileToSource(f) }); } catch { toast.error(`Couldn't read ${f.name}.`); }
    }
    setFiles(next);
  };

  const pickGoogle = async () => {
    setError(null);
    try {
      const creds = await googlePickerToken();
      const docs = await openPicker(creds);
      if (docs.length) setPicked((p) => [...p, ...docs.filter((d) => !p.some((x) => x.id === d.id))].slice(0, 6));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't open Google Drive.");
    }
  };

  const submit = async () => {
    if (!sources.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const one = (detected?.length ?? 1) === 1;
      const r = await importMeeting({
        workspace: workspaceId, sources,
        ...(one && title.trim() ? { title: title.trim() } : {}),
        ...(one && date ? { date } : {}),
        ...(type ? { type } : {}),
        restricted,
      });
      onImported?.(r.meetings);
      onClose();
      if (r.meetings.length === 1) {
        toast.success("Meeting imported. The summary is on its way.");
        router.push(`/${r.meetings[0].slug}`);
      } else {
        toast.success(`${r.meetings.length} meetings imported.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed. Try again.");
      setBusy(false);
    }
  };

  const googleReady = !!status?.google.configured;
  const tabs = [
    { value: "paste", label: "Paste", icon: "clipboard" },
    { value: "upload", label: "Upload", icon: "upload" },
    ...(googleReady ? [{ value: "google", label: "Google Docs", icon: "google" }] : []),
  ];
  const aiOff = status && !status.ai.enabled;
  const one = detected && detected.length === 1 ? detected[0] : null;

  const body = (
    <div className="mt-import">
      <Tabs items={tabs} value={tab} onChange={(v) => { setTab(v as Tab); setError(null); }} idPrefix="mt-import" />
      {tab === "paste" && (
        <Field label="Transcript or meeting notes" htmlFor="mt-paste" hint="Google Meet's transcript, Gemini's notes (Summary · Details · Suggested next steps), Zoom or Teams captions, or “Name: words” lines.">
          <Textarea id="mt-paste" value={text} onChange={(e) => setText(e.target.value)} placeholder={"Ada Lovelace: Okay, let's get started…\nBo Chen: On the release…"} spellCheck={false} />
        </Field>
      )}
      {tab === "upload" && (
        <>
          <label className="mt-drop" data-over={over ? "" : undefined}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); void addFiles(e.dataTransfer.files); }}>
            <Icon name="upload" />
            <b>Drop files here, or choose them</b>
            <span>.txt · .vtt · .srt · .sbv · .docx — the transcript and Google's notes together make one meeting</span>
            <input ref={fileInput} type="file" multiple accept={ACCEPT} className="sr-only" aria-label="Choose files"
              onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }} />
          </label>
          {files.length > 0 && (
            <ul className="mt-files">
              {files.map((f, i) => (
                <li key={`${f.file.name}-${i}`} className="mt-file">
                  <Icon name="doc" />
                  <span className="mt-file__name">{f.file.name}</span>
                  <IconButton icon="x" label={`Remove ${f.file.name}`} size="sm" onClick={() => setFiles(files.filter((_, j) => j !== i))} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {tab === "google" && (
        <div className="mt-google">
          <p style={{ margin: 0 }}>Pick the call's Docs from your Drive:</p>
          <ul>
            <li><b>Transcript</b> — “… - Transcript”, in Meet Recordings</li>
            <li><b>Notes by Gemini</b> — Summary, Details and Suggested next steps (used as written)</li>
          </ul>
          {status?.google.connected ? (
            <Button variant="secondary" iconLeft="google" onClick={() => void pickGoogle()}>Choose from Google Drive</Button>
          ) : (
            <Button variant="secondary" iconLeft="google" onClick={() => void connectGoogleDocs(window.location.pathname).catch((e: Error) => setError(e.message))}>
              Connect Google Docs
            </Button>
          )}
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Markdrop can open only the files you pick.</span>
          {picked.length > 0 && (
            <ul className="mt-files" style={{ width: "100%" }}>
              {picked.map((p) => (
                <li key={p.id} className="mt-file">
                  <Icon name="google" />
                  <span className="mt-file__name">{p.name}</span>
                  <IconButton icon="x" label={`Remove ${p.name}`} size="sm" onClick={() => setPicked(picked.filter((x) => x.id !== p.id))} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(detecting || detected) && tab !== "google" && (
        <div className="mt-detect" aria-live="polite">
          {detecting && !detected ? (
            <div className="mt-detect__row"><Spinner size={14} /> Reading it…</div>
          ) : detected && detected.length === 0 ? null : detected?.map((m, i) => (
            <div key={i} className="mt-detect__row">
              <Icon name="checkCircle" />
              <span>
                <b>{m.title || "A meeting"}</b>
                {m.date ? ` · ${m.date}` : ""}{m.duration_s ? ` · ${fmtDuration(m.duration_s)}` : ""}
                <br />
                {[
                  m.segments ? `${m.segments} transcript lines` : null,
                  m.has_notes ? "Google's meeting notes" : null,
                  m.attendees.length ? `${m.attendees.length} ${m.attendees.length === 1 ? "person" : "people"}: ${m.attendees.slice(0, 5).join(", ")}${m.attendees.length > 5 ? "…" : ""}` : null,
                ].filter(Boolean).join(" · ")}
                {m.truncated ? " · very long: the end is cut" : ""}
              </span>
            </div>
          ))}
        </div>
      )}

      {(one || tab === "google" || (detected === null && sources.length > 0)) && (
        <div className="mt-grid2">
          <Field label="Title" htmlFor="mt-title">
            <Input id="mt-title" value={title} placeholder="From the transcript" onChange={(e) => { touched.current.title = true; setTitle(e.target.value); }} />
          </Field>
          <Field label="Date" htmlFor="mt-date">
            <Input id="mt-date" type="date" value={date} onChange={(e) => { touched.current.date = true; setDate(e.target.value); }} />
          </Field>
        </div>
      )}
      <Field label="Type" htmlFor="mt-type">
        <Select id="mt-type" value={type} onChange={(e) => setType(e.target.value)}
          options={[{ value: "", label: "Guess from the title" }, ...MEETING_TYPES.map((t) => ({ value: t, label: t }))]} />
      </Field>
      <div className="mt-switchrow">
        <span className="mt-switchrow__text">
          <b>Only the people who were there</b>
          The team sees every meeting by default. This keeps it to attendees who are members of this workspace.
        </span>
        <Switch checked={restricted} onChange={(e) => setRestricted(e.target.checked)} aria-label="Restrict to attendees" />
      </div>
      {aiOff && <Alert tone="warning">{status?.ai.message || "AI is off"} The meeting is imported without the AI summary.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button onClick={() => void submit()} loading={busy} disabled={!sources.length || busy || (tab !== "google" && detected !== null && detected.length === 0)}>
        {busy ? "Importing…" : detected && detected.length > 1 ? `Import ${detected.length} meetings` : "Import meeting"}
      </Button>
    </>
  );

  if (phone) {
    return (
      <Drawer open={open} onClose={onClose} side="bottom" title="Import a meeting" description="It becomes a page in Meetings, with an AI summary." footer={footer} dismissible={!busy}>
        {body}
      </Drawer>
    );
  }
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Import a meeting" description="It becomes a page in this workspace's Meetings folder, with an AI summary, decisions and action items." footer={footer} dismissible={!busy}
      glyph={<span className="mt-hub__glyph" style={{ width: 36, height: 36 }}><Icon name="mic" /></span>}>
      {body}
    </Dialog>
  );
}

/** Today in the person's own time zone (a call without a date in it happened today, where they are). */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── The Google Picker ─────────────────────────────────────────────────────────

declare global {
  interface Window {
    gapi?: { load: (name: string, cb: () => void) => void };
    google?: { picker?: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
}

let gapiLoad: Promise<void> | null = null;
function loadGapi(): Promise<void> {
  if (window.google?.picker) return Promise.resolve();
  return (gapiLoad ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://apis.google.com/js/api.js";
    s.async = true;
    s.onload = () => window.gapi?.load("picker", () => resolve());
    s.onerror = () => { gapiLoad = null; reject(new Error("Couldn't load the Google picker. Check your connection.")); };
    document.head.appendChild(s);
  }));
}

/** Opens the Picker on the person's Google Docs (multi-select); resolves with what they picked. */
async function openPicker(creds: { access_token: string; api_key: string; app_id: string }): Promise<Picked[]> {
  await loadGapi();
  const gp = window.google!.picker;
  return new Promise<Picked[]>((resolve) => {
    const view = new gp.DocsView(gp.ViewId.DOCUMENTS).setMimeTypes("application/vnd.google-apps.document").setMode(gp.DocsViewMode.LIST);
    const picker = new gp.PickerBuilder()
      .addView(view)
      .enableFeature(gp.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(creds.access_token)
      .setDeveloperKey(creds.api_key)
      .setAppId(creds.app_id)
      .setTitle("Pick the meeting's transcript and notes")
      .setCallback((data: { action: string; docs?: Array<{ id: string; name: string }> }) => {
        if (data.action === gp.Action.PICKED) resolve((data.docs || []).map((d) => ({ id: d.id, name: d.name })));
        else if (data.action === gp.Action.CANCEL) resolve([]);
      })
      .build();
    picker.setVisible(true);
  });
}

export default ImportMeeting;
