/**
 * Meeting notes ↔ the kept recording (components/meetings/MeetingRecording.tsx): which clicks on a meeting
 * page mean "play the recording from here", and the time they mean. Pure, for node --test.
 *
 *  - The summary page cites transcript moments as links "[12:34](/<transcript>#b-t0012)" (backend
 *    services/meetings.cite_link): the link's text is the time.
 *  - The transcript page starts each line with "**12:34 · Speaker**" in a block whose id is "b-t…".
 */

const CLOCK = /^\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?!\d)/;

/** "12:34" → 754, "1:02:03" → 3723; null when the text doesn't start with a time. */
export function clockSeconds(text) {
  const m = CLOCK.exec(String(text ?? ""));
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const s = Number(m[3]);
  if (s > 59 || (m[1] && min > 59)) return null;
  return h * 3600 + min * 60 + s;
}

/** A transcript-moment anchor ("#b-t0012"). */
export const MOMENT_HASH = /^#b-t\d+$/;

/**
 * A summary link to a moment of this meeting's transcript, as seconds (null: not one). `href` is the
 * link's attribute as written (relative) or resolved; `base` resolves a relative one.
 */
export function citeSeconds(href, text, transcriptSlug, base = "https://markdrop.in") {
  if (!href || !transcriptSlug) return null;
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (u.origin !== new URL(base).origin) return null;
  if (decodeURIComponent(u.pathname) !== `/${transcriptSlug}` || !MOMENT_HASH.test(u.hash)) return null;
  return clockSeconds(text);
}

/** The time a transcript line's lead ("12:34 · Ada") stands for, when its block is a transcript line. */
export function lineSeconds(blockId, leadText) {
  if (!blockId || !/^b-t\d+$/.test(blockId)) return null;
  return clockSeconds(leadText);
}
