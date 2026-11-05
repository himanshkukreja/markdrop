export interface LineEdit {
  start: number;
  end: number;
  lines: string[];
}
export interface MergeConflict {
  base: string;
  mine: string;
  theirs: string;
}
export interface MergeResult {
  /** No overlapping edits: `content` has both sides' changes. */
  clean: boolean;
  /** Both sides merged; a conflicting stretch takes theirs. */
  content: string;
  /** The same, but a conflicting stretch takes mine. */
  mineContent: string;
  conflicts: MergeConflict[];
}
export function diffLines(a: string[], b: string[]): LineEdit[];
export function merge3(base: string, mine: string, theirs: string): MergeResult;
