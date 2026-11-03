/** Types for diff.mjs (block-level comparison of two pages' Markdown). */
export type DiffKind = "same" | "add" | "del";
export interface DiffSegment {
  kind: DiffKind;
  blocks: string[];
}
export function stripFront(markdown: string | null | undefined): string;
export function splitBlocks(markdown: string | null | undefined): string[];
export function diffBlocks(before: string | null | undefined, after: string | null | undefined): DiffSegment[];
export function diffStats(segments: DiffSegment[]): { added: number; removed: number };
