import type { AnyExtension, Extension, Mark, Node } from "@tiptap/core";
// The extensions' command typings (setHeading, toggleBulletList, insertTable…) come with their packages.
import type {} from "@tiptap/starter-kit";
import type {} from "@tiptap/extension-table";

export const Callout: Node;
export const Steps: Node;
export const Details: Node;
export const Tabs: Node;
export const Tab: Node;
export const Cards: Node;
export const Card: Node;
export const DirectiveLeaf: Node;
export const Figure: Node;
export const RawBlock: Node;
export const MathBlock: Node;
export const InlineImage: Node;
export const InlineMath: Node;
export const RawInline: Node;
export const Kbd: Mark;
export const InlineCode: Mark;
export const MarkdownAttrs: Extension;

export function baseExtensions(): AnyExtension[];
/** Replaces the named extensions by `ext.extend(overrides[name])`. */
export function withOverrides(extensions: AnyExtension[], overrides: Record<string, Record<string, unknown>>): AnyExtension[];
