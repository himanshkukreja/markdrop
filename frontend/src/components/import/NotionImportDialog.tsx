"use client";

/**
 * Import from Notion (Phase A, .work/notion-import/CONTRACT.md): one dialog, three steps.
 *   choose   — the export .zip (drop or pick), where it goes (My files, or a team / General from
 *              /imports/notion/destinations, grouped by workspace), a new folder named after the export,
 *              and how to export from Notion.
 *   progress — upload % (XHR PUT to the presigned URL), then the server's phases (reading, pages N of M,
 *              content N of M) polled every 1.5 s, the page being worked on, Cancel. Closing the dialog
 *              doesn't stop it: the owner keeps it mounted, polling continues and a toast says when it's done.
 *   result   — counts, kept/updated/unchanged on a re-import, skipped and errors (collapsible), Open, Import another;
 *              or the failure / cancellation.
 * Loaded lazily by components/import (useNotionImport), so entry points don't carry it in their bundles.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Alert, Button, Dialog, Disclosure, Icon, Input, Progress, Select, Spinner, Switch, cx, useToast } from "@/components/ui";
import {
  NOTION_MAX_BYTES, cancelNotionImport, createNotionImport, folderNameFromFile, getNotionDestinations, getNotionImport,
  isActive, listNotionImports, startNotionImport, uploadNotionZip,
  type NotionDestinations, type NotionImport, type NotionPlace,
} from "@/lib/notionImport";
import { documentsChanged, workspaceChanged } from "@/lib/workspaceStore";
import "./notionImport.css";

export interface NotionImportPreset {
  /** null: My files. */
  workspace: string | null;
  /** null with a workspace: its General (company-wide) space. */
  team: string | null;
}

const POLL_MS = 1500;
const PERSONAL = "personal";
const placeKey = (p: { workspace_id: string; team_id: string | null }) => `${p.workspace_id}::${p.team_id ?? ""}`;

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** The Notion mark's shape (a square N), drawn plainly: no brand colours. */
function NotionGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8.5 16.5v-9l7 9v-9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type Step = "choose" | "progress" | "result";

export default function NotionImportDialog({ open, onClose, preset }: { open: boolean; onClose: () => void; preset?: NotionImportPreset }) {
  const toast = useToast();
  const [step, setStep] = useState<Step>("choose");
  const [dests, setDests] = useState<NotionDestinations | null>(null);
  const [destError, setDestError] = useState<string | null>(null);
  const [dest, setDest] = useState<string>("");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState(true);
  const [folderName, setFolderName] = useState("");
  const [folderTouched, setFolderTouched] = useState(false);
  const [over, setOver] = useState(false);
  // "How to export" starts open, and folds away once a file is chosen.
  const [howOpen, setHowOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [imp, setImp] = useState<NotionImport | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const folderId = useId();

  // Destinations, once per mount; and an import already running (closed earlier, or another tab) is shown again.
  useEffect(() => {
    if (!open || dests) return;
    getNotionDestinations().then(setDests, (e) => setDestError(errText(e, "Couldn't load where you can import to.")));
    if (!imp) {
      listNotionImports().then((r) => {
        const running = r.imports.find((i) => isActive(i.state) && i.state !== "uploading");
        if (running) { setImp(running); setStep("progress"); }
      }, () => {});
    }
  }, [open, dests, imp]);

  // Preselect: the preset when it's a place you can import to; else My files; else the first place.
  const places = useMemo(() => dests?.places ?? [], [dests]);
  useEffect(() => {
    if (!dests || dest) return;
    let pick = "";
    if (preset) {
      if (preset.workspace === null) pick = dests.personal ? PERSONAL : "";
      else {
        const p = places.find((x) => x.workspace_id === preset.workspace && (preset.team ? x.team_id === preset.team : x.general || x.team_id === null));
        if (p) pick = placeKey(p);
      }
    }
    if (!pick) pick = dests.personal ? PERSONAL : places[0] ? placeKey(places[0]) : "";
    setDest(pick);
  }, [dests, dest, preset, places]);

  const place: NotionPlace | null = dest && dest !== PERSONAL ? places.find((p) => placeKey(p) === dest) ?? null : null;
  const personal = dest === PERSONAL;
  const groups = useMemo(() => {
    const m = new Map<string, { name: string; places: NotionPlace[] }>();
    for (const p of places) {
      const g = m.get(p.workspace_id) ?? { name: p.workspace_name, places: [] };
      g.places.push(p);
      m.set(p.workspace_id, g);
    }
    // General first, then teams by name.
    for (const g of m.values()) g.places.sort((a, b) => Number(b.general) - Number(a.general) || a.team_name.localeCompare(b.team_name));
    return [...m.entries()];
  }, [places]);

  const pickFile = (f: File | null | undefined) => {
    setStartError(null);
    if (!f) return;
    if (!/\.zip$/i.test(f.name) && f.type !== "application/zip" && f.type !== "application/x-zip-compressed") {
      setFileError("That isn't a .zip file. Notion's export downloads as a .zip: drop it here as it is, without unzipping it.");
      return;
    }
    if (f.size > NOTION_MAX_BYTES) { setFileError(`That file is ${bytes(f.size)}. An import can be up to 2 GB: export a smaller part of your workspace.`); return; }
    setFileError(null);
    setFile(f);
    setHowOpen(false);
    if (!folderTouched) setFolderName(folderNameFromFile(f.name));
  };

  /* ── polling ── */
  const id = imp?.id;
  const state = imp?.state;
  useEffect(() => {
    if (!id || !state || state === "uploading" || !isActive(state)) return;
    let stop = false;
    const t = window.setTimeout(() => {
      getNotionImport(id).then((next) => { if (!stop) setImp(next); }, () => { if (!stop) setImp((cur) => (cur ? { ...cur } : cur)); });
    }, POLL_MS);
    return () => { stop = true; window.clearTimeout(t); };
  }, [id, state, imp]);

  // Finished: refresh the lists that show the destination, move to the result, and say so if the dialog is closed.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!imp || isActive(imp.state) || announced.current === imp.id) return;
    announced.current = imp.id;
    setStep("result");
    setCancelling(false);
    if (imp.counts.pages > 0 || imp.counts.updated > 0) {
      if (imp.destination.workspace_id) workspaceChanged(imp.destination.workspace_id);
      else documentsChanged();
    }
    if (!openRef.current) {
      const url = imp.result?.url;
      if (imp.state === "done") {
        toastRef.current.success(`Notion import finished: ${plural(imp.counts.pages, "page")}`, url ? { action: { label: "Open", onClick: () => { window.location.href = url; } }, duration: 10000 } : undefined);
      } else if (imp.state === "failed") toastRef.current.error(imp.error || "The Notion import didn't finish.");
    }
  }, [imp]);

  /* ── start ── */
  const start = async () => {
    if (!file || !dest) return;
    setBusy(true);
    setStartError(null);
    const destination = personal
      ? { workspace: null, team: null, new_folder: false, folder_name: null }
      : { workspace: place!.workspace_id, team: place!.team_id, new_folder: newFolder, folder_name: newFolder ? (folderName.trim() || "Notion import") : null };
    let created: Awaited<ReturnType<typeof createNotionImport>>;
    try {
      created = await createNotionImport({ file_name: file.name, size_bytes: file.size, destination });
    } catch (e) {
      setBusy(false);
      setStartError(errText(e, "Couldn't start the import. Try again."));
      return;
    }
    announced.current = null;
    setImp(created.import);
    setUploadPct(0);
    setStep("progress");
    setBusy(false);
    const ac = new AbortController();
    abort.current = ac;
    try {
      await uploadNotionZip(created.upload, file, (f) => setUploadPct(Math.round(f * 100)), ac.signal);
      setUploadPct(100);
      const started = await startNotionImport(created.import.id);
      setImp(started);
    } catch (e) {
      if (ac.signal.aborted) return;
      setImp((cur) => (cur ? { ...cur, state: "failed", error: errText(e, "The upload didn't go through. Try again.") } : cur));
    } finally {
      abort.current = null;
      setUploadPct(null);
    }
  };

  const cancel = async () => {
    if (!imp) return;
    setCancelling(true);
    if (abort.current) {
      abort.current.abort();
      cancelNotionImport(imp.id).catch(() => {});
      announced.current = imp.id;
      setImp(null);
      setCancelling(false);
      setStep("choose");
      return;
    }
    try { setImp(await cancelNotionImport(imp.id)); } catch (e) { setCancelling(false); toast.error(errText(e, "Couldn't cancel the import.")); }
  };

  const reset = useCallback(() => {
    setImp(null);
    setFile(null);
    setFileError(null);
    setStartError(null);
    setFolderTouched(false);
    setFolderName("");
    setHowOpen(true);
    setStep("choose");
  }, []);

  /* ── render ── */
  const glyph = <span className="ni-glyph"><NotionGlyph /></span>;
  const uploading = step === "progress" && uploadPct !== null;

  let title: React.ReactNode = "Import from Notion";
  let description: React.ReactNode = "Bring pages, sub-pages and databases from a Notion export into Markdrop.";
  let body: React.ReactNode;
  let footer: React.ReactNode;

  if (step === "choose") {
    body = (
      <div className="ni-choose" data-testid="notion-choose">
        <label
          className={cx("ni-drop", over && "ni-drop--over", file && "ni-drop--has")}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); pickFile(e.dataTransfer.files?.[0]); }}
          data-testid="notion-drop">
          <input ref={fileInput} type="file" accept=".zip,application/zip,application/x-zip-compressed" className="md-visually-hidden"
            onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ""; }} data-testid="notion-file" />
          {file ? (
            <>
              <span className="ni-drop__tile ni-drop__tile--file"><Icon name="archive" /></span>
              <span className="ni-drop__text">
                <span className="ni-drop__name">{file.name}</span>
                <span className="ni-drop__hint">{bytes(file.size)} · Notion export</span>
              </span>
              <span className="ni-drop__change">Change</span>
            </>
          ) : (
            <>
              <span className="ni-drop__tile"><Icon name="upload" /></span>
              <span className="ni-drop__text">
                <span className="ni-drop__name">Drop your Notion export here</span>
                <span className="ni-drop__hint">or <span className="ni-drop__link">choose a .zip file</span> · up to 2 GB</span>
              </span>
            </>
          )}
        </label>
        {fileError && <p className="ni-error" role="alert"><Icon name="alertCircle" /> {fileError}</p>}

        <div className="ni-field">
          <label className="ni-label" htmlFor={`${folderId}-dest`}>Import to</label>
          {destError ? <Alert tone="danger">{destError}</Alert> : (
            <Select id={`${folderId}-dest`} value={dest} disabled={!dests} onChange={(e) => setDest(e.target.value)} data-testid="notion-dest">
              {!dests && <option value="">Loading…</option>}
              {dests?.personal && <option value={PERSONAL}>My files</option>}
              {groups.map(([wsId, g]) => (
                <optgroup key={wsId} label={g.name}>
                  {g.places.map((p) => <option key={placeKey(p)} value={placeKey(p)}>{p.general ? `${p.team_name || "General"} (everyone in ${g.name})` : p.team_name}</option>)}
                </optgroup>
              ))}
            </Select>
          )}
          <p className="ni-hint">
            <Icon name="lock" />
            {personal ? "Only you can open the imported pages until you share them."
              : place?.general ? `Everyone in ${place.workspace_name} can open them, like the rest of ${place.team_name || "General"}. Nothing is made public.`
                : place ? `${place.team_name}'s members can open them, like the team's other pages. Nothing is made public.`
                  : "Imported pages get the access of where they go. Nothing is made public."}
          </p>
        </div>

        {!personal && (
          <div className="ni-field">
            <Switch checked={newFolder} onChange={(e) => setNewFolder(e.target.checked)} label="Put it in a new folder" data-testid="notion-new-folder" />
            {newFolder && (
              <Input aria-label="New folder name" value={folderName} placeholder="Notion import" maxLength={120}
                onChange={(e) => { setFolderName(e.target.value); setFolderTouched(true); }} data-testid="notion-folder-name" />
            )}
            {!newFolder && <p className="ni-hint ni-hint--plain">The pages go straight into {place?.team_name || "the team"}&apos;s Files &amp; pages.</p>}
          </div>
        )}

        <Disclosure summary="How to export from Notion" open={howOpen} onOpenChange={setHowOpen} className="ni-how">
          <ol className="ni-steps">
            <li>In Notion, open the page to import and choose <b>•••</b> › <b>Export</b>. For everything, use <b>Settings</b> › <b>Export all workspace content</b>.</li>
            <li>Set <b>Export format</b> to <b>Markdown &amp; CSV</b>, and turn on <b>Include subpages</b> and <b>Create folders for subpages</b>.</li>
            <li>Download the .zip and drop it here as it is. A large workspace arrives by email as a .zip: use that one.</li>
          </ol>
        </Disclosure>
        {startError && <Alert tone="danger">{startError}</Alert>}
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button iconLeft="download" onClick={() => void start()} disabled={!file || !dest || busy} loading={busy} data-testid="notion-start">Import</Button>
      </>
    );
  } else if (step === "progress" && imp) {
    const p = imp.progress;
    const serverPhase = imp.state === "queued" ? "queued" : p.phase;
    const stages = [
      { key: "upload", label: "Upload" },
      { key: "reading", label: "Read the export" },
      { key: "pages", label: "Create pages" },
      { key: "content", label: "Fill in content" },
    ];
    const at = uploading ? 0 : serverPhase === "queued" || serverPhase === "upload" ? 1 : Math.max(1, stages.findIndex((s) => s.key === serverPhase));
    const counted = (serverPhase === "pages" || serverPhase === "content") && p.total > 0;
    let label: string;
    let value = 0, indeterminate = false, meta: React.ReactNode = null, valueText: string | undefined;
    if (uploading) {
      label = "Uploading the export";
      value = uploadPct ?? 0;
      meta = <span>{bytes(Math.round((imp.size_bytes * value) / 100))} of {bytes(imp.size_bytes)} · {value}%</span>;
      valueText = `${value}%`;
    } else if (serverPhase === "queued" || serverPhase === "upload") {
      label = "Waiting to start"; indeterminate = true;
    } else if (serverPhase === "reading") {
      label = "Reading the export"; indeterminate = p.total === 0; value = p.total ? (p.done / p.total) * 100 : 0;
    } else {
      label = `${serverPhase === "pages" ? "Creating pages" : "Filling in content"} ${counted ? `${p.done.toLocaleString()} of ${p.total.toLocaleString()}` : ""}`.trim();
      value = counted ? (p.done / p.total) * 100 : 0; indeterminate = !counted;
      meta = counted ? <span>{Math.round(value)}%</span> : null;
      valueText = counted ? `${p.done} of ${p.total}` : undefined;
    }
    title = "Importing from Notion";
    description = <span className="ni-file-line"><Icon name="archive" /> <span>{imp.file_name}</span></span>;
    body = (
      <div className="ni-progress" data-testid="notion-progress">
        <ol className="ni-stages" aria-label="Import steps">
          {stages.map((s, i) => (
            <li key={s.key} className={cx("ni-stage", i < at && "ni-stage--done", i === at && "ni-stage--now")} aria-current={i === at ? "step" : undefined}>
              <span className="ni-stage__dot">{i < at ? <Icon name="check" /> : i === at ? <Spinner size={12} /> : i + 1}</span>
              <span className="ni-stage__label">{s.label}</span>
            </li>
          ))}
        </ol>
        <Progress label={label} value={value} indeterminate={indeterminate} meta={meta} valueText={valueText} />
        <p className="ni-current" aria-live="polite">
          {p.current && !uploading ? <><span className="ni-current__k">Now</span><span className="ni-current__v">{p.current}</span></>
            : <span className="ni-current__k">{uploading ? "Sending the file to Markdrop" : "Getting ready"}</span>}
        </p>
        <Alert tone="neutral" icon="info" className="ni-note">
          {uploading
            ? "Keep this tab open until the upload finishes. After that you can close this window: the import keeps running."
            : "You can close this window: the import keeps running, and we'll tell you when it's done. Open Import from Notion again to check on it."}
        </Alert>
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={() => void cancel()} loading={cancelling} disabled={cancelling} data-testid="notion-cancel">Cancel import</Button>
        <Button variant="secondary" onClick={onClose} data-testid="notion-hide">Close</Button>
      </>
    );
  } else if (step === "result" && imp) {
    const c = imp.counts;
    const where = imp.destination.folder_name || imp.destination.team_name || (imp.destination.kind === "personal" ? "My files" : imp.destination.workspace_name) || "Markdrop";
    if (imp.state === "done") {
      title = "Import finished";
      description = <>From <b className="ni-strong">{imp.file_name}</b> into <b className="ni-strong">{where}</b></>;
      const tiles = [
        { k: "pages", n: c.pages, label: c.pages === 1 ? "page" : "pages", icon: "doc" },
        { k: "databases", n: c.databases, label: c.databases === 1 ? "database" : "databases", icon: "table" },
        { k: "rows", n: c.rows, label: c.rows === 1 ? "row" : "rows", icon: "listTree" },
        { k: "images", n: c.images, label: c.images === 1 ? "image" : "images", icon: "image" },
        { k: "files", n: c.files, label: c.files === 1 ? "file" : "files", icon: "archive" },
      ].filter((t) => t.k === "pages" || t.n > 0);
      const again = [
        c.updated > 0 && plural(c.updated, "page") + " updated",
        c.unchanged > 0 && `${c.unchanged.toLocaleString()} unchanged`,
        c.kept_edited > 0 && `${plural(c.kept_edited, "page")} kept because ${c.kept_edited === 1 ? "it was" : "they were"} edited in Markdrop`,
      ].filter(Boolean) as string[];
      const top = imp.result?.pages ?? [];
      body = (
        <div className="ni-result" data-testid="notion-result">
          <ul className="ni-tiles">
            {tiles.map((t) => (
              <li key={t.k} className="ni-tile">
                <span className="ni-tile__icon"><Icon name={t.icon} /></span>
                <span className="ni-tile__n">{t.n.toLocaleString()}</span>
                <span className="ni-tile__label">{t.label}</span>
              </li>
            ))}
          </ul>
          {again.length > 0 && (
            <p className="ni-again"><Icon name="refresh" /><span>Imported before, so it was merged: {again.join(" · ")}.</span></p>
          )}
          {top.length > 0 && !imp.result?.folder_id && (
            <div className="ni-top">
              <div className="ni-label">In this import</div>
              <ul>{top.slice(0, 6).map((pg) => <li key={pg.slug}><a href={pg.url}><Icon name="doc" /><span>{pg.title}</span></a></li>)}</ul>
            </div>
          )}
          {(imp.skipped.length > 0 || c.skipped > 0) && (
            <Disclosure className="ni-list" summary={<span>Skipped <span className="ni-count">{c.skipped || imp.skipped.length}</span></span>}>
              <ul className="ni-rows">{imp.skipped.map((s, i) => (
                <li key={s.path + i}><span className="ni-rows__t">{s.title || s.path}</span><span className="ni-rows__r">{s.reason}</span></li>
              ))}</ul>
            </Disclosure>
          )}
          {(imp.errors.length > 0 || c.errors > 0) && (
            <Disclosure className="ni-list ni-list--err" summary={<span>Couldn&apos;t import <span className="ni-count ni-count--err">{c.errors || imp.errors.length}</span></span>}>
              <ul className="ni-rows">{imp.errors.map((s, i) => (
                <li key={s.path + i}><span className="ni-rows__t">{s.title || s.path}</span><span className="ni-rows__r">{s.error}</span></li>
              ))}</ul>
            </Disclosure>
          )}
        </div>
      );
      footer = (
        <>
          <Button variant="ghost" onClick={reset} data-testid="notion-again">Import another</Button>
          {imp.result?.url
            ? <Button iconRight="arrowRight" href={imp.result.url} onClick={onClose} data-testid="notion-open">{imp.result.folder_id ? "Open folder" : "Open"}</Button>
            : <Button onClick={onClose}>Done</Button>}
        </>
      );
    } else {
      const failed = imp.state === "failed";
      title = failed ? "The import didn't finish" : "Import cancelled";
      description = <span className="ni-file-line"><Icon name="archive" /> <span>{imp.file_name}</span></span>;
      body = (
        <div className="ni-result" data-testid={failed ? "notion-failed" : "notion-cancelled"}>
          <Alert tone={failed ? "danger" : "neutral"} title={failed ? "Something stopped the import" : undefined}>
            {failed ? (imp.error || "Something went wrong while importing. Try again.") : "The import was stopped."}
            {c.pages > 0 && ` ${plural(c.pages, "page")} ${c.pages === 1 ? "was" : "were"} created in ${where} before it stopped; importing the same export again picks up from there.`}
          </Alert>
        </div>
      );
      footer = (
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button onClick={reset} data-testid="notion-retry">{failed ? "Try again" : "Import another"}</Button>
        </>
      );
    }
  } else {
    body = <div className="ni-loading"><Spinner /></div>;
  }

  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} glyph={glyph} footer={footer} size="lg"
      className="ni-dialog" bodyClassName="ni-body">
      {body}
    </Dialog>
  );
}
