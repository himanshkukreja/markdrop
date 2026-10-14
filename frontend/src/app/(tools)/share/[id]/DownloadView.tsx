"use client";

/**
 * /share/[id]: receive files (REVAMP_PLAN 7.17, boards Share recipient / MobileShare 4–7).
 *
 * UI only around ShareReceiver, used exactly as before: autoSave / batchIds refs, every file saved
 * the moment it lands (desktop) or collected for one share-sheet tap (iOS, navigator.share called
 * directly in the tap with nothing awaited before it), object URLs revoked, and the share_download
 * event unchanged. "Try again" builds a fresh ShareReceiver through the same public API (start()
 * can't be re-run on a stopped instance), so no page reload is needed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Icon, Progress, Skeleton, VisuallyHidden, cx, isImage } from "@/components/ui";
import TransferStage from "@/components/share/TransferStage";
import ReceivedFileRow from "@/components/share/ReceivedFileRow";
import WhatWeRecord from "@/components/share/WhatWeRecord";
import { PHONE_LARGE_BYTES, etaText, plural, useActivity, useSnapshotState } from "@/components/share/live";
import ui from "@/components/share/share.module.css";
import { formatBytes, formatRate } from "@/lib/webrtc";
import { FAILURE_COPY, type FailureReason } from "@/lib/p2p/protocol";
import { ShareReceiver, type ReceivedFile, type ReceiverSnapshot } from "@/lib/p2p/receiver";
import { track } from "@/lib/track";

const INITIAL: ReceiverSnapshot = {
  status: "connecting", files: [], failure: null, route: null, rate: 0, protocol: 2, slow: false,
};

/** Failures where opening the link again can help. */
const RETRYABLE: FailureReason[] = ["ice", "signalling", "room-busy", "room-full", "no-host", "sender-left"];

function receiverUrgent(a: ReceiverSnapshot, b: ReceiverSnapshot): boolean {
  if (a.status !== b.status || a.failure !== b.failure || a.route !== b.route || a.slow !== b.slow) return true;
  if (a.files.length !== b.files.length) return true;
  for (let i = 0; i < b.files.length; i++) if (a.files[i].status !== b.files[i].status || a.files[i].id !== b.files[i].id) return true;
  return false;
}

/**
 * iOS can't put a downloaded image into Photos — only the share sheet's
 * "Save Image" does that — and it handles a burst of programmatic downloads
 * badly. So on iOS files collect in the page and are saved through the share
 * sheet in one tap; everywhere else each file downloads the moment it lands.
 */
function useIsIOS() {
  const [ios, setIos] = useState(false);
  useEffect(() => {
    const ua = navigator.userAgent;
    setIos(/iP(hone|od|ad)/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
  }, []);
  return ios;
}

function toFile(f: ReceivedFile): File | null {
  return f.blob ? new File([f.blob], f.name, { type: f.mime }) : null;
}

function downloadBlob(f: ReceivedFile) {
  if (!f.blob) return;
  const url = URL.createObjectURL(f.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = f.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export default function DownloadView({ roomId }: { roomId: string }) {
  const [attempt, setAttempt] = useState(0);
  const [snap, pushSnap, resetSnap] = useSnapshotState<ReceiverSnapshot>(INITIAL, receiverUrgent);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [shareError, setShareError] = useState("");
  const receiverRef = useRef<ShareReceiver | null>(null);
  /** Files the user asked for while not on iOS — save each as it lands. */
  const autoSave = useRef<Set<string>>(new Set());
  const batchIds = useRef<Set<string>>(new Set());
  const ios = useIsIOS();
  const iosRef = useRef(ios);
  iosRef.current = ios;

  const markSaved = useCallback((ids: string[]) => {
    setSaved((prev) => new Set([...prev, ...ids]));
  }, []);

  useEffect(() => {
    const r = new ShareReceiver(roomId, {
      onChange: pushSnap,
      onFileReady: (f) => {
        if (!iosRef.current && autoSave.current.has(f.id)) {
          downloadBlob(f);
          markSaved([f.id]);
        }
      },
      forceRelay: new URLSearchParams(window.location.search).get("relay") === "1",
    });
    receiverRef.current = r;
    r.start();
    return () => r.stop();
  }, [roomId, markSaved, pushSnap, attempt]);

  function tryAgain() {
    autoSave.current = new Set();
    batchIds.current = new Set();
    setSaved(new Set());
    setShareError("");
    resetSnap(INITIAL);
    setAttempt((n) => n + 1);
  }

  const files = snap.files;
  const total = files.reduce((n, f) => n + f.size, 0);
  const available = files.filter((f) => f.status === "available" || f.status === "failed");
  const working = files.filter((f) => f.status === "requested" || f.status === "receiving");
  const done = files.filter((f) => f.status === "done");
  const unsaved = done.filter((f) => !saved.has(f.id));
  const busyBytes = working.reduce((n, f) => n + f.size, 0);
  const busyGot = working.reduce((n, f) => n + f.received, 0);
  // The current batch: what's in flight plus what finished since it started.
  const batchTotal = working.length + done.filter((f) => batchIds.current.has(f.id)).length;
  const batchDone = batchTotal - working.length;
  const canShare = typeof navigator !== "undefined" && "share" in navigator;

  const activity = useActivity([{ id: "batch", bytes: busyGot, rate: snap.rate }], working.length > 0);
  const act = activity("batch");

  function fetchFiles(ids: string[]) {
    track("share_download", { files: ids.length, of: files.length });
    if (!working.length) batchIds.current = new Set();
    for (const id of ids) {
      autoSave.current.add(id);
      batchIds.current.add(id);
    }
    receiverRef.current?.request(ids);
  }

  async function shareFiles(list: ReceivedFile[]) {
    setShareError("");
    const asFiles = list.map(toFile).filter((f): f is File => !!f);
    if (!asFiles.length) return;
    try {
      if (navigator.canShare && !navigator.canShare({ files: asFiles })) throw new Error("unsupported");
      await navigator.share({ files: asFiles });
      markSaved(list.map((f) => f.id));
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return; // user closed the sheet
      if (asFiles.length > 1) {
        setShareError("Couldn't open the share sheet for all of them at once — save them one at a time below.");
      } else {
        list.forEach(downloadBlob);
        markSaved(list.map((f) => f.id));
      }
    }
  }

  function saveOne(f: ReceivedFile) {
    if (ios && canShare) void shareFiles([f]);
    else {
      downloadBlob(f);
      markSaved([f.id]);
    }
  }

  // Rows get stable callbacks so React.memo can skip the ones whose numbers didn't move.
  const filesRef = useRef(files);
  filesRef.current = files;
  const fetchRef = useRef(fetchFiles);
  fetchRef.current = fetchFiles;
  const saveRef = useRef(saveOne);
  saveRef.current = saveOne;
  const onFetch = useCallback((id: string) => fetchRef.current([id]), []);
  const onSave = useCallback((id: string) => {
    const f = filesRef.current.find((x) => x.id === id);
    if (f) saveRef.current(f);
  }, []);

  const footer = (
    <footer className="mt-auto flex items-start gap-2.5 border-t border-border pt-4">
      <Icon name="key" size={16} className="mt-0.5 shrink-0 text-accent-text" />
      <div className="text-caption text-text-muted">
        Files come straight from the sender&apos;s device and are never stored on our servers.{" "}
        <WhatWeRecord placement="top-start" />
      </div>
    </footer>
  );

  /* ── Nothing to show yet: connecting, sender away, failed early ─────────────────────────────── */
  if (!files.length) {
    const failure = snap.status === "failed" ? snap.failure : null;
    const away = snap.status === "sender-away";
    const title = failure ? FAILURE_COPY[failure].title : away ? "Waiting for the sender to reconnect" : "Connecting to the sender";
    return (
      <div className="mx-auto flex w-full min-w-0 max-w-[640px] flex-1 flex-col gap-5 pb-6 pt-2 sm:pt-6">
        <TransferStage mode="pair" state={failure ? "failed" : "connecting"} route={null}
          pending={failure ? undefined : away ? "Waiting for the sender…" : "Finding a route…"}
          ariaLabel={failure ? "Their device and this device: not connected" : "Their device and this device: connecting"} />
        <div className="flex flex-col gap-1.5">
          <h1 className="text-h1 text-text">{title}</h1>
          <VisuallyHidden role="status" aria-live="polite">{title}</VisuallyHidden>
          <p className="text-body text-text-secondary">
            {failure
              ? FAILURE_COPY[failure].detail
              : away
                ? "Their tab lost its connection. If they're back within a minute, this picks up on its own."
                : "Setting up an encrypted connection between your devices."}
          </p>
        </div>

        {failure ? (
          <div className="flex flex-wrap gap-2">
            {RETRYABLE.includes(failure) && <Button variant="primary" iconLeft="refresh" onClick={tryAgain}>Try again</Button>}
            <Button variant={RETRYABLE.includes(failure) ? "ghost" : "primary"} href="/share">Send your own files</Button>
          </div>
        ) : (
          <>
            <Progress size="sm" indeterminate label={away ? "Waiting" : "Connecting"} />
            {snap.slow && !away && (
              <Alert tone="info" live>This network is making it hard. This can take up to half a minute.</Alert>
            )}
            <section aria-label="Files" aria-busy="true" className={cx("overflow-hidden rounded-xl border border-border bg-surface", ui.card)}>
              {[["62%", "28%"], ["48%", "22%"], ["70%", "30%"]].map(([a, b], i) => (
                <div key={i} className="grid grid-cols-[48px_minmax(0,1fr)] items-center gap-3 border-b border-border px-3.5 py-3">
                  <Skeleton variant="rect" width={48} height={48} />
                  <div className="flex flex-col gap-2">
                    <Skeleton width={a} height={12} />
                    <Skeleton width={b} height={10} />
                  </div>
                </div>
              ))}
              <p className="px-3.5 py-3 text-caption text-text-secondary">The file list appears once your devices are connected.</p>
            </section>
            <div className="text-caption text-text-muted">
              <WhatWeRecord label="What is this?" />{" "}
              Files come straight from the sender&apos;s device while their Markdrop tab is open.
            </div>
          </>
        )}
        {footer}
      </div>
    );
  }

  /* ── File list ──────────────────────────────────────────────────────────────────────────────── */
  const allDone = done.length === files.length;
  const ended = snap.status === "failed";
  const one = files.length === 1;
  const allSaved = allDone && unsaved.length === 0;

  let h1: string;
  if (working.length) h1 = batchTotal === 1 ? "Receiving a file" : `Receiving ${Math.min(batchDone + 1, batchTotal)} of ${batchTotal}`;
  else if (allDone) h1 = one ? (allSaved && !ios ? "File saved" : "File received") : (allSaved && !ios ? `All ${files.length} saved` : `All ${files.length} received`);
  else if (done.length) h1 = `${done.length} of ${files.length} received`;
  else h1 = one ? `A file is ready: ${files[0].name}` : `${files.length} files are ready`;

  const pct = busyBytes ? (busyGot / busyBytes) * 100 : 0;
  const eta = act.etaReady && snap.rate > 0 ? etaText((busyBytes - busyGot) / snap.rate) : "";
  const batchText = [`${formatBytes(busyGot)} of ${formatBytes(busyBytes)}`, snap.rate > 0 ? formatRate(snap.rate) : "", eta].filter(Boolean).join(" · ");
  const stageState = ended ? (allDone ? "done" : "failed") : working.length ? (act.active ? "active" : "stalled") : allDone ? "done" : "waiting";

  const downloadLabel = available.length === files.length
    ? (one ? `Download (${formatBytes(total)})` : `Download all ${files.length} (${formatBytes(total)})`)
    : `Download remaining ${available.length}`;
  const showDownload = !ended && available.length > 0 && working.length === 0;
  const showIosSave = ios && canShare && unsaved.length > 0;
  const iosSaveLabel = unsaved.every((f) => isImage(f.name, f.mime))
    ? `Save ${unsaved.length === 1 ? "photo" : `${unsaved.length} photos`} to your phone`
    : `Save ${unsaved.length === 1 ? "file" : `${unsaved.length} files`} to your phone`;

  const batchProgress = (
    <Progress label={batchTotal === 1 ? "Receiving" : `Receiving ${Math.min(batchDone + 1, batchTotal)} of ${batchTotal}`}
      value={pct} showValue valueText={batchText} />
  );
  const dockContent = working.length > 0
    ? <div className="flex flex-col gap-1">{batchProgress}<span className="text-caption tabular-nums text-text-muted" aria-hidden>{batchText}</span></div>
    : showIosSave
      ? <Button variant="primary" size="lg" block iconLeft="share" onClick={() => void shareFiles(unsaved)}>{iosSaveLabel}</Button>
      : showDownload
        ? <Button variant="primary" size="lg" block iconLeft="download" onClick={() => fetchFiles(available.map((f) => f.id))}>{downloadLabel}</Button>
        : null;

  return (
    <div className={cx("mx-auto flex w-full min-w-0 max-w-[640px] flex-1 flex-col gap-5 pt-2 sm:pb-6 sm:pt-6", dockContent ? "pb-32" : "pb-6")}>
      <TransferStage mode="pair" state={stageState} route={ended ? null : snap.route}
        progress={working.length ? pct / 100 : allDone ? 1 : 0} rate={snap.rate}
        dropKey={allDone ? `done-${attempt}` : null}
        ariaLabel={`Their device to this device${snap.route ? `, ${snap.route === "relay" ? "relayed" : "direct"}` : ""}`} />

      <div className="flex flex-col gap-1.5">
        <h1 className="break-words text-h1 text-text">{h1}</h1>
        <VisuallyHidden role="status" aria-live="polite">{h1}</VisuallyHidden>
        <p className="text-body text-text-secondary">{plural(files.length, "file")} · {formatBytes(total)}</p>
      </div>

      {ended && snap.failure && (
        allDone ? (
          <Alert tone="neutral" title="The sender has closed Markdrop">Everything arrived — your files are below.</Alert>
        ) : (
          <Alert tone="warning" title={FAILURE_COPY[snap.failure].title}>{FAILURE_COPY[snap.failure].detail}</Alert>
        )
      )}

      {ios && total > PHONE_LARGE_BYTES && !allDone && (
        <Alert tone="warning">This is a lot for an iPhone to hold at once — download a few at a time.</Alert>
      )}

      {/* Primary action / batch progress: inline from 640px, docked at the bottom on phones */}
      {dockContent && (
        <div className={cx("hidden sm:block", working.length > 0 && cx("rounded-xl border border-border bg-surface p-4", ui.card))}>
          {dockContent}
        </div>
      )}
      {showIosSave && working.length > 0 && (
        <Button variant="primary" size="lg" block iconLeft="share" onClick={() => void shareFiles(unsaved)}>{iosSaveLabel}</Button>
      )}
      {shareError && <Alert tone="warning" live>{shareError}</Alert>}

      {!ios && !ended && files.length > 1 && (available.length > 0 || working.length > 0) && (
        <Alert tone="info">
          Each file saves to your Downloads as it arrives. If your browser asks to download multiple files, choose Allow.
          {available.length > 1 && " Or use the download button next to a file to take just the ones you want."}
        </Alert>
      )}
      {ios && !working.length && available.length > 0 && done.length === 0 && (
        <p className="text-center text-caption text-text-secondary">
          {available.length > 1 && "Want only some? Tap the download button next to each one. "}
          Once they arrive, one tap saves them to Photos or Files.
        </p>
      )}

      <section aria-label="Files" className={cx("overflow-hidden rounded-xl border border-border bg-surface", ui.card)}>
        <ul>
          {files.map((f) => (
            <ReceivedFileRow key={f.id} id={f.id} name={f.name} mime={f.mime} size={f.size} status={f.status}
              received={f.received} blob={f.blob} saved={saved.has(f.id)} ended={ended}
              savedWhere={ios ? "saved" : "saved to Downloads"} onFetch={onFetch} onSave={onSave} />
          ))}
        </ul>
      </section>

      {footer}

      {dockContent && <div className={cx(ui.dock, "sm:hidden")}>{dockContent}</div>}
    </div>
  );
}
