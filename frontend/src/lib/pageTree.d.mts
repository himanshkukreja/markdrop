export const TREE_INDENT: number;
export interface TreeRow {
  slug: string;
  depth: number;
  top: number;
  bottom: number;
  parent: string | null;
  /** The row's ancestors in the tree, top first (ancestors[d] is the one at depth d). */
  ancestors: string[];
  open: boolean;
  hasKids: boolean;
  /** Its sub-pages' slugs, when loaded. */
  kids?: string[] | null;
}
export interface TreeDrop {
  kind: "inside" | "before" | "after";
  /** The row the drop is drawn against. */
  row: string;
  parent: string | null;
  /** The sibling it goes after: null = first, undefined = last. */
  after: string | null | undefined;
  depth: number;
  y: number;
  valid: boolean;
  noop: boolean;
}
export function dropAt(
  rows: TreeRow[],
  at: { x: number; y: number; left: number },
  drag: { slug: string; parent: string | null; prev: string | null; blocked: Set<string> | string[]; minDepth?: number },
): TreeDrop | null;
export function subtree(slug: string, kidsOf: Record<string, unknown>): Set<string>;
export function moveIn<T extends { slug: string }>(kidsOf: Record<string, T[] | unknown>, slug: string, from: string | null, to: string | null, after: string | null | undefined): Record<string, T[] | unknown>;
export function copyTitle(title: string | null | undefined, taken?: Array<string | null | undefined>): string;
export function assetIdsIn(markdown: string | null | undefined): string[];
export function rewriteAssets(markdown: string, map: Record<string, string>): string;
export function rewritePageLinks(markdown: string, map: Record<string, string>): string;
export function imageName(id: string, mime: string | null | undefined): string;
export function readersText(v: unknown): string;
