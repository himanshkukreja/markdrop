/** Types for player.mjs. */
export interface PlayerCue {
  start: number;
  end: number;
  text: string;
}
export interface PlayerChapter {
  start: number;
  text: string;
}
export interface TimeRangesLike {
  length: number;
  start(i: number): number;
  end(i: number): number;
}
export type PlayerKeyAction =
  | { type: "toggle" }
  | { type: "seekBy"; by: number }
  | { type: "seekPct"; pct: number }
  | { type: "seekTo"; at: number }
  | { type: "volumeBy"; by: number }
  | { type: "mute" }
  | { type: "fullscreen" }
  | { type: "captions" };

export declare function formatTime(sec: number | undefined): string;
export declare function spokenTime(sec: number | undefined): string;
export declare function seekValueText(t: number, duration: number | undefined): string;
export declare function parseClock(s: string | undefined): number | undefined;
export declare function vttTime(t: string | undefined): number;
export declare function parseVtt(src: string | undefined | null): PlayerCue[];
export declare function chapterSpans(chapters: PlayerChapter[] | undefined, duration: number | undefined): PlayerCue[];
export declare function chapterAt(chapters: Array<{ start: number }> | undefined, t: number): number;
export declare function bufferedEnd(ranges: TimeRangesLike | null | undefined, t: number): number;
export declare function clamp(n: number, lo: number, hi: number): number;
export declare const RESUME_MIN: number;
export declare const RESUME_TAIL: number;
export declare function resumeKey(src: string): string;
export declare function resumeFrom(saved: string | number | null | undefined, duration: number | undefined): number | null;
export declare function positionToSave(t: number, duration: number | undefined, ended?: boolean): number | null;
export declare const SPEEDS: number[];
export declare function keyAction(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } | null | undefined): PlayerKeyAction | null;
