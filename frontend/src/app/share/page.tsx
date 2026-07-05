"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import CopyButton from "@/components/CopyButton";
import AmbientBackground from "@/components/AmbientBackground";
import TransferExplainer from "@/components/share/TransferExplainer";
import CliGuide from "@/components/share/CliGuide";
import {
  ICE_SERVERS,
  getWsUrl,
  generateRoomId,
  formatBytes,
  sendFileOverChannel,
  encodeShareMeta,
} from "@/lib/webrtc";
import { getToken } from "@/lib/api";

type Phase =
  | "idle"
  | "waiting"         // WS open as host, no guest yet
  | "connecting"      // Guest arrived, doing WebRTC handshake
  | "awaiting-start"  // Channel open, meta sent, waiting for guest to click Download
  | "transferring"    // Chunks flying
  | "done"
  | "error";

const ACTIVE_PHASES: Phase[] = ["waiting", "connecting", "awaiting-start", "transferring"];

export default function SharePage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [roomId] = useState<string>(generateRoomId);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [showCliInstall, setShowCliInstall] = useState(false);

  // Refs so async WebRTC / WS closures always see the latest values
  const wsRef      = useRef<WebSocket | null>(null);
  const pcRef      = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const fileRef    = useRef<File | null>(null);
  const phaseRef   = useRef<Phase>("idle");

  function updatePhase(p: Phase) {
    phaseRef.current = p;
    setPhase(p);
  }

  const shareUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/share/${roomId}`
      : `https://markdrop.in/share/${roomId}`;

  const cleanup = useCallback(() => {
    channelRef.current?.close();
    pcRef.current?.close();
    wsRef.current?.close();
    channelRef.current = null;
    pcRef.current      = null;
    wsRef.current      = null;
  }, []);

  // Cleanup on unmount
  useEffect(() => () => cleanup(), [cleanup]);

  // Warn the user if they try to close the tab mid-transfer
  useEffect(() => {
    if (!ACTIVE_PHASES.includes(phase)) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [phase]);

  async function startSharing(selectedFile: File) {
    fileRef.current = selectedFile;
    setFile(selectedFile);
    setProgress(0);
    updatePhase("waiting");

    const ws = new WebSocket(getWsUrl(roomId, "host"));
    wsRef.current = ws;

    ws.onmessage = async (evt) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(evt.data as string);
      } catch {
        return;
      }

      // ── Guest has opened the link ──────────────────────────────────────────
      if (msg.type === "guest-joined") {
        updatePhase("connecting");

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pcRef.current = pc;

        const channel = pc.createDataChannel("file", { ordered: true });
        channelRef.current = channel;

        // Channel is open → send file metadata and wait for "start" signal
        channel.onopen = () => {
          const f = fileRef.current!;
          channel.send(
            JSON.stringify({
              type:     "meta",
              name:     f.name,
              size:     f.size,
              mimeType: f.type || "application/octet-stream",
            }),
          );
          updatePhase("awaiting-start");
        };

        // Guest clicked Download → start streaming
        channel.onmessage = async (e) => {
          try {
            const inner = JSON.parse(e.data as string);
            if (inner.type === "start") {
              updatePhase("transferring");
              try {
                await sendFileOverChannel(channel, fileRef.current!, (sent) =>
                  setProgress(sent),
                );
                updatePhase("done");
              } catch {
                if (phaseRef.current !== "done") {
                  updatePhase("error");
                  setError("Transfer failed — the recipient may have disconnected.");
                }
              }
            }
          } catch {
            /* non-JSON message — ignore */
          }
        };

        channel.onerror = () => {
          if (phaseRef.current !== "done") {
            updatePhase("error");
            setError("Connection error during transfer.");
          }
        };

        // Trickle ICE candidates to the guest via the signalling relay
        pc.onicecandidate = (e) => {
          if (e.candidate && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({ type: "ice", candidate: e.candidate.toJSON() }),
            );
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const f = fileRef.current!;
        // Fold usage metadata into the offer as an opaque blob (see encodeShareMeta).
        // The signalling server records it and strips it before relaying onward.
        ws.send(
          JSON.stringify({
            type: "offer",
            sdp: pc.localDescription,
            x: encodeShareMeta({
              name: f.name,
              size: f.size,
              mime: f.type || "application/octet-stream",
              token: getToken(),
            }),
          }),
        );
      }

      // ── WebRTC answer from guest ───────────────────────────────────────────
      if (msg.type === "answer") {
        await pcRef.current?.setRemoteDescription(
          new RTCSessionDescription(msg.sdp as RTCSessionDescriptionInit),
        );
      }

      // ── ICE candidate from guest ──────────────────────────────────────────
      if (msg.type === "ice") {
        try {
          await pcRef.current?.addIceCandidate(
            new RTCIceCandidate(msg.candidate as RTCIceCandidateInit),
          );
        } catch {
          /* stale candidate — safe to ignore */
        }
      }

      // ── Guest disconnected ────────────────────────────────────────────────
      if (msg.type === "peer-disconnected") {
        if (phaseRef.current !== "done") {
          updatePhase("error");
          setError("Recipient disconnected before the transfer completed.");
        }
      }
    };

    ws.onerror = () => {
      updatePhase("error");
      setError("Could not connect to the signalling server.");
    };
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) startSharing(f);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) startSharing(f);
  }

  function handleReset() {
    cleanup();
    setPhase("idle");
    setFile(null);
    setProgress(0);
    setError("");
    fileRef.current = null;
  }

  const pct =
    file && file.size > 0 ? Math.round((progress / file.size) * 100) : 0;

  const isActive = ACTIVE_PHASES.includes(phase);

  // File type icon colour based on extension
  function fileIconColor(name: string) {
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    if (["jpg","jpeg","png","gif","svg","webp"].includes(ext)) return "text-pink-400";
    if (["mp4","mov","avi","mkv","webm"].includes(ext)) return "text-purple-400";
    if (["mp3","wav","ogg","flac"].includes(ext)) return "text-yellow-400";
    if (["zip","tar","gz","rar","7z"].includes(ext)) return "text-orange-400";
    if (["pdf"].includes(ext)) return "text-red-400";
    if (["js","ts","tsx","jsx","py","go","rs"].includes(ext)) return "text-green-400";
    return "text-blue-400";
  }

  const TRUST = [
    { label: "End-to-end encrypted", d: "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" },
    { label: "Direct peer-to-peer", d: "M13 10V3L4 14h7v7l9-11h-7z" },
    { label: "Zero server storage", d: "M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" },
    { label: "Any size, any type", d: "M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" },
  ];

  return (
    <div className="relative flex-1 min-h-0 overflow-y-auto">
      <AmbientBackground />

      <div className="mx-auto w-full max-w-5xl px-1 sm:px-4 py-8 sm:py-12">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <header className="text-center max-w-2xl mx-auto">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-300 vscode:text-[#4fc1ff]">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
            WebRTC · nothing uploaded
          </span>
          <h1 className="mt-4 text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 dark:text-white vscode:text-[#e8e8e8]">
            Send a file{" "}
            <span className="md-gradient-text">straight to their browser</span>
          </h1>
          <p className="mt-3 text-sm sm:text-base text-gray-600 dark:text-gray-400 vscode:text-[#9d9d9d]">
            Drop a file, share the link, and the bytes stream directly from your device to theirs —
            encrypted, with no copy left on any server.
          </p>

          {/* Trust pills */}
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {TRUST.map((t) => (
              <span key={t.label} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-white/60 dark:bg-gray-900/50 vscode:bg-[#252526] text-gray-600 dark:text-gray-300 vscode:text-[#c8c8c8]">
                <svg className="w-3.5 h-3.5 text-blue-500" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d={t.d} />
                </svg>
                {t.label}
              </span>
            ))}
          </div>
        </header>

        {/* ── Main share card ─────────────────────────────────────────────── */}
        <div className="relative mt-8 sm:mt-10 mx-auto max-w-2xl">
          {/* Soft glow behind the card */}
          <div
            aria-hidden
            className="md-glow pointer-events-none absolute -inset-4 rounded-[2rem] blur-2xl opacity-60"
            style={{ background: "radial-gradient(60% 55% at 50% 30%, rgba(59,130,246,0.22), transparent 75%)" }}
          />
          <div className="relative rounded-3xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-white/80 dark:bg-gray-900/60 vscode:bg-[#252526]/90 backdrop-blur-xl shadow-2xl shadow-blue-500/10 p-5 sm:p-7">

            {/* ── Idle: drop zone ──────────────────────────────────────────── */}
            {phase === "idle" && (
              <div
                onDrop={handleDrop}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                className={`group relative rounded-2xl border-2 border-dashed transition-all duration-200 cursor-pointer
                  ${ dragging
                    ? "border-blue-500 bg-blue-500/10 scale-[1.01]"
                    : "border-gray-300 dark:border-gray-700 vscode:border-[#444] hover:border-blue-400 dark:hover:border-blue-500 vscode:hover:border-blue-500 hover:bg-blue-500/5"
                  }`}
              >
                <input
                  type="file"
                  onChange={handleFileInput}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                />
                <div className="pointer-events-none select-none flex flex-col items-center gap-4 py-14 sm:py-16 px-6">
                  <div className={`md-float w-20 h-20 rounded-2xl flex items-center justify-center bg-gradient-to-br from-blue-500 to-sky-500 shadow-lg shadow-blue-500/30 transition-transform duration-200 ${dragging ? "scale-110" : "group-hover:scale-105"}`}>
                    <svg className="w-9 h-9 text-white" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                    </svg>
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-semibold text-gray-900 dark:text-gray-50 vscode:text-[#e8e8e8]">
                      {dragging ? "Drop to start sharing" : "Drop your file here"}
                    </p>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
                      or <span className="text-blue-500 font-medium">click to browse</span>
                    </p>
                    <p className="mt-3 text-xs text-gray-400 dark:text-gray-500 vscode:text-[#6a6a6a]">
                      Any file type · Any size · It never leaves your device until a recipient connects
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* ── Active / done / error ────────────────────────────────────── */}
            {phase !== "idle" && (
              <div className="space-y-5">

                {/* File card */}
                {file && (
                  <div className="flex items-center gap-4 p-4 rounded-2xl border border-gray-200 dark:border-gray-700/70 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-gray-900/60 vscode:bg-[#1e1e1e]">
                    <div className="w-12 h-12 rounded-xl bg-gray-100 dark:bg-gray-800 vscode:bg-[#2d2d2d] flex items-center justify-center shrink-0">
                      <svg className={`w-6 h-6 ${fileIconColor(file.name)}`} fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                      </svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4] truncate">{file.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] mt-0.5">{formatBytes(file.size)}</p>
                    </div>
                    <span className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                      phase === "done"        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 vscode:bg-green-900/30 vscode:text-green-400"
                      : phase === "error"     ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 vscode:bg-red-900/30 vscode:text-red-400"
                      : phase === "transferring" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 vscode:bg-blue-900/30 vscode:text-blue-400"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 vscode:bg-amber-900/30 vscode:text-amber-400"
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        phase === "done"          ? "bg-green-500"
                        : phase === "error"       ? "bg-red-500"
                        : phase === "transferring" ? "bg-blue-500 animate-pulse"
                        : "bg-amber-400 animate-pulse"
                      }`} />
                      {phase === "done" ? "Sent" : phase === "error" ? "Failed"
                        : phase === "transferring" ? `${pct}%`
                        : phase === "awaiting-start" ? "Ready" : "Waiting"}
                    </span>
                  </div>
                )}

                {/* Share link + QR (two columns) */}
                {isActive && (
                  <div className="grid sm:grid-cols-[1fr_auto] gap-4 items-start rounded-2xl border border-blue-200/70 dark:border-blue-800/50 vscode:border-[#3c3c3c] bg-blue-50/50 dark:bg-blue-900/10 vscode:bg-[#1e1e1e] p-4">
                    <div className="min-w-0 space-y-3">
                      <p className="text-xs font-semibold text-blue-700 dark:text-blue-400 vscode:text-[#4fc1ff] uppercase tracking-wider">
                        Share this link
                      </p>
                      <div className="flex items-center gap-2 bg-white dark:bg-gray-900 vscode:bg-[#252526] rounded-lg px-3 py-2 border border-blue-100 dark:border-blue-900/50 vscode:border-[#3c3c3c]">
                        <span className="flex-1 font-mono text-xs text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] truncate">{shareUrl}</span>
                        <CopyButton text={shareUrl} label="Copy" />
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
                        Your recipient opens it on any device and sees the file details before downloading.
                      </p>
                    </div>
                    <div className="flex flex-col items-center gap-1.5 mx-auto">
                      <div className="p-2.5 rounded-xl bg-white shadow-sm">
                        <QRCodeSVG value={shareUrl} size={124} level="M" />
                      </div>
                      <p className="text-[10px] text-gray-400 dark:text-gray-500 vscode:text-[#6a6a6a]">Scan to open</p>
                    </div>
                  </div>
                )}

                {/* CLI download hint */}
                {isActive && (
                  <div className="rounded-2xl border border-gray-200 dark:border-gray-700/60 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-gray-900/40 vscode:bg-[#1e1e1e] overflow-hidden">
                    <button
                      onClick={() => setShowCliInstall(v => !v)}
                      className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-100 dark:hover:bg-gray-800/60 vscode:hover:bg-[#2d2d2d] transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <svg className="w-4 h-4 text-gray-500 dark:text-gray-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
                        </svg>
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]">
                          Recipient prefers the terminal?
                        </span>
                      </div>
                      <svg className={`w-4 h-4 text-gray-400 transition-transform ${showCliInstall ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {showCliInstall && (
                      <div className="px-4 pb-4 space-y-2 border-t border-gray-200 dark:border-gray-700/60 vscode:border-[#3c3c3c] pt-3">
                        <p className="text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
                          They can download it without a browser:
                        </p>
                        <div className="flex items-center gap-2 bg-gray-900 dark:bg-black vscode:bg-[#252526] rounded-lg px-3 py-2.5">
                          <span className="text-green-500 select-none">$</span>
                          <span className="flex-1 font-mono text-sm text-green-400 select-all">markdrop get {roomId}</span>
                          <CopyButton text={`markdrop get ${roomId}`} label="Copy" />
                        </div>
                        <p className="text-[11px] text-gray-400 dark:text-gray-500 vscode:text-[#6a6a6a]">
                          Install: <span className="font-mono">brew install himanshkukreja/tap/markdrop</span> · see all options below.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Status strip */}
                {(phase === "waiting" || phase === "connecting" || phase === "awaiting-start") && (
                  <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-gray-50 dark:bg-gray-900/40 vscode:bg-[#1e1e1e] border border-gray-200 dark:border-gray-700/60 vscode:border-[#3c3c3c]">
                    <svg className={`w-4 h-4 shrink-0 ${phase === "awaiting-start" ? "text-green-500" : "text-blue-500 animate-spin"}`} fill="none" viewBox="0 0 24 24">
                      {phase === "awaiting-start" ? (
                        <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      ) : (
                        <>
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
                        </>
                      )}
                    </svg>
                    <p className="text-sm text-gray-600 dark:text-gray-300 vscode:text-[#c8c8c8]">
                      {phase === "waiting"        && "Waiting for recipient to open the link…"}
                      {phase === "connecting"     && "Establishing encrypted peer connection…"}
                      {phase === "awaiting-start" && "Connected — waiting for recipient to click Download"}
                    </p>
                  </div>
                )}

                {/* Transfer progress */}
                {(phase === "transferring" || phase === "done") && file && (
                  <div className="space-y-2">
                    <div className="flex justify-between items-center text-xs">
                      <span className="font-medium text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]">
                        {phase === "done" ? "Transfer complete ✓" : `Sending… ${pct}%`}
                      </span>
                      <span className="text-gray-400 dark:text-gray-500 vscode:text-[#9d9d9d] tabular-nums">
                        {formatBytes(progress)} / {formatBytes(file.size)}
                      </span>
                    </div>
                    <div className="w-full h-3 rounded-full bg-gray-200 dark:bg-gray-800 vscode:bg-[#3c3c3c] overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-200 ${phase === "done" ? "bg-green-500" : "bg-gradient-to-r from-blue-500 to-sky-500"}`}
                        style={{ width: `${phase === "done" ? 100 : pct}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Keep-open warning */}
                {isActive && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/10 vscode:bg-amber-900/10 border border-amber-200 dark:border-amber-800/40 vscode:border-amber-800/40">
                    <svg className="w-4 h-4 shrink-0 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                    </svg>
                    <p className="text-xs text-amber-700 dark:text-amber-400 vscode:text-amber-400">
                      Keep this tab open until the transfer completes
                    </p>
                  </div>
                )}

                {/* Success banner */}
                {phase === "done" && (
                  <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-green-50 dark:bg-green-900/15 vscode:bg-green-900/15 border border-green-200 dark:border-green-800/50 vscode:border-green-800/50">
                    <div className="w-7 h-7 rounded-full bg-green-100 dark:bg-green-900/40 vscode:bg-green-900/40 flex items-center justify-center shrink-0">
                      <svg className="w-4 h-4 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-green-700 dark:text-green-400 vscode:text-green-400">File sent successfully!</p>
                      <p className="text-xs text-green-600/80 dark:text-green-500/80 vscode:text-green-500/80">The recipient saved the file on their device.</p>
                    </div>
                  </div>
                )}

                {/* Reset button */}
                {(phase === "done" || phase === "error") && (
                  <button onClick={handleReset}
                    className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors">
                    {phase === "done" ? "Share another file" : "Try again"}
                  </button>
                )}

                {/* Error banner */}
                {phase === "error" && (
                  <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-red-50 dark:bg-red-900/10 vscode:bg-red-900/10 border border-red-200 dark:border-red-800/40 vscode:border-red-800/40">
                    <svg className="w-4 h-4 shrink-0 mt-0.5 text-red-500" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
                    </svg>
                    <p className="text-sm text-red-700 dark:text-red-400 vscode:text-red-400">{error}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Informative sections (idle only) ────────────────────────────── */}
        {phase === "idle" && (
          <div className="mt-12 sm:mt-14 space-y-5 max-w-2xl mx-auto">
            <TransferExplainer />
            <CliGuide />
          </div>
        )}
      </div>
    </div>
  );
}
