/** ProseMirror-style JSON node, as `editor.getJSON()` returns it. */
export interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
}

/** What `parseMarkdown` returns; pass it back (with the editor's `doc`) to `serializeMarkdown`. */
export interface DocState {
  doc: JsonNode;
  /** The frontmatter block exactly as written ("" when none). */
  front: string;
  /** Whitespace before the first block / after the last one. */
  lead: string;
  tail: string;
  eol: "\n" | "\r\n";
  bom: string;
  /** The body had no blocks at all. */
  empty: boolean;
}

export const CALLOUT_KINDS: readonly string[];
export const LEAF_NAMES: readonly string[];

export function parseTree(md: string): unknown;
export function parseMarkdown(markdown: string, options?: { verify?: boolean }): DocState;
export function parseBlocks(md: string, options?: { verify?: boolean }): JsonNode[];
export function serializeMarkdown(state: DocState, options?: { preserve?: boolean }): string;
export function serializeFlow(children: JsonNode[], options?: { preserve?: boolean }): string;
export function serializeBlock(node: JsonNode, options?: { preserve?: boolean; prev?: JsonNode | null; prevText?: string | null }): string;
export function directiveAttrs(attributes: Record<string, unknown> | null | undefined): string;
export function phrasing(nodes: JsonNode[]): unknown[];
export function fp(node: JsonNode): string;
export function hash(s: string): string;
