/**
 * Markdrop docs page editor.
 *
 *   import { DocsEditor } from "@/components/docs-editor";
 *   <DocsEditor value={markdown} onChange={setMarkdown} onUploadImage={upload} />
 *
 * Markdown (the docs engine's format: frontmatter, GFM, math, :::callouts, ::::steps, ::::tabs,
 * ::::cards, :::details, ::video/::clip/::embed/::api, :kbd[…]) in and out. The visual editor is
 * loaded lazily; this module itself is light.
 */
export { DocsEditor, preloadDocsEditor } from "./DocsEditor";
export type { DocsEditorProps, EditorMode, UploadImage, UploadImageInfo, ApiOperationOption } from "./types";
export { darkVariantPath } from "./host";
/** Frontmatter helpers for hosts that store title / description / icon separately from the body. */
export { splitFrontmatter, readFrontmatter, readMeta, writeFrontmatter } from "./core/frontmatter.mjs";
