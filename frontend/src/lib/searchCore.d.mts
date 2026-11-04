export interface Segment { text: string; mark: boolean }
export type CiteSegment = { text: string; cite?: undefined } | { cite: number; text?: undefined };
export function looksLikeQuestion(q: string | null | undefined): boolean;
export function highlight(text: string | null | undefined, marks: unknown): Segment[];
export function citeSegments(answer: string | null | undefined, known: Iterable<number>): CiteSegment[];
export const RECENT_KEY: string;
export const RECENT_MAX: number;
export function pushRecent(list: unknown, q: string): string[];
export const GROUP_LABELS: Record<string, string>;
export const KIND_LABELS: Record<string, string>;
export function shortAgo(iso: string | null | undefined, now?: number): string;
export function whereOf(item: {
  kind?: string;
  workspace?: { name?: string | null } | null;
  folder?: { path?: string[] | null } | null;
  owner?: { is_you?: boolean } | null;
  guide?: { name?: string | null } | null;
  path?: string | null;
} | null | undefined): string;
