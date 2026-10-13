"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import CopyButton from "@/components/CopyButton";
import AmbientBackground from "@/components/AmbientBackground";
import TransferExplainer from "@/components/share/TransferExplainer";
import CliGuide from "@/components/share/CliGuide";
import BulkGuide from "@/components/share/BulkGuide";
import FileIcon from "@/components/share/FileIcon";
import Recipients from "@/components/share/Recipients";
import { generateRoomId, formatBytes, formatRate } from "@/lib/webrtc";
import { getToken } from "@/lib/api";
import { FAILURE_COPY } from "@/lib/p2p/protocol";
import { filesFromDrop } from "@/lib/p2p/dropped";
import { ShareSender, type SenderSnapshot, type SenderFileView } from "@/lib/p2p/sender";
import { track } from "@/lib/track";

const EMPTY: SenderSnapshot = { status: "idle", files: [], recipients: [], failure: null, rate: 0 };

const TRUST = [
  { label: "End-to-end encrypted", d: "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" },
  { label: "Device to device", d: "M13 10V3L4 14h7v7l9-11h-7z" },
  { label: "Zero server storage", d: "M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" },
  { label: "Many files at once", isNew: true, d: "M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" },
];

export default function SharePage() {
  const [roomId, setRoomId] = useState<string>(generateRoomId);
  const [snap, setSnap] = useState<SenderSnapshot>(EMPTY);
  const [dragging, setDragging] = useState(false);
  const [listDragging, setListDragging] = useState(false);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [showCli, setShowCli] = useState(false);
  const senderRef = useRef<ShareSender | null>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const [origin, setOrigin] = useState("https://markdrop.in");

  useEffect(() => setOrigin(window.location.origin), []);
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

  function addFiles(list: FileList | File[] | null | undefined) {
    if (!list || !list.length) return;
    const mb = Math.round(Array.from(list).reduce((n, f) => n + f.size, 0) / 1048576);
    track(senderRef.current ? "share_files_added" : "share_started", { files: list.length, mb });
    if (!senderRef.current) {
      senderRef.current = new ShareSender(roomId, {
        onChange: setSnap,
        getToken,
        forceRelay: new URLSearchParams(window.location.search).get("relay") === "1",
      });
    }
    senderRef.current.addFiles(list);
  }

  function endSharing() {
    senderRef.current?.stop();
    senderRef.current = null;
    setSnap(EMPTY);
    setRoomId(generateRoomId()); // a fresh link; the old one is dead now
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    setListDragging(false);
    // Collect synchronously (the DataTransfer empties after this handler), then
    // expand any folders.
    void filesFromDrop(e.dataTransfer).then(addFiles);
  }

  const shareUrl = `${origin}/share/${roomId}`;
  const files = snap.files;
  const totalBytes = files.reduce((n, f) => n + f.file.size, 0);
  const connected = snap.recipients.filter((r) => r.state !== "left" && r.state !== "failed" && r.state !== "connecting");
  const downloading = snap.recipients.filter((r) => r.state === "downloading");

  return (
    <div className="relative flex-1 min-h-0 overflow-y-auto">
      <AmbientBackground />

      <div className="mx-auto w-full max-w-5xl px-1 sm:px-4 py-8 sm:py-12">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <header className="text-center max-w-3xl mx-auto">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-300">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
            WebRTC · nothing uploaded
          </span>
          <h1 className="mt-4 text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 dark:text-white">
            Send files{" "}
            <span className="md-gradient-text">straight to their device</span>
          </h1>
          <p className="mt-3 max-w-2xl mx-auto text-sm sm:text-base text-gray-600 dark:text-gray-400">
            Drop one file or a hundred photos, share the link, and they stream directly from your
            device to theirs — encrypted, with no copy left on any server.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {TRUST.map((t) => (
              <span key={t.label} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/50 text-gray-600 dark:text-gray-300">
                <svg className="w-3.5 h-3.5 text-blue-500" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d={t.d} />
                </svg>
                {t.label}
                {"isNew" in t && t.isNew && (
                  <span className="ml-0.5 px-1 rounded text-[9px] font-bold uppercase tracking-wider bg-blue-500/15 text-blue-600 dark:text-blue-300">New</span>
                )}
              </span>
            ))}
          </div>
        </header>

        {/* ── Main card ───────────────────────────────────────────────────── */}
        <div className="relative mt-8 sm:mt-10 mx-auto max-w-2xl">
          <div aria-hidden className="md-glow pointer-events-none absolute -inset-4 rounded-[2rem] blur-2xl opacity-60"
            style={{ background: "radial-gradient(60% 55% at 50% 30%, rgba(59,130,246,0.22), transparent 75%)" }} />
          <div className="relative rounded-3xl border border-gray-200 dark:border-gray-800 bg-white/80 dark:bg-gray-900/60 backdrop-blur-xl shadow-2xl shadow-blue-500/10 p-4 sm:p-7">

            {snap.status === "idle" && (
              <div
                onDrop={handleDrop}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                className={`group relative rounded-2xl border-2 border-dashed transition-all duration-200 cursor-pointer ${
                  dragging
                    ? "border-blue-500 bg-blue-500/10 scale-[1.01]"
                    : "border-gray-300 dark:border-gray-700 hover:border-blue-400 dark:hover:border-blue-500 hover:bg-blue-500/5"
                }`}
              >
                <input type="file" multiple onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" aria-label="Choose files to send" />
                <div className="pointer-events-none select-none flex flex-col items-center gap-4 py-14 sm:py-16 px-6">
                  <div className={`md-float w-20 h-20 rounded-2xl flex items-center justify-center bg-gradient-to-br from-blue-500 to-sky-500 shadow-lg shadow-blue-500/30 transition-transform duration-200 ${dragging ? "scale-110" : "group-hover:scale-105"}`}>
                    <svg className="w-9 h-9 text-white" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                    </svg>
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-semibold text-gray-900 dark:text-gray-50">
                      {dragging ? "Drop to start sharing" : (
                        <>
                          <span className="sm:hidden">Tap to choose files or photos</span>
                          <span className="hidden sm:inline">Drop files or a whole folder</span>
                        </>
                      )}
                    </p>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      <span className="sm:hidden">Pick as many as you like</span>
                      <span className="hidden sm:inline">or <span className="text-blue-500 font-medium">choose files</span> — pick as many as you like</span>
                    </p>
                    <p className="mt-3 text-xs text-gray-400 dark:text-gray-500">
                      Any type · Any size · Nothing leaves your device until a recipient connects
                    </p>
                  </div>
                </div>
              </div>
            )}
            {snap.status === "idle" && (
              <p className="mt-3 text-center text-xs text-gray-500 dark:text-gray-400">
                <span className="sm:hidden">On your phone, choose <strong className="font-semibold text-gray-700 dark:text-gray-300">Photo Library</strong> and tap <strong className="font-semibold text-gray-700 dark:text-gray-300">Select</strong> to send many photos at once.</span>
                <span className="hidden sm:inline">
                  Sending a folder?{" "}
                  <button onClick={() => folderInputRef.current?.click()} className="font-medium text-blue-600 dark:text-blue-400 hover:underline">
                    Choose a folder
                  </button>
                  {" "}— every file inside is added.
                </span>
                <input ref={folderInputRef} type="file" multiple className="hidden"
                  {...({ webkitdirectory: "" } as Record<string, string>)}
                  onChange={(e) => { addFiles(Array.from(e.target.files ?? []).filter((f) => !f.name.startsWith("."))); e.target.value = ""; }} />
              </p>
            )}

            {snap.status !== "idle" && (
              <div className="space-y-4">
                <SessionStatus snap={snap} connected={connected.length} downloading={downloading.length} />

                {snap.status === "failed" && snap.failure && (
                  <Banner tone="error" title={FAILURE_COPY[snap.failure].title} detail={FAILURE_COPY[snap.failure].detail} />
                )}

                {/* Link + QR */}
                {active && (
                  <div className="grid sm:grid-cols-[1fr_auto] gap-4 items-start rounded-2xl border border-blue-200/70 dark:border-blue-800/50 bg-blue-50/50 dark:bg-blue-900/10 p-4">
                    <div className="min-w-0 space-y-3">
                      <p className="text-xs font-semibold text-blue-700 dark:text-blue-400 uppercase tracking-wider">Share this link</p>
                      <div className="flex items-center gap-2 bg-white dark:bg-gray-900 rounded-lg px-3 py-2 border border-blue-100 dark:border-blue-900/50">
                        <span className="flex-1 font-mono text-xs text-gray-700 dark:text-gray-300 truncate">{shareUrl}</span>
                        <CopyButton text={shareUrl} label="Copy" />
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Anyone with the link can open it — up to 10 people at once, each choosing what to download. It works while this tab stays open.
                      </p>
                    </div>
                    <div className="flex flex-col items-center gap-1.5 mx-auto">
                      <div className="p-2.5 rounded-xl bg-white shadow-sm">
                        <QRCodeSVG value={shareUrl} size={124} level="M" />
                      </div>
                      <p className="text-[10px] text-gray-400 dark:text-gray-500">Scan to open</p>
                    </div>
                  </div>
                )}

                {active && <Recipients recipients={snap.recipients} totalFiles={files.length} />}

                {/* Files */}
                <div
                  onDragOver={active ? (e) => { e.preventDefault(); setListDragging(true); } : undefined}
                  onDragLeave={active ? () => setListDragging(false) : undefined}
                  onDrop={active ? handleDrop : undefined}
                  className={`rounded-2xl border overflow-hidden transition-colors ${
                    listDragging
                      ? "border-blue-500 bg-blue-500/10"
                      : "border-gray-200 dark:border-gray-700/70 bg-gray-50/80 dark:bg-gray-900/50"
                  }`}>
                  <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700/70">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                        {files.length} {files.length === 1 ? "file" : "files"}
                        <span className="font-normal text-gray-500 dark:text-gray-400"> · {formatBytes(totalBytes)}</span>
                      </p>
                      {downloading.length > 0 && snap.rate > 0 && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 tabular-nums mt-0.5">
                          Sending {formatRate(snap.rate)} to {downloading.length === 1 ? "1 person" : `${downloading.length} people`}
                        </p>
                      )}
                    </div>
                    {active && (
                      <>
                        <input ref={addInputRef} type="file" multiple className="hidden"
                          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
                        <button onClick={() => addInputRef.current?.click()}
                          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-blue-600 dark:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 ring-1 ring-blue-500/25 transition-colors">
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
                          Add files
                        </button>
                      </>
                    )}
                  </div>
                  <ul className="max-h-[22rem] overflow-y-auto divide-y divide-gray-200 dark:divide-gray-800">
                    {files.map((f) => (
                      <SenderRow key={f.id} f={f} canRemove={active && !f.busy}
                        onRemove={() => senderRef.current?.removeFile(f.id)} />
                    ))}
                  </ul>
                  {active && (
                    <p className="px-4 py-2.5 border-t border-gray-200 dark:border-gray-700/70 text-[11px] text-gray-500 dark:text-gray-400">
                      {listDragging
                        ? "Drop to add these to the share"
                        : <>Forgot something? Drop more files here or use <span className="font-medium text-gray-700 dark:text-gray-300">Add files</span> — everyone connected sees them right away.</>}
                    </p>
                  )}
                </div>

                {/* CLI hint — the CLI gets one file, or several as an auto-extracted folder */}
                {active && (
                  <div className="rounded-2xl border border-gray-200 dark:border-gray-700/60 bg-gray-50 dark:bg-gray-900/40 overflow-hidden">
                    <button onClick={() => setShowCli((v) => !v)}
                      className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-colors">
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Recipient prefers the terminal?</span>
                      <svg className={`w-4 h-4 text-gray-400 transition-transform ${showCli ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {showCli && (
                      <div className="px-4 pb-4 pt-3 space-y-2 border-t border-gray-200 dark:border-gray-700/60">
                        <div className="flex items-center gap-2 bg-gray-900 dark:bg-black rounded-lg px-3 py-2.5">
                          <span className="text-green-500 select-none">$</span>
                          <span className="flex-1 font-mono text-sm text-green-400 select-all">markdrop get {roomId}</span>
                          <CopyButton text={`markdrop get ${roomId}`} label="Copy" />
                        </div>
                        <p className="text-[11px] text-gray-400 dark:text-gray-500">
                          Install: <span className="font-mono">brew install himanshkukreja/tap/markdrop</span>
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {active && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/40">
                    <svg className="w-4 h-4 shrink-0 text-amber-500" fill="currentColor" viewBox="0 0 20 20" aria-hidden>
                      <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                    </svg>
                    <p className="text-xs text-amber-700 dark:text-amber-400">Keep this tab open — files are sent from your device, so closing it ends the share.</p>
                  </div>
                )}

                <button onClick={endSharing}
                  className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                    active
                      ? "border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                      : "bg-blue-600 hover:bg-blue-500 text-white"
                  }`}>
                  {active ? "End sharing" : "Start over"}
                </button>
              </div>
            )}
          </div>
        </div>

        {snap.status === "idle" && (
          <div className="mt-12 sm:mt-14 space-y-5 max-w-2xl mx-auto">
            <BulkGuide />
            <TransferExplainer />
            <CliGuide />
          </div>
        )}
      </div>
    </div>
  );
}

function SessionStatus({ snap, connected, downloading }: { snap: SenderSnapshot; connected: number; downloading: number }) {
  let dot = "bg-amber-400 animate-pulse";
  let text = "Waiting for someone to open the link…";
  if (snap.status === "reconnecting") text = "Reconnecting to Markdrop…";
  else if (snap.status === "failed") { dot = "bg-red-500"; text = "Sharing stopped"; }
  else if (downloading > 0) {
    dot = "bg-blue-500 animate-pulse";
    text = downloading === 1 ? "Sending to 1 person" : `Sending to ${downloading} people`;
  } else if (connected > 0) {
    dot = "bg-emerald-500";
    text = "Link is live — recipients are connected";
  } else if (snap.recipients.some((r) => r.state === "connecting")) {
    text = "Someone opened the link — connecting…";
  }
  return (
    <div className="flex items-center gap-2.5 min-w-0 px-1">
      <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
      <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{text}</p>
    </div>
  );
}

function SenderRow({ f, canRemove, onRemove }: { f: SenderFileView; canRemove: boolean; onRemove: () => void }) {
  const pct = Math.round(f.progress * 100);
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <div className="w-9 h-9 rounded-lg bg-white dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700 flex items-center justify-center shrink-0">
        <FileIcon name={f.file.name} mime={f.file.type} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-gray-900 dark:text-gray-100 truncate">{f.file.name}</p>
        {f.sending > 0 ? (
          <div className="mt-1.5 h-1 rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden">
            <div className="h-full bg-blue-500 transition-[width] duration-200" style={{ width: `${pct}%` }} />
          </div>
        ) : (
          <p className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">{formatBytes(f.file.size)}</p>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-1.5">
        {f.sending > 0 && (
          <span className="text-xs tabular-nums text-blue-600 dark:text-blue-300">
            {f.sending > 1 ? `to ${f.sending}` : `${pct}%`}
          </span>
        )}
        {f.unreadable && (
          <span className="text-xs text-amber-600 dark:text-amber-400" title="The file was moved, deleted or couldn't be read. Remove it and add it again.">
            Couldn&apos;t read
          </span>
        )}
        {f.delivered > 0 && f.sending === 0 && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400"
            title={`${f.delivered} ${f.delivered === 1 ? "person has" : "people have"} this file`}>
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 13l4 4L19 7" /></svg>
            {f.delivered === 1 ? "Delivered" : `Delivered to ${f.delivered}`}
          </span>
        )}
        {canRemove && (
          <button onClick={onRemove} aria-label={`Remove ${f.file.name}`}
            className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200/70 dark:hover:bg-gray-800 transition-colors">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        )}
      </div>
    </li>
  );
}

function Banner({ tone, title, detail }: { tone: "warn" | "error"; title: string; detail: string }) {
  const c = tone === "error"
    ? "bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800/40 text-red-700 dark:text-red-400"
    : "bg-amber-50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-800/40 text-amber-800 dark:text-amber-300";
  return (
    <div className={`px-4 py-3 rounded-xl border ${c}`} role={tone === "error" ? "alert" : "status"}>
      <p className="text-sm font-semibold">{title}</p>
      <p className="text-xs mt-0.5 opacity-90">{detail}</p>
    </div>
  );
}
