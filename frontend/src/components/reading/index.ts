// The reading layer (REVAMP_PLAN 7.6, Phase 1). MarkdownPreview (components/MarkdownPreview.tsx)
// renders markdown with these pieces; viewers compose Toc / TocTicks / ReadingProgress around it.
export { Prose, type ProseProps, type ProseSize } from "./Prose";
export { CodeBlock, type CodeBlockProps } from "./CodeBlock";
export { DiagramFrame, diagramType, diagramTitle, mermaidThemeVariables, type DiagramFrameProps } from "./DiagramFrame";
export { HeadingAnchor, type HeadingAnchorProps } from "./HeadingAnchor";
export { Toc, type TocProps } from "./Toc";
export { TocTicks, type TocTicksProps } from "./TocTicks";
export { ReadingProgress, useReadingProgress, type ReadingProgressProps } from "./ReadingProgress";
export { ScrollBox, useOverflowFade, type ScrollBoxProps } from "./ScrollBox";
export { useActiveHeading } from "./useActiveHeading";
export {
  HEADING_ID_PREFIX,
  createSlugger,
  extractHeadings,
  extractHeadingsFromDom,
  headingSourceText,
  inlineText,
  rehypeHeadingIds,
  slugify,
  tocHeadings,
  type Heading,
  type HeadingIdsOptions,
} from "./slug";
export {
  SENSITIVE_HASH_KEYS,
  findHeadingTarget,
  isHashSensitive,
  navigateToHeading,
  scrollToInitialHash,
  sectionFragment,
  sectionUrl,
  setSectionHash,
  type HashWriteOptions,
  type NavigateOptions,
} from "./navigate";
