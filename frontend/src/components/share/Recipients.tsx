"use client";

import { formatBytes, formatRate } from "@/lib/webrtc";
import { FAILURE_COPY } from "@/lib/p2p/protocol";
import type { RecipientView } from "@/lib/p2p/sender";
import { RouteBadge } from "./FileIcon";

/**
 * Who has the link open, and how far each of them has got. Progress comes
 * from the recipient's own reports, not from how much we've queued (which
 * runs megabytes ahead), so "Downloaded" means it landed on their device.
 */
export default function Recipients({ recipients, totalFiles }: { recipients: RecipientView[]; totalFiles: number }) {
  if (!recipients.length) return null;
  const here = recipients.filter((r) => r.state !== "left" && r.state !== "failed");
  return (
    <div className="rounded-2xl border border-gray-200 dark:border-gray-700/70 bg-gray-50/80 dark:bg-gray-900/50 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700/70">
        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {here.length === 0 ? "Nobody connected right now" : here.length === 1 ? "1 person connected" : `${here.length} people connected`}
        </p>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">up to 10 at once</span>
      </div>
      <ul className="divide-y divide-gray-200 dark:divide-gray-800">
        {recipients.map((r) => <Row key={r.gid} r={r} totalFiles={totalFiles} />)}
      </ul>
    </div>
  );
}

function Row({ r, totalFiles }: { r: RecipientView; totalFiles: number }) {
  const gone = r.state === "left" || r.state === "failed";
  const pct = r.bytesWanted ? Math.min(100, (r.bytesDone / r.bytesWanted) * 100) : 0;
  const everything = r.filesWanted === totalFiles && totalFiles > 0;

  let line: React.ReactNode;
  let tone = "text-gray-500 dark:text-gray-400";
  switch (r.state) {
    case "connecting":
      line = "Connecting…";
      break;
    case "browsing":
      line = r.filesDone > 0 ? `Has ${r.filesDone} of ${totalFiles} · looking at the rest` : "Looking at the files";
      break;
    case "downloading":
      line = (
        <>
          Downloading {Math.min(r.filesDone + 1, r.filesWanted)} of {r.filesWanted}
          {r.currentName && <span className="text-gray-400 dark:text-gray-500"> · {r.currentName}</span>}
        </>
      );
      tone = "text-blue-600 dark:text-blue-300";
      break;
    case "done":
      line = !everything
        ? `Downloaded ${r.filesDone} of ${totalFiles}`
        : totalFiles === 1 ? "Downloaded it" : `Downloaded all ${totalFiles}`;
      tone = "text-emerald-600 dark:text-emerald-400";
      break;
    case "left":
      line = r.filesDone ? `Left · got ${r.filesDone} of ${totalFiles}` : "Left without downloading";
      break;
    case "failed":
      line = r.failure ? FAILURE_COPY[r.failure].title : "Disconnected";
      tone = "text-amber-600 dark:text-amber-400";
      break;
  }

  return (
    <li className={`px-4 py-3 ${gone ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-3">
        <div className="relative w-9 h-9 rounded-full bg-white dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700 flex items-center justify-center shrink-0">
          <DeviceGlyph label={r.label} />
          {!gone && (
            <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-gray-50 dark:ring-gray-900 ${
              r.state === "connecting" ? "bg-amber-400 animate-pulse" : "bg-emerald-500"
            }`} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{r.label}</p>
            {!gone && <RouteBadge route={r.route} />}
          </div>
          <p className={`text-xs truncate ${tone}`}>
            {r.state === "done" && (
              <svg className="inline w-3.5 h-3.5 -mt-0.5 mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 13l4 4L19 7" /></svg>
            )}
            {line}
          </p>
        </div>
        {r.state === "downloading" && (
          <div className="shrink-0 text-right">
            <p className="text-xs font-semibold tabular-nums text-blue-600 dark:text-blue-300">{Math.floor(pct)}%</p>
            {r.rate > 0 && <p className="text-[10px] tabular-nums text-gray-400 dark:text-gray-500">{formatRate(r.rate)}</p>}
          </div>
        )}
      </div>
      {r.state === "downloading" && (
        <div className="mt-2 ml-12 h-1 rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden" title={`${formatBytes(r.bytesDone)} of ${formatBytes(r.bytesWanted)}`}>
          <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-sky-400 transition-[width] duration-200" style={{ width: `${pct}%` }} />
        </div>
      )}
    </li>
  );
}

function DeviceGlyph({ label }: { label: string }) {
  const phone = /iPhone|Android phone/.test(label);
  const tablet = /iPad|tablet/.test(label);
  return (
    <svg className="w-[18px] h-[18px] text-gray-500 dark:text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {phone
        ? <><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></>
        : tablet
          ? <><rect x="4.5" y="2.5" width="15" height="19" rx="2.5" /><path d="M11 18.5h2" /></>
          : <><rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M8 20h8M12 16.5V20" /></>}
    </svg>
  );
}
