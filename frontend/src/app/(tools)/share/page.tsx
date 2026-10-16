"use client";

/**
 * /share: send files peer to peer (REVAMP_PLAN 7.16, boards Share / MobileShare 1–3).
 *
 * UI only around lib/p2p, which is used exactly as before: a lazy ShareSender created on the first
 * files (getToken + forceRelay read after mount), filesFromDrop(e.dataTransfer) called synchronously
 * in drop handlers (DropZone does the same), pagehide → stop(), a beforeunload guard while live,
 * End sharing regenerates the room id, navigator.share runs directly in the tap, and the analytics
 * events share_started / share_files_added keep their payloads.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Badge, Button, ConfirmDialog, CopyButton, Disclosure, Drawer, Icon, Input, Progress, cx, useToast,
} from "@/components/ui";
import { DropZone } from "@/components/kit/DropZone";
import { QRFrame } from "@/components/kit/QRFrame";
import { CommandBlock } from "@/components/kit/CommandBlock";
import { CLI_URL } from "@/components/shell/links";
import TransferExplainer from "@/components/share/TransferExplainer";
import CliGuide from "@/components/share/CliGuide";
import BulkGuide from "@/components/share/BulkGuide";
import Recipients from "@/components/share/Recipients";
import FileRow from "@/components/share/FileRow";
import { dotsFor } from "@/components/share/DeliveryDots";
import TransferStage, { type StagePeer } from "@/components/share/TransferStage";
import WhatWeRecord from "@/components/share/WhatWeRecord";
import { PHONE_LARGE_BYTES, deviceKindOf, plural, useActivity, usePhone, useSnapshotState } from "@/components/share/live";
import ui from "@/components/share/share.module.css";
import { generateRoomId, formatBytes, formatRate } from "@/lib/webrtc";
import { getToken } from "@/lib/api";
import { FAILURE_COPY } from "@/lib/p2p/protocol";
import { filesFromDrop } from "@/lib/p2p/dropped";
import { ShareSender, type SenderSnapshot, type RecipientView } from "@/lib/p2p/sender";
import { track } from "@/lib/track";

const EMPTY: SenderSnapshot = { status: "idle", files: [], recipients: [], failure: null, rate: 0 };

/** Render at once when anything structural changed; numbers alone wait for the ~2Hz cadence. */
function senderUrgent(a: SenderSnapshot, b: SenderSnapshot): boolean {
  if (a.status !== b.status || a.failure !== b.failure) return true;
  if (a.files.length !== b.files.length || a.recipients.length !== b.recipients.length) return true;
  for (let i = 0; i < b.files.length; i++) {
    const x = a.files[i], y = b.files[i];
    if (x.id !== y.id || x.delivered !== y.delivered || x.sending !== y.sending || x.unreadable !== y.unreadable || x.busy !== y.busy) return true;
  }
  for (let i = 0; i < b.recipients.length; i++) {
    const x = a.recipients[i], y = b.recipients[i];
    if (x.gid !== y.gid || x.state !== y.state || x.route !== y.route || x.filesDone !== y.filesDone || x.label !== y.label || x.currentName !== y.currentName) return true;
  }
  return false;
}

const isGone = (r: RecipientView) => r.state === "left" || r.state === "failed";

export default function SharePage() {
  const [roomId, setRoomId] = useState<string>(generateRoomId);
  const [snap, pushSnap, resetSnap] = useSnapshotState<SenderSnapshot>(EMPTY, senderUrgent);
  const senderRef = useRef<ShareSender | null>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const [origin, setOrigin] = useState("https://markdrop.in");
  const [canShare, setCanShare] = useState(false);
  const [emptyFolder, setEmptyFolder] = useState(false);
  const [listDragging, setListDragging] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const toast = useToast();
  const phone = usePhone();

  useEffect(() => {
    setOrigin(window.location.origin);
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);
  useEffect(() => () => senderRef.current?.stop(), []);

  // Closing the tab ends the share: say goodbye so every recipient hears it
  // at once, instead of after a liveness timeout.
  useEffect(() => {
    const bye = () => senderRef.current?.stop();
    window.addEventListener("pagehide", bye);
    return () => window.removeEventListener("pagehide", bye);
  }, []);

  const active = snap.status !== "idle" && snap.status !== "failed";

  // Leaving the page ends the share — say so before it happens.
  useEffect(() => {
    if (!active) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [active]);

  function addFiles(list: FileList | File[] | null | undefined, room: string = roomId) {
    if (!list || !list.length) return;
    const mb = Math.round(Array.from(list).reduce((n, f) => n + f.size, 0) / 1048576);
    track(senderRef.current ? "share_files_added" : "share_started", { files: list.length, mb });
    if (!senderRef.current) {
      senderRef.current = new ShareSender(room, {
        onChange: pushSnap,
        getToken,
        forceRelay: new URLSearchParams(window.location.search).get("relay") === "1",
      });
    }
    senderRef.current.addFiles(list);
  }

  /** Stop, forget, and mint a fresh link (the old one is dead now). */
  function stopAndReset() {
    senderRef.current?.stop();
    senderRef.current = null;
    resetSnap(EMPTY);
    setRoomId(generateRoomId());
  }

  const downloading = snap.recipients.filter((r) => r.state === "downloading");

  function endSharing() {
    if (downloading.length > 0) {
      setConfirmEnd(true);
      return;
    }
    stopAndReset();
    toast.info("Sharing ended. Your link no longer works.");
  }

  function confirmEndSharing() {
    setConfirmEnd(false);
    stopAndReset();
    toast.info("Sharing ended. Your link no longer works.");
  }

  /** Failed: the same files, under a new link. */
  function shareAgain() {
    const again = snap.files.map((f) => f.file);
    senderRef.current?.stop();
    senderRef.current = null;
    const id = generateRoomId();
    setRoomId(id);
    resetSnap(EMPTY);
    addFiles(again, id);
  }

  function onPicked(files: File[], info: { source: "drop" | "picker" | "folder-picker" }) {
    if (!files.length) {
      if (info.source !== "picker") setEmptyFolder(true);
      return;
    }
    setEmptyFolder(false);
    addFiles(files);
  }

  function handleListDrop(e: React.DragEvent) {
    e.preventDefault();
    setListDragging(false);
    // Collect synchronously (the DataTransfer empties after this handler), then expand any folders.
    void filesFromDrop(e.dataTransfer).then((fs) => onPicked(fs, { source: "drop" }));
  }

  // navigator.share must run inside the tap itself: nothing awaited, no dialog first.
  function shareLink() {
    navigator.share({ title: "Files on Markdrop", url: shareUrl }).catch(() => {});
  }

  const removeFile = useCallback((id: string) => senderRef.current?.removeFile(id), []);

  const shareUrl = `${origin}/share/${roomId}`;
  const prettyUrl = shareUrl.replace(/^https?:\/\//, "");
  const files = snap.files;
  const totalBytes = files.reduce((n, f) => n + f.file.size, 0);
  const here = snap.recipients.filter((r) => !isGone(r));
  const connected = here.filter((r) => r.state !== "connecting");
  const opening = here.some((r) => r.state === "connecting");

  const activity = useActivity(
    snap.recipients.map((r) => ({ id: r.gid, bytes: r.bytesDone, rate: r.rate })),
    downloading.length > 0,
  );

  const stagePeers: StagePeer[] = here.map((r) => {
    const pct = r.bytesWanted ? Math.min(1, r.bytesDone / r.bytesWanted) : 0;
    const a = activity(r.gid);
    const route = r.route === "relay" ? "relayed" : "direct";
    let state: StagePeer["state"] = "waiting";
    let caption = "Browsing the files";
    let short = "Open";
    if (r.state === "connecting") { state = "connecting"; caption = "Connecting…"; short = "…"; }
    else if (r.state === "downloading") {
      state = a.active ? "active" : "stalled";
      short = `${Math.floor(pct * 100)}%`;
      caption = a.active
        ? `${Math.floor(pct * 100)}% · ${formatRate(r.rate)} · ${route}`
        : `${Math.floor(pct * 100)}% · Waiting on the network…`;
    } else if (r.state === "done") {
      state = "done";
      short = "Done";
      caption = r.filesDone === files.length ? `Delivered, all ${r.filesDone}` : `Delivered ${r.filesDone} of ${files.length}`;
    }
    return { id: r.gid, kind: deviceKindOf(r.label), label: r.label, caption, short, route: r.route, state, progress: pct, rate: r.rate };
  });

  // Status words: the live region carries the coarse state only (it would chatter at 2Hz otherwise).
  let statusIcon = "clock";
  let statusText = "Waiting for someone to open the link";
  if (snap.status === "failed") { statusIcon = "alertCircle"; statusText = "Sharing stopped"; }
  else if (snap.status === "reconnecting") { statusIcon = "refresh"; statusText = "Reconnecting to Markdrop"; }
  else if (downloading.length > 0) { statusIcon = "zap"; statusText = `Sending to ${plural(downloading.length, "person", "people")}`; }
  else if (connected.length > 0) { statusIcon = "users"; statusText = `${plural(connected.length, "person", "people")} connected`; }
  else if (opening) { statusIcon = "link"; statusText = "Someone opened the link · connecting"; }

  const dotsByFile = useMemo(
    () => files.map((f) => dotsFor(f, snap.recipients, files.length)),
    [files, snap.recipients],
  );

  /* ── Idle ──────────────────────────────────────────────────────────────────────────────────── */
  if (snap.status === "idle") {
    return (
      <div className="mx-auto w-full min-w-0 max-w-share pb-10 pt-4 sm:pt-8">
        <section className="grid items-center gap-8 md:grid-cols-12">
          <div className="min-w-0 md:col-span-7">
            <p className="text-eyebrow text-text-muted">Peer to peer · files never uploaded</p>
            <h1 className="mt-3 text-h1 text-text sm:text-display">
              Send files <span className="text-accent-text">straight to their device</span>
            </h1>
            <p className="mt-3 max-w-[560px] text-body text-text-secondary sm:text-body-lg">
              Drop one file or a hundred photos, share the link, and they stream directly from your device to theirs, encrypted, with no copy left on any server.
            </p>
            <ul className="mt-5 hidden flex-wrap gap-2 sm:flex" aria-label="How your files travel">
              <li><Badge icon="key">Encrypted device to device</Badge></li>
              <li><Badge icon="zap">Direct when the network allows</Badge></li>
              <li><Badge icon="inbox">Files are never stored on our servers</Badge></li>
            </ul>
            <div className="mt-3 text-caption text-text-muted">
              <WhatWeRecord fromHash />
            </div>
          </div>
          <div className={cx("hidden min-w-0 rounded-2xl border border-border px-4 pb-4 pt-6 md:col-span-5 md:block", ui.well)}>
            <TransferStage mode="static" />
          </div>
        </section>

        <DropZone
          className="mt-8 min-h-[200px] rounded-2xl sm:min-h-[280px]"
          folder
          onFiles={onPicked}
          title={<><span className="sm:hidden">Choose files or photos</span><span className="hidden sm:inline">Drop files or a whole folder</span></>}
          dragTitle="Drop to start sharing"
          caption={<>
            <span className="sm:hidden">On a phone, choose Photo Library and tap Select to send many at once.</span>
            <span className="hidden sm:inline">Any type, any size. Nothing leaves your device until someone opens the link.</span>
          </>}
          actions={({ openFiles, openFolder }) => (
            <>
              <Button variant="primary" iconLeft="upload" onClick={openFiles}>Choose files</Button>
              <Button variant="secondary" iconLeft="folder" onClick={openFolder} className="[@media(hover:none)_and_(pointer:coarse)]:hidden">
                Choose a folder
              </Button>
            </>
          )}
        />
        {emptyFolder && (
          <Alert className="mt-3" tone="warning" live onDismiss={() => setEmptyFolder(false)}>
            Nothing to send in that folder — hidden files are skipped.
          </Alert>
        )}

        <div className="mt-10 grid min-w-0 gap-4">
          <BulkGuide />
          <TransferExplainer />
        </div>
        <CliGuide className="mt-4" />
      </div>
    );
  }

  /* ── Live console ──────────────────────────────────────────────────────────────────────────── */
  const failed = snap.status === "failed";
  const largeForPhones = totalBytes > PHONE_LARGE_BYTES;

  return (
    <div className={cx("mx-auto flex w-full min-w-0 max-w-share flex-col gap-4 pb-10 pt-2 sm:pt-6", active && "pb-28 sm:pb-10")}>
      {/* Title row */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-eyebrow text-text-muted">Encrypted device to device · files never stored</p>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-h2 text-text">Sharing {plural(files.length, "file")}</h1>
            {snap.status === "live" && <Badge tone="success" live>Live</Badge>}
            {snap.status === "reconnecting" && <Badge tone="warning" icon="refresh">Reconnecting</Badge>}
            {failed && <Badge tone="danger" icon="x">Stopped</Badge>}
          </div>
          <p className="text-caption text-text-muted">{formatBytes(totalBytes)} · works while this tab stays open</p>
        </div>
        <p className="flex min-w-0 items-center gap-1.5 text-caption tabular-nums text-text-muted">
          <Icon name={statusIcon} size={14} />
          <span role="status" aria-live="polite">{statusText}</span>
          {downloading.length > 0 && snap.rate > 0 && <span aria-hidden>· {formatRate(snap.rate)}</span>}
        </p>
      </div>

      {snap.status === "reconnecting" && (
        <Alert tone="warning" title="Reconnecting to Markdrop" live>
          People already connected keep downloading. New people can join once this reconnects.
        </Alert>
      )}
      {failed && snap.failure && (
        <Alert tone="danger" title={FAILURE_COPY[snap.failure].title}
          actions={<>
            <Button variant="primary" size="sm" iconLeft="refresh" onClick={shareAgain}>Share again</Button>
            <Button variant="secondary" size="sm" onClick={stopAndReset}>Start over</Button>
          </>}>
          {FAILURE_COPY[snap.failure].detail} Share again to send the same files under a new link.
        </Alert>
      )}

      {/* Link + QR + stage */}
      {active && (
        <section aria-label="Share link and live transfer" className={cx("min-w-0 overflow-hidden rounded-2xl border border-border bg-surface", ui.card)}>
          <div className="grid min-w-0 gap-5 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-8 sm:px-6 sm:py-5">
            <div className="flex min-w-0 flex-col gap-2">
              <label htmlFor="share-link" className="text-eyebrow text-text-muted">Share this link</label>
              <div className="flex min-w-0 items-center gap-2">
                <Input id="share-link" mono readOnly value={prettyUrl} iconPrefix="link" wrapClassName="min-w-0 flex-1"
                  onFocus={(e) => e.currentTarget.select()} />
                <span className="hidden shrink-0 gap-2 sm:flex">
                  <CopyButton text={shareUrl} label="Copy link" variant="primary" size="md" />
                  {canShare && <Button variant="secondary" iconLeft="share" onClick={shareLink}>Share…</Button>}
                </span>
              </div>
              <p className="text-caption text-text-muted">
                Up to 10 people at once, each choosing what to download. The link stops working when you end sharing or close this tab.
              </p>
            </div>
            <div className="ph-no-capture order-first flex justify-center sm:order-none">
              <QRFrame key={roomId} value={shareUrl} size={phone ? 160 : 152} label="Scan to open" caption="Point a phone camera at it."
                expandable layout={phone ? "stack" : "row"} />
            </div>
          </div>
          <div className={cx("border-t border-border px-4 py-3 sm:px-6", ui.well)}>
            <p className="mb-1 text-eyebrow text-text-secondary">Right now</p>
            <TransferStage mode="hub" peers={stagePeers}
              ariaLabel={here.length
                ? `${plural(here.length, "person", "people")} connected, ${downloading.length} downloading`
                : "Waiting for someone to open the link"} />
          </div>
        </section>
      )}

      {/* People | Files */}
      <div className="grid min-w-0 items-start gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <Recipients recipients={snap.recipients} totalFiles={files.length} etaReady={(id) => activity(id).etaReady} />

        <section
          aria-labelledby="share-files"
          onDragOver={active ? (e) => { e.preventDefault(); setListDragging(true); } : undefined}
          onDragLeave={active ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setListDragging(false); } : undefined}
          onDrop={active ? handleListDrop : undefined}
          className={cx("min-w-0 overflow-hidden rounded-xl border border-border bg-surface transition-colors", ui.card, listDragging && ui.dropping)}
        >
          <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border py-2 pl-4 pr-3">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <h2 id="share-files" className="text-h4 text-text">Files</h2>
              <span className="text-caption tabular-nums text-text-muted">
                {files.length} · {formatBytes(totalBytes)}
                {downloading.length > 0 && snap.rate > 0 && <> · Sending {formatRate(snap.rate)} to {plural(downloading.length, "person", "people")}</>}
              </span>
              {largeForPhones && <span className="text-caption text-warning">Large for phones</span>}
            </div>
            {active && (
              <>
                <input ref={addInputRef} type="file" multiple className="hidden" tabIndex={-1} aria-hidden
                  onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
                <Button variant="secondary" size="sm" iconLeft="plus" className="shrink-0 max-sm:h-11" onClick={() => addInputRef.current?.click()}>
                  Add files
                </Button>
              </>
            )}
          </div>
          <ul>
            {files.map((f, i) => (
              <FileRow key={f.id} id={f.id} name={f.file.name} mime={f.file.type} size={f.file.size}
                delivered={f.delivered} sending={f.sending} unreadable={f.unreadable} busy={f.busy}
                dots={dotsByFile[i]} removable={active} onRemove={removeFile} />
            ))}
          </ul>
          {active && (
            <p className="border-t border-border px-4 py-2.5 text-caption text-text-muted" aria-live="polite">
              {listDragging ? "Drop to add these to the share" : "Forgot something? Drop more files here or use Add files. Everyone connected sees them right away."}
            </p>
          )}
          {emptyFolder && (
            <Alert className="m-3" tone="warning" live onDismiss={() => setEmptyFolder(false)}>
              Nothing to send in that folder — hidden files are skipped.
            </Alert>
          )}
        </section>
      </div>

      {active && (
        <Disclosure summary="Recipient prefers the terminal?" className={cx("rounded-xl border border-border bg-surface px-4 py-1", ui.card)}>
          <div className="space-y-2 pb-3 pt-1">
            <CommandBlock command={`markdrop get ${roomId}`} />
            <p className="text-caption text-text-muted">
              They need the Markdrop CLI.{" "}
              <a href={CLI_URL} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent-text underline-offset-2 hover:underline">
                How to install it
              </a>
            </p>
          </div>
        </Disclosure>
      )}

      {/* Footer */}
      {active && (
        <div className="mt-4 flex flex-col gap-4 sm:mt-0 sm:flex-row sm:items-center">
          <Alert tone="neutral" icon="info" className="min-w-0 flex-1">
            Keep this tab open — files are sent from your device, so closing it ends the share.
          </Alert>
          <Button variant="ghost" iconLeft="x" className="text-danger hover:text-danger max-sm:mt-4 max-sm:h-11 max-sm:w-full" onClick={endSharing}>
            End sharing
          </Button>
        </div>
      )}
      <div className="text-caption text-text-muted">
        Files are never stored on our servers. <WhatWeRecord placement="top-start" />
      </div>

      {/* Phone dock: Copy and Share stay in reach while scrolling */}
      {active && (
        <div className={cx(ui.dock, "flex gap-2 sm:hidden")}>
          <CopyButton text={shareUrl} label="Copy link" variant={canShare ? "secondary" : "primary"} size="md" block className="h-11 flex-1" />
          {canShare && <Button variant="primary" size="lg" iconLeft="share" className="flex-1" onClick={shareLink}>Share…</Button>}
        </div>
      )}

      {/* End sharing mid-transfer */}
      {phone ? (
        <Drawer side="bottom" open={confirmEnd} onClose={() => setConfirmEnd(false)} title="End sharing?"
          description={`${downloading.length === 1 ? "1 person is" : `${downloading.length} people are`} still downloading. They keep what's already saved; the link stops working.`}
          footer={<div className="flex w-full flex-col gap-2">
            <Button variant="danger" size="lg" block onClick={confirmEndSharing}>End sharing</Button>
            <Button variant="secondary" size="lg" block onClick={() => setConfirmEnd(false)}>Keep sharing</Button>
          </div>}>
          <ul className="overflow-hidden rounded-xl border border-border">
            {downloading.map((r) => {
              const pct = r.bytesWanted ? Math.min(100, (r.bytesDone / r.bytesWanted) * 100) : 0;
              return (
                <li key={r.gid} className="border-t border-border px-3 py-2.5 first:border-t-0">
                  <Progress size="sm" value={pct} label={r.label} meta={`${Math.floor(pct)}%`} />
                </li>
              );
            })}
          </ul>
        </Drawer>
      ) : (
        <ConfirmDialog open={confirmEnd} onClose={() => setConfirmEnd(false)} onConfirm={confirmEndSharing}
          title="End sharing?"
          body={`${downloading.length === 1 ? "1 person is" : `${downloading.length} people are`} still downloading. They keep what's already saved; the link stops working.`}
          confirmLabel="End sharing" cancelLabel="Keep sharing" />
      )}
    </div>
  );
}
