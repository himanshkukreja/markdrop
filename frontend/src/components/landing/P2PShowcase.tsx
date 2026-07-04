"use client";

import Reveal from "./Reveal";

function BrowserNode({ label, side }: { label: string; side: "left" | "right" }) {
  return (
    <div className="flex flex-col items-center gap-2 shrink-0 w-24 sm:w-28">
      <div className="w-full rounded-lg border border-gray-300 dark:border-gray-700 vscode:border-[#3c3c3c] bg-white dark:bg-[#0b0f1a] vscode:bg-[#1e1e1e] overflow-hidden shadow-md">
        <div className="flex gap-1 px-2 py-1.5 bg-gray-100 dark:bg-gray-900 vscode:bg-[#323233]">
          <span className="w-1.5 h-1.5 rounded-full bg-[#ff5f57]" />
          <span className="w-1.5 h-1.5 rounded-full bg-[#febc2e]" />
          <span className="w-1.5 h-1.5 rounded-full bg-[#28c840]" />
        </div>
        <div className="h-10 flex items-center justify-center">
          <svg className={`w-6 h-6 ${side === "left" ? "text-blue-500" : "text-green-500"}`} fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12a9.75 9.75 0 1019.5 0 9.75 9.75 0 00-19.5 0zM2.25 12h19.5M12 2.25c2.485 2.5 3.75 6.02 3.75 9.75s-1.265 7.25-3.75 9.75c-2.485-2.5-3.75-6.02-3.75-9.75S9.515 4.75 12 2.25z" />
          </svg>
        </div>
      </div>
      <span className="text-xs font-medium text-gray-600 dark:text-gray-400 vscode:text-[#a0a0a0]">{label}</span>
    </div>
  );
}

export default function P2PShowcase() {
  return (
    <section className="py-16 sm:py-20">
      <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 items-center">
        {/* Copy */}
        <Reveal className="order-2 lg:order-1">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400">
            WebRTC · zero storage
          </span>
          <h2 className="mt-4 text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 dark:text-white vscode:text-[#e8e8e8]">
            The server never sees your file.
          </h2>
          <p className="mt-4 text-gray-600 dark:text-gray-400 vscode:text-[#a0a0a0] leading-relaxed">
            Drop a file and get a link. When your recipient opens it, the file streams
            straight from your browser to theirs over an encrypted WebRTC channel.
            Markdrop only relays a few kilobytes of connection setup — never a single byte of your file.
          </p>
          <ul className="mt-6 space-y-3">
            {[
              ["End-to-end encrypted", "DTLS 1.2 is mandatory in WebRTC — it can't be turned off."],
              ["No upload, no size cap", "Bytes go peer-to-peer; limited only by your device, not our disk."],
              ["Nothing persisted", "Rooms live in memory for the transfer, then vanish. No database."],
            ].map(([t, d]) => (
              <li key={t} className="flex gap-3">
                <svg className="w-5 h-5 mt-0.5 shrink-0 text-green-500" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.3 3.3 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
                </svg>
                <span className="text-sm text-gray-700 dark:text-gray-300 vscode:text-[#c8c8c8]">
                  <strong className="font-semibold text-gray-900 dark:text-white vscode:text-[#e8e8e8]">{t}.</strong> {d}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <a href="/share" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors">
              Try file sharing
            </a>
            <a
              href="https://github.com/himanshkukreja/markdrop/blob/main/FILESHARE.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-blue-600 dark:text-blue-400 vscode:text-[#4fc1ff] hover:underline"
            >
              How it works, in depth →
            </a>
          </div>
        </Reveal>

        {/* Animated diagram */}
        <Reveal className="order-1 lg:order-2">
          <div className="rounded-2xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-gray-50/70 dark:bg-gray-900/40 vscode:bg-[#252526] p-6 sm:p-8">
            {/* Relay (steps away) */}
            <div className="flex flex-col items-center">
              <div className="md-float px-3 py-1.5 rounded-lg border border-dashed border-gray-300 dark:border-gray-700 vscode:border-[#4a4a4a] text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] bg-white/60 dark:bg-gray-950/40 vscode:bg-[#1e1e1e]">
                <span className="flex items-center gap-1.5">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3" />
                  </svg>
                  Signalling relay
                </span>
              </div>
              <span className="mt-1 text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-600">~20&nbsp;KB · then steps away</span>
              {/* dashed drop lines */}
              <div className="flex items-end gap-16 sm:gap-20 mt-2">
                <div className="w-px h-8 border-l border-dashed border-gray-300 dark:border-gray-700 vscode:border-[#4a4a4a]" />
                <div className="w-px h-8 border-l border-dashed border-gray-300 dark:border-gray-700 vscode:border-[#4a4a4a]" />
              </div>
            </div>

            {/* Peers + direct P2P track */}
            <div className="flex items-center justify-between">
              <BrowserNode label="Sender" side="left" />

              <div className="relative flex-1 mx-2 sm:mx-3">
                {/* the P2P line */}
                <div className="h-1 rounded-full bg-gradient-to-r from-blue-500/40 via-blue-500 to-green-500/60" />
                {/* travelling packet */}
                <div className="md-packet-anim absolute top-1/2 -translate-y-1/2 -ml-1.5">
                  <span className="block w-3 h-3 rounded-full bg-white shadow-[0_0_10px_2px_rgba(59,130,246,0.8)]" />
                </div>
                <span className="absolute left-1/2 -translate-x-1/2 -top-6 text-[10px] font-medium text-blue-600 dark:text-blue-400 vscode:text-[#4fc1ff] whitespace-nowrap">
                  direct · encrypted
                </span>
                <span className="absolute left-1/2 -translate-x-1/2 top-3 text-[10px] text-gray-400 dark:text-gray-600 whitespace-nowrap">
                  file bytes (P2P)
                </span>
              </div>

              <BrowserNode label="Recipient" side="right" />
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
