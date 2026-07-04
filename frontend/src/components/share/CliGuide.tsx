"use client";

import { useState } from "react";
import CopyButton from "@/components/CopyButton";

const INSTALL = [
  { os: "macOS", cmd: "brew install himanshkukreja/tap/markdrop" },
  { os: "Linux / macOS", cmd: "curl -fsSL https://github.com/himanshkukreja/markdrop/releases/latest/download/install.sh | sh" },
  { os: "Windows (PowerShell)", cmd: "irm https://github.com/himanshkukreja/markdrop/releases/latest/download/install.ps1 | iex" },
];

const FLOWS = [
  { from: "Terminal", to: "Browser", desc: "Send from your shell, receive in any browser via the link." },
  { from: "Browser", to: "Terminal", desc: "Drop a file on this page, receive it with markdrop get." },
  { from: "Terminal", to: "Terminal", desc: "Fully headless — great for servers and scripts." },
];

const PERKS = [
  ["Whole folders", "Point at a directory — it's zipped, sent, and unzipped on arrival."],
  ["No size limit", "Streams straight to disk, so it isn't capped by browser memory."],
  ["Custom output", "-o picks the save path or filename; -y auto-accepts for scripts."],
  ["Same network, same room", "Uses the exact WebRTC protocol as the browser — they interoperate."],
];

function CommandLine({ cmd }: { cmd: string }) {
  return (
    <div className="flex items-center gap-2 bg-gray-900 dark:bg-black vscode:bg-[#1e1e1e] rounded-lg px-3 py-2.5">
      <span className="text-green-500 select-none">$</span>
      <span className="flex-1 font-mono text-sm text-green-400 break-all select-all">{cmd}</span>
      <CopyButton text={cmd} label="Copy" />
    </div>
  );
}

export default function CliGuide() {
  const [tab, setTab] = useState<"send" | "receive">("send");
  const [showInstall, setShowInstall] = useState(false);

  return (
    <div className="rounded-2xl border border-gray-200 dark:border-gray-700/60 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-gray-900/40 vscode:bg-[#252526] p-5">
      <div className="flex items-center gap-2">
        <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
        </svg>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4]">
          Prefer the terminal? Use the CLI
        </h2>
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
        Install once, then send and receive from your shell — fully interoperable with the browser.
      </p>

      {/* Send / Receive tabs */}
      <div className="mt-4 inline-flex rounded-lg border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] p-0.5 bg-white/60 dark:bg-gray-900/60 vscode:bg-[#1e1e1e]">
        {(["send", "receive"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1 rounded-md text-xs font-medium capitalize transition-colors ${
              tab === t
                ? "bg-blue-600 text-white"
                : "text-gray-600 dark:text-gray-400 vscode:text-[#9d9d9d] hover:text-gray-900 dark:hover:text-gray-200"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mt-3">
        {tab === "send" ? (
          <>
            <CommandLine cmd="markdrop send report.pdf" />
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
              Prints a share link + QR code. Hand it to a browser or another terminal. Pass a folder to send a whole directory.
            </p>
          </>
        ) : (
          <>
            <CommandLine cmd="markdrop get <room-id | link>" />
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
              Works with a bare ID or a full markdrop.in/share link. Add <code className="font-mono text-blue-600 dark:text-blue-400 vscode:text-[#4fc1ff]">-o</code> to choose where to save, <code className="font-mono text-blue-600 dark:text-blue-400 vscode:text-[#4fc1ff]">-y</code> to skip the prompt.
            </p>
          </>
        )}
      </div>

      {/* Interop flows */}
      <div className="mt-4 grid gap-2">
        {FLOWS.map((f) => (
          <div key={`${f.from}-${f.to}`} className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700/60 vscode:border-[#3c3c3c] bg-white/50 dark:bg-gray-900/40 vscode:bg-[#1e1e1e] px-3 py-2">
            <span className="flex items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] shrink-0">
              {f.from}
              <svg className="w-3.5 h-3.5 text-blue-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
              {f.to}
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">{f.desc}</span>
          </div>
        ))}
      </div>

      {/* Perks */}
      <ul className="mt-4 grid sm:grid-cols-2 gap-x-4 gap-y-2">
        {PERKS.map(([t, d]) => (
          <li key={t} className="flex gap-2">
            <svg className="w-4 h-4 mt-0.5 shrink-0 text-blue-500" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.3 3.3 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
            </svg>
            <span className="text-xs text-gray-600 dark:text-gray-400 vscode:text-[#9d9d9d]">
              <strong className="font-semibold text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4]">{t}.</strong> {d}
            </span>
          </li>
        ))}
      </ul>

      {/* Install (collapsible) */}
      <button
        onClick={() => setShowInstall((v) => !v)}
        className="mt-4 flex items-center gap-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 vscode:text-[#4fc1ff] hover:underline"
      >
        <svg className={`w-3.5 h-3.5 transition-transform ${showInstall ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        {showInstall ? "Hide install commands" : "Install the CLI"}
      </button>

      {showInstall && (
        <div className="mt-3 space-y-2">
          {INSTALL.map(({ os, cmd }) => (
            <div key={os}>
              <p className="text-[11px] text-gray-400 dark:text-gray-500 vscode:text-[#6a6a6a] mb-1">{os}</p>
              <div className="flex items-center gap-2 bg-gray-900 dark:bg-black vscode:bg-[#1e1e1e] rounded-lg px-3 py-2">
                <span className="flex-1 font-mono text-xs text-gray-300 break-all select-all">{cmd}</span>
                <CopyButton text={cmd} label="Copy" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
