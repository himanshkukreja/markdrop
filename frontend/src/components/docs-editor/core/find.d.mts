import type { Node as PMNode } from "@tiptap/pm/model";

export interface FindOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
}
export interface Match {
  from: number;
  to: number;
}
export const MAX_MATCHES: number;
export function searchRegExp(query: string, opts?: FindOptions): RegExp | null;
export function textMatches(text: string, query: string, opts?: FindOptions): Match[];
export function blockText(node: PMNode): string;
export function docMatches(doc: PMNode, query: string, opts?: FindOptions): Match[];
export function nextIndex(matches: Match[], pos: number, dir?: 1 | -1): number;
export function replaceAllText(text: string, query: string, replacement: string, opts?: FindOptions): { text: string; count: number };
