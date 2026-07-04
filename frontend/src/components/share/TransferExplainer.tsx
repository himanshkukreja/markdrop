"use client";

/** Compact "how the peer-to-peer transfer works" explainer for the /share page. */
export default function TransferExplainer() {
  return (
    <div className="rounded-2xl border border-gray-200 dark:border-gray-700/60 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-gray-900/40 vscode:bg-[#252526] p-5">
      <div className="flex items-center gap-2">
        <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.4 14.4 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
        </svg>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4]">
          How the transfer works
        </h2>
      </div>

      {/* Mini diagram */}
      <div className="mt-4 flex items-center justify-between gap-2">
        {/* Sender */}
        <div className="flex flex-col items-center gap-1 shrink-0">
          <div className="w-10 h-10 rounded-lg border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] bg-white dark:bg-gray-800 vscode:bg-[#1e1e1e] flex items-center justify-center">
            <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12a9.75 9.75 0 1019.5 0 9.75 9.75 0 00-19.5 0zM2.25 12h19.5M12 2.25c2.485 2.5 3.75 6.02 3.75 9.75s-1.265 7.25-3.75 9.75c-2.485-2.5-3.75-6.02-3.75-9.75S9.515 4.75 12 2.25z" />
            </svg>
          </div>
          <span className="text-[10px] text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">You</span>
        </div>

        {/* Track with travelling packet */}
        <div className="relative flex-1 mx-1">
          <div className="h-0.5 rounded-full bg-gradient-to-r from-blue-500/40 via-blue-500 to-green-500/60" />
          <div className="md-packet-anim absolute top-1/2 -translate-y-1/2 -ml-1">
            <span className="block w-2 h-2 rounded-full bg-white shadow-[0_0_8px_2px_rgba(59,130,246,0.8)]" />
          </div>
          <span className="absolute left-1/2 -translate-x-1/2 -top-4 text-[9px] font-medium text-blue-600 dark:text-blue-400 vscode:text-[#4fc1ff] whitespace-nowrap">
            direct · encrypted
          </span>
        </div>

        {/* Recipient */}
        <div className="flex flex-col items-center gap-1 shrink-0">
          <div className="w-10 h-10 rounded-lg border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] bg-white dark:bg-gray-800 vscode:bg-[#1e1e1e] flex items-center justify-center">
            <svg className="w-5 h-5 text-green-500" fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12a9.75 9.75 0 1019.5 0 9.75 9.75 0 00-19.5 0zM2.25 12h19.5M12 2.25c2.485 2.5 3.75 6.02 3.75 9.75s-1.265 7.25-3.75 9.75c-2.485-2.5-3.75-6.02-3.75-9.75S9.515 4.75 12 2.25z" />
            </svg>
          </div>
          <span className="text-[10px] text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">Recipient</span>
        </div>
      </div>

      <div className="mt-5 grid sm:grid-cols-3 gap-4">
        {[
          ["1", "Handshake", "Our server only relays a few KB of connection details (WebRTC SDP/ICE), then steps out of the way."],
          ["2", "Direct & encrypted", "File bytes stream browser-to-browser over a DataChannel, encrypted end-to-end with DTLS."],
          ["3", "Zero storage", "Nothing is uploaded or saved. Close the tab and the room disappears — no copy to leak."],
        ].map(([n, t, d]) => (
          <div key={t} className="rounded-lg border border-gray-200 dark:border-gray-700/60 vscode:border-[#3c3c3c] bg-white/50 dark:bg-gray-900/40 vscode:bg-[#1e1e1e] p-3">
            <div className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-400 vscode:text-[#4fc1ff] text-[10px] font-bold flex items-center justify-center">{n}</span>
              <span className="text-xs font-semibold text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4]">{t}</span>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">{d}</p>
          </div>
        ))}
      </div>

      <a
        href="https://github.com/himanshkukreja/markdrop/blob/main/FILESHARE.md"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 vscode:text-[#4fc1ff] hover:underline"
      >
        Read the full technical breakdown
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
        </svg>
      </a>
    </div>
  );
}
