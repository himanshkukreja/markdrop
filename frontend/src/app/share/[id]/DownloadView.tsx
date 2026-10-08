"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FileIcon, { RouteBadge, isImage } from "@/components/share/FileIcon";
import { formatBytes, formatRate } from "@/lib/webrtc";
import { FAILURE_COPY } from "@/lib/p2p/protocol";
import { ShareReceiver, type ReceivedFile, type ReceiverSnapshot } from "@/lib/p2p/receiver";
import { track } from "@/lib/track";

const INITIAL: ReceiverSnapshot = {
  status: "connecting", files: [], failure: null, route: null, rate: 0, protocol: 2, slow: false,
};

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
  const [snap, setSnap] = useState<ReceiverSnapshot>(INITIAL);
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
      onChange: setSnap,
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
  }, [roomId, markSaved]);

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

  // ── Full-screen states (nothing to show yet) ──────────────────────────────
  if (!files.length) {
    if (snap.status === "failed" && snap.failure) {
      return <Centered><FailureCard reason={snap.failure} /></Centered>;
    }
    return (
      <Centered>
        <div className="flex flex-col items-center gap-5 py-12">
          <div className="relative flex items-center justify-center">
            <span className="absolute w-16 h-16 rounded-full bg-blue-500/20 animate-ping" />
            <span className="absolute w-12 h-12 rounded-full bg-blue-500/30 animate-ping [animation-delay:150ms]" />
            <div className="relative z-10 w-10 h-10 rounded-full bg-blue-500 flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.828 14.828a4 4 0 015.656 0l4-4a4 4 0 01-5.656-5.656l-1.102 1.101" />
              </svg>
            </div>
          </div>
          <div className="text-center max-w-xs">
            <p className="text-base font-semibold text-gray-800 dark:text-gray-100">
              {snap.status === "sender-away" ? "Waiting for the sender to reconnect…" : "Connecting to sender…"}
            </p>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {snap.slow
                ? "This network is making it hard — trying a relayed route. This can take up to half a minute."
                : "Setting up an encrypted connection between your devices"}
            </p>
          </div>
        </div>
      </Centered>
    );
  }

  // ── File list ─────────────────────────────────────────────────────────────
  const allDone = done.length === files.length;
  const ended = snap.status === "failed";

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-xl px-1 sm:px-4 py-6 sm:py-10 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-50">
              {allDone ? "All received" : files.length === 1 ? "You received a file" : `You received ${files.length} files`}
            </h1>
            <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
              {formatBytes(total)} · end-to-end encrypted, straight from the sender&apos;s device
            </p>
          </div>
          {!ended && <RouteBadge route={snap.route} />}
        </div>

        {ended && snap.failure && (
          <div className={`px-4 py-3 rounded-xl border ${allDone
            ? "bg-gray-50 dark:bg-gray-900/50 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300"
            : "bg-amber-50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-800/40 text-amber-800 dark:text-amber-300"}`}>
            <p className="text-sm font-semibold">{allDone ? "The sender has closed Markdrop" : FAILURE_COPY[snap.failure].title}</p>
            <p className="text-xs mt-0.5 opacity-90">
              {allDone ? "Everything arrived — your files are below." : FAILURE_COPY[snap.failure].detail}
            </p>
          </div>
        )}

        {/* Primary actions */}
        <div className="space-y-2">
          {!ended && available.length > 0 && working.length === 0 && (
            <button onClick={() => fetchFiles(available.map((f) => f.id))}
              className="w-full py-3 flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-semibold rounded-xl transition-colors shadow-sm shadow-blue-500/20">
              <DownloadGlyph />
              {available.length === files.length
                ? (files.length === 1 ? `Download (${formatBytes(total)})` : `Download all ${files.length} (${formatBytes(total)})`)
                : `Download remaining ${available.length}`}
            </button>
          )}

          {working.length > 0 && (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700/70 bg-gray-50 dark:bg-gray-900/50 px-4 py-3 space-y-2">
              <div className="flex justify-between text-xs tabular-nums">
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {batchTotal === 1 ? "Receiving" : `Receiving ${Math.min(batchDone + 1, batchTotal)} of ${batchTotal}`}
                </span>
                <span className="text-gray-500 dark:text-gray-400">
                  {formatBytes(busyGot)} / {formatBytes(busyBytes)}{snap.rate > 0 && <> · {formatRate(snap.rate)}</>}
                </span>
              </div>
              <div className="h-2 rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden">
                <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-sky-400 transition-[width] duration-200"
                  style={{ width: `${busyBytes ? (busyGot / busyBytes) * 100 : 0}%` }} />
              </div>
            </div>
          )}

          {ios && canShare && unsaved.length > 0 && (
            <button onClick={() => void shareFiles(unsaved)}
              className="w-full py-3 flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-xl transition-colors">
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 3v12m0-12L8 7m4-4l4 4M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6" />
              </svg>
              {unsaved.every((f) => isImage(f.name, f.mime))
                ? `Save ${unsaved.length === 1 ? "photo" : `${unsaved.length} photos`} to your phone`
                : `Save ${unsaved.length === 1 ? "file" : `${unsaved.length} files`} to your phone`}
            </button>
          )}
          {shareError && <p className="text-xs text-amber-600 dark:text-amber-400">{shareError}</p>}
          {!ios && !ended && files.length > 1 && (available.length > 0 || working.length > 0) && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-blue-500/5 ring-1 ring-blue-500/15 text-[11px] leading-relaxed text-gray-600 dark:text-gray-400">
              <svg className="w-3.5 h-3.5 mt-px shrink-0 text-blue-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" />
              </svg>
              <span>
                Each file saves to your Downloads as it arrives. If your browser asks to{" "}
                <strong className="font-semibold text-gray-800 dark:text-gray-200">download multiple files</strong>, choose{" "}
                <strong className="font-semibold text-gray-800 dark:text-gray-200">Allow</strong>
                {available.length > 1 && <> — or use <span className="inline-block align-[-2px]"><MiniDownload /></span> to take just the ones you want</>}.
              </span>
            </div>
          )}
          {ios && !working.length && available.length > 1 && done.length === 0 && (
            <p className="text-xs text-center text-gray-500 dark:text-gray-400">
              Want only some? Tap <span className="inline-block align-[-2px]"><MiniDownload /></span> next to each one.
            </p>
          )}
          {ios && !working.length && available.length > 0 && done.length === 0 && (
            <p className="text-xs text-center text-gray-500 dark:text-gray-400">
              Once they arrive, one tap saves them to Photos or Files.
            </p>
          )}
        </div>

        {/* Files */}
        <ul className="rounded-2xl border border-gray-200 dark:border-gray-700/70 bg-white/70 dark:bg-gray-900/40 divide-y divide-gray-200 dark:divide-gray-800 overflow-hidden">
          {files.map((f) => (
            <ReceiverRow key={f.id} f={f} saved={saved.has(f.id)} ended={ended}
              onFetch={() => fetchFiles([f.id])} onSave={() => saveOne(f)} />
          ))}
        </ul>

        <p className="flex items-center justify-center gap-1.5 text-center text-xs text-gray-400 dark:text-gray-500">
          <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="4" y="10" width="16" height="11" rx="2.5" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
          No file is stored on Markdrop&apos;s servers
        </p>
      </div>
    </div>
  );
}

function ReceiverRow({ f, saved, ended, onFetch, onSave }: {
  f: ReceivedFile; saved: boolean; ended: boolean; onFetch: () => void; onSave: () => void;
}) {
  const thumb = useMemo(
    () => (f.blob && isImage(f.name, f.mime) ? URL.createObjectURL(f.blob) : null),
    [f.blob, f.name, f.mime],
  );
  useEffect(() => () => { if (thumb) URL.revokeObjectURL(thumb); }, [thumb]);
  const pct = f.size ? Math.min(100, Math.round((f.received / f.size) * 100)) : 100;

  return (
    <li className="flex items-center gap-3 px-3 sm:px-4 py-2.5">
      <div className="w-11 h-11 rounded-lg bg-gray-100 dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700 flex items-center justify-center shrink-0 overflow-hidden">
        {thumb
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={thumb} alt="" className="w-full h-full object-cover" />
          : <FileIcon name={f.name} mime={f.mime} />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-gray-900 dark:text-gray-100 truncate">{f.name}</p>
        {f.status === "receiving" ? (
          <div className="mt-1.5 h-1 rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden">
            <div className="h-full bg-blue-500 transition-[width] duration-200" style={{ width: `${pct}%` }} />
          </div>
        ) : (
          <p className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
            {formatBytes(f.size)}
            {f.status === "failed" && <span className="text-amber-600 dark:text-amber-400"> · interrupted</span>}
          </p>
        )}
      </div>
      <div className="shrink-0">
        {f.status === "receiving" && <span className="text-xs tabular-nums text-blue-600 dark:text-blue-300">{pct}%</span>}
        {f.status === "requested" && <span className="text-xs text-gray-500 dark:text-gray-400">Queued</span>}
        {(f.status === "available" || f.status === "failed") && !ended && (
          <button onClick={onFetch} aria-label={`Download ${f.name}`}
            className="p-2 rounded-lg text-blue-600 dark:text-blue-300 hover:bg-blue-500/10 transition-colors">
            <DownloadGlyph />
          </button>
        )}
        {f.status === "done" && (
          <button onClick={onSave}
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              saved
                ? "text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                : "text-blue-600 dark:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20"
            }`}>
            {saved
              ? <><svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 13l4 4L19 7" /></svg>Saved</>
              : "Save"}
          </button>
        )}
      </div>
    </li>
  );
}

function MiniDownload() {
  return (
    <svg className="w-3.5 h-3.5 text-blue-500" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24" aria-label="download">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
    </svg>
  );
}

function DownloadGlyph() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
    </svg>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 min-h-0 px-4 py-6">
      <div className="w-full max-w-lg">{children}</div>
    </div>
  );
}

function FailureCard({ reason }: { reason: keyof typeof FAILURE_COPY }) {
  const copy = FAILURE_COPY[reason];
  return (
    <div className="flex flex-col items-center gap-4 py-10 text-center">
      <div className="w-14 h-14 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
        <svg className="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m1-5.657l4-4a4 4 0 015.656 5.656l-4 4a4 4 0 01-5.656 0" />
          <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </div>
      <div>
        <p className="text-base font-semibold text-gray-800 dark:text-gray-100">{copy.title}</p>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 max-w-sm">{copy.detail}</p>
      </div>
      <div className="flex gap-2">
        {(reason === "ice" || reason === "signalling" || reason === "room-busy" || reason === "room-full") && (
          <button onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
            Try again
          </button>
        )}
        <a href="/share" className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors">
          Send your own files
        </a>
      </div>
    </div>
  );
}
