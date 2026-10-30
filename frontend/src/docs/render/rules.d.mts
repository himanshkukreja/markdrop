/** Types for rules.mjs. */
export declare function hasWrapFlag(meta: string | null | undefined): boolean;
export declare function aliasesByTarget(anchors: Record<string, string> | undefined): Map<string, string[]>;
export declare function aliasNodes(
  aliases: Map<string, string[]>,
  id: string,
  taken: Set<string>,
): Array<{ type: "element"; tagName: "span"; properties: Record<string, unknown>; children: [] }>;
