/** Types for rules.mjs. */
export declare function hasWrapFlag(meta: string | null | undefined): boolean;
export declare function aliasesByTarget(anchors: Record<string, string> | undefined): Map<string, string[]>;
export declare function aliasNodes(
  aliases: Map<string, string[]>,
  id: string,
  taken: Set<string>,
): Array<{ type: "element"; tagName: "span"; properties: Record<string, unknown>; children: [] }>;

/** remark-parse's options (micromark + mdast extensions) read from a processor's `data()`. */
export interface ParserOptions {
  extensions: unknown[];
  mdastExtensions: unknown[];
}
export declare function parserOptions(data: unknown): ParserOptions;

/** The subset of an mdast node the alt fix reads and writes. */
export interface AltNode {
  type: string;
  url?: string;
  alt?: string | null;
  label?: string | null;
  identifier?: string;
  children?: AltNode[];
  position?: unknown;
}
export declare function imageAltFromSource(source: string, node: AltNode, options?: Partial<ParserOptions>): string | undefined;
export declare function fixImageAlts(tree: AltNode, source: string | null | undefined, options?: Partial<ParserOptions>): void;
