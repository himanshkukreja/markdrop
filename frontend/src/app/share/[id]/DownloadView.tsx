"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { ICE_SERVERS, FileMeta, getWsUrl, formatBytes } from "@/lib/webrtc";

type Phase =
  | "connecting"   // WS open as guest, waiting for offer
  | "ready"        // meta received, showing file info + Download button
  | "downloading"  // chunks incoming
  | "done"         // all bytes received, browser download triggered
  | "no-host"      // room ID invalid / sender closed tab
  | "error";

export default function DownloadView({ roomId }: { roomId: string }) {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");

  // Refs so async WebRTC closures always see the current values
  const wsRef       = useRef<WebSocket | null>(null);
  const pcRef       = useRef<RTCPeerConnection | null>(null);
  const channelRef  = useRef<RTCDataChannel | null>(null);
  const chunksRef   = useRef<ArrayBuffer[]>([]);
  const receivedRef = useRef(0);
  const metaRef     = useRef<FileMeta | null>(null);
  const phaseRef    = useRef<Phase>("connecting");

  function updatePhase(p: Phase) {
    phaseRef.current = p;
    setPhase(p);
  }

  const cleanup = useCallback(() => {
    pcRef.current?.close();
    wsRef.current?.close();
    pcRef.current    = null;
    wsRef.current    = null;
    channelRef.current = null;
  }, []);

  useEffect(() => {
    const ws = new WebSocket(getWsUrl(roomId, "guest"));
    wsRef.current = ws;

    ws.onmessage = async (evt) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(evt.data as string);
      } catch {
        return;
      }

      // ── Sender's room doesn't exist ───────────────────────────────────────
      if (msg.type === "no-host") {
        updatePhase("no-host");
        return;
      }

      // ── WebRTC offer from host ────────────────────────────────────────────
      if (msg.type === "offer") {
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pcRef.current = pc;

        // Trickle our ICE candidates back to the host
        pc.onicecandidate = (e) => {
          if (e.candidate && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({ type: "ice", candidate: e.candidate.toJSON() }),
            );
          }
        };

        // Host created the DataChannel — wire up our receive handlers
        pc.ondatachannel = (e) => {
          const channel = e.channel;
          channelRef.current = channel;
          channel.binaryType = "arraybuffer";

          channel.onmessage = (evt) => {
            if (typeof evt.data === "string") {
              // Control message (only "meta" for now)
              try {
                const inner = JSON.parse(evt.data);
                if (inner.type === "meta") {
                  const m: FileMeta = {
                    name: inner.name as string,
                    size: inner.size as number,
                    type: inner.mimeType as string,
                  };
                  metaRef.current = m;
                  setMeta(m);
                  updatePhase("ready");
                }
              } catch { /* ignore */ }
            } else {
              // Binary chunk
              const buf = evt.data as ArrayBuffer;
              chunksRef.current.push(buf);
              receivedRef.current += buf.byteLength;
              setProgress(receivedRef.current);

              const total = metaRef.current?.size ?? 0;
              if (total > 0 && receivedRef.current >= total) {
                // All bytes received — assemble Blob and trigger browser download
                const blob = new Blob(chunksRef.current, {
                  type: metaRef.current?.type ?? "application/octet-stream",
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href     = url;
                a.download = metaRef.current?.name ?? "download";
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 30_000);
                updatePhase("done");
                cleanup();
              }
            }
          };

          channel.onerror = () => {
            if (phaseRef.current !== "done") {
              updatePhase("error");
              setError("Connection error during download.");
            }
          };
        };

        await pc.setRemoteDescription(
          new RTCSessionDescription(msg.sdp as RTCSessionDescriptionInit),
        );
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: "answer", sdp: pc.localDescription }));
      }

      // ── ICE candidate from host ───────────────────────────────────────────
      if (msg.type === "ice") {
        try {
          await pcRef.current?.addIceCandidate(
            new RTCIceCandidate(msg.candidate as RTCIceCandidateInit),
          );
        } catch { /* stale candidate — safe to ignore */ }
      }

      // ── Sender closed the tab ─────────────────────────────────────────────
      if (msg.type === "peer-disconnected") {
        if (phaseRef.current !== "done") {
          updatePhase("error");
          setError("The sender closed the connection.");
        }
      }
    };

    ws.onerror = () => {
      updatePhase("error");
      setError("Could not connect to the signalling server.");
    };

    return cleanup;
  }, [roomId, cleanup]); // eslint-disable-line react-hooks/exhaustive-deps

  // User clicked Download — tell host to start streaming
  function handleStartDownload() {
    receivedRef.current = 0;
    chunksRef.current   = [];
    setProgress(0);
    channelRef.current?.send(JSON.stringify({ type: "start" }));
    updatePhase("downloading");
  }

  const pct =
    meta && meta.size > 0 ? Math.round((progress / meta.size) * 100) : 0;

  return (
    <div className="flex flex-col items-center justify-center flex-1 min-h-0 px-4 py-6">
      <div className="w-full max-w-lg space-y-5">

        {/* ── Connecting — animated waiting state ──────────────────────────── */}
        {phase === "connecting" && (
          <div className="flex flex-col items-center gap-5 py-12">
            {/* Pulsing rings */}
            <div className="relative flex items-center justify-center">
              <span className="absolute w-16 h-16 rounded-full bg-blue-500/20 animate-ping" />
              <span className="absolute w-12 h-12 rounded-full bg-blue-500/30 animate-ping [animation-delay:150ms]" />
              <div className="relative z-10 w-10 h-10 rounded-full bg-blue-500 flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.828 14.828a4 4 0 015.656 0l4-4a4 4 0 01-5.656-5.656l-1.102 1.101" />
                </svg>
              </div>
            </div>
            <div className="text-center">
              <p className="text-base font-semibold text-gray-800 dark:text-gray-100 vscode:text-[#d4d4d4]">Connecting to sender…</p>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">Establishing encrypted peer-to-peer connection</p>
            </div>
          </div>
        )}

        {/* ── No host / expired link ────────────────────────────────────────── */}
        {phase === "no-host" && (
          <div className="flex flex-col items-center gap-4 py-10">
            <div className="w-14 h-14 rounded-2xl bg-gray-100 dark:bg-gray-800 vscode:bg-[#2d2d2d] flex items-center justify-center">
              <svg className="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m1-5.657l4-4a4 4 0 015.656 5.656l-4 4a4 4 0 01-5.656 0" />
                <line x1="2" y1="2" x2="22" y2="22" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </div>
            <div className="text-center">
              <p className="text-base font-semibold text-gray-800 dark:text-gray-100 vscode:text-[#d4d4d4]">Link expired or invalid</p>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] max-w-xs">
                The sender may have closed their tab. Ask them to share a new link.
              </p>
            </div>
            <a href="/share"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              Share your own file
            </a>
          </div>
        )}

        {/* ── File ready / downloading / done ──────────────────────────────── */}
        {(phase === "ready" || phase === "downloading" || phase === "done") && meta && (
          <div className="space-y-4">

            {/* Page header */}
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-50 vscode:text-[#d4d4d4]">
                {phase === "done" ? "Download complete" : "You received a file"}
              </h1>
              <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
                End-to-end encrypted · direct from sender&apos;s browser
              </p>
            </div>

            {/* File card */}
            <div className="flex items-center gap-4 p-4 rounded-xl border border-gray-200 dark:border-gray-700/70 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-gray-900/50 vscode:bg-[#252526]">
              <div className="w-14 h-14 rounded-xl bg-blue-50 dark:bg-blue-900/20 vscode:bg-blue-900/20 flex items-center justify-center shrink-0">
                <svg className="w-7 h-7 text-blue-500" fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4] truncate">{meta.name}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] mt-0.5">{formatBytes(meta.size)}</p>
              </div>
            </div>

            {/* Download CTA */}
            {phase === "ready" && (
              <button
                onClick={handleStartDownload}
                className="w-full py-3 flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-semibold rounded-xl transition-colors shadow-sm shadow-blue-500/20"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                Download file
              </button>
            )}

            {/* Progress */}
            {(phase === "downloading" || phase === "done") && (
              <div className="space-y-2">
                <div className="flex justify-between items-center text-xs">
                  <span className="font-medium text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]">
                    {phase === "done" ? "Saved to downloads ✓" : `Downloading… ${pct}%`}
                  </span>
                  <span className="text-gray-400 dark:text-gray-500 vscode:text-[#9d9d9d] tabular-nums">
                    {formatBytes(progress)} / {formatBytes(meta.size)}
                  </span>
                </div>
                <div className="w-full h-2.5 rounded-full bg-gray-200 dark:bg-gray-800 vscode:bg-[#3c3c3c] overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-200 ${
                      phase === "done" ? "bg-green-500" : "bg-blue-500"
                    }`}
                    style={{ width: `${phase === "done" ? 100 : pct}%` }}
                  />
                </div>
              </div>
            )}

            {/* Success state */}
            {phase === "done" && (
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-green-50 dark:bg-green-900/15 vscode:bg-green-900/15 border border-green-200 dark:border-green-800/50 vscode:border-green-800/50">
                <div className="w-7 h-7 rounded-full bg-green-100 dark:bg-green-900/40 vscode:bg-green-900/40 flex items-center justify-center shrink-0">
                  <svg className="w-4 h-4 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-semibold text-green-700 dark:text-green-400 vscode:text-green-400">File downloaded!</p>
                  <p className="text-xs text-green-600/80 dark:text-green-500/80 vscode:text-green-500/80">Check your downloads folder.</p>
                </div>
              </div>
            )}

            {/* Trust note */}
            {phase === "ready" && (
              <p className="text-center text-xs text-gray-400 dark:text-gray-500 vscode:text-[#6e6e6e]">
                🔒 Encrypted peer-to-peer · no file touches Markdrop servers
              </p>
            )}
          </div>
        )}

        {/* ── Error ────────────────────────────────────────────────────────── */}
        {phase === "error" && (
          <div className="flex flex-col items-center gap-4 py-10">
            <div className="w-14 h-14 rounded-2xl bg-red-50 dark:bg-red-900/20 vscode:bg-red-900/20 flex items-center justify-center">
              <svg className="w-7 h-7 text-red-500" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
            </div>
            <div className="text-center">
              <p className="text-base font-semibold text-gray-800 dark:text-gray-100 vscode:text-[#d4d4d4]">Transfer failed</p>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] max-w-xs">{error}</p>
            </div>
            <a href="/share"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              Share your own file
            </a>
          </div>
        )}

      </div>
    </div>
  );
}
