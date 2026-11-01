import type React from "react";

export type EditorMode = "visual" | "markdown";

/** What an image upload is for: the image itself, or the dark-theme version of an existing image. */
export interface UploadImageInfo {
  variant: "light" | "dark";
  /**
   * With `variant: "dark"`: the light image's address. The docs engine shows `x.dark.webp` in the
   * dark theme for `x.webp`, so the host should store the dark file at that address (see
   * `darkVariantPath`) and resolve with it.
   */
  for?: string;
}

/** Uploads an image and resolves with its public address (e.g. `/docs-assets/…` or https://…). */
export type UploadImage = (file: File, info: UploadImageInfo) => Promise<string | { url: string }>;

/** An OpenAPI operation the API endpoint block can point at: `op` is "METHOD /path". */
export interface ApiOperationOption {
  op: string;
  summary?: string;
}

/** What Ask AI can do with a selection. */
export type AssistAction = "improve" | "shorten" | "fix" | "translate";

export interface AssistRequest {
  action: AssistAction;
  /** The selection as Markdown. */
  text: string;
  /** For "translate": the language's name, as offered in `assistLanguages`. */
  language?: string;
}

/** Rewrites a selection: resolves with the suggested Markdown, or rejects with a message to show. */
export type AssistFn = (req: AssistRequest) => Promise<string>;

/** A comment's anchor in the text: what was selected and a little of what came before and after it. */
export interface TextAnchor {
  quote: string;
  prefix: string;
  suffix: string;
}

/** Something on the page to scroll to and select (the checks' Show, the outline). */
export type RevealTarget =
  | { kind: "link"; href: string }
  | { kind: "image"; src: string }
  /** The nth (0-based) heading whose text is `text` (any level when `level` is left out). */
  | { kind: "heading"; text: string; level?: number; nth?: number }
  | { kind: "quote"; quote: string; prefix?: string };

/** What a host can do to the editor from outside (both modes). */
export interface DocsEditorApi {
  /** Opens the Find and replace bar (with the selection as the search, when there is one). */
  openFind(): void;
  /** Scrolls to the target and selects it; false when it isn't on the page. */
  reveal(target: RevealTarget): boolean;
  /** Sets the description of every image with this address that has none; returns how many. */
  setImageAlt(src: string, alt: string): number;
  /** Removes headings with no text; returns how many. */
  removeEmptyHeadings(): number;
  /**
   * Offers `markdown` as a suggestion over one section (Visual mode): from the heading whose text
   * is `heading` (at `level`, when given) to the next heading of the same or a higher level, or the
   * introduction (everything before the first heading) when `heading` is null. Shown like Ask AI's
   * suggestions, Accept / Discard. False when the section isn't on the page or in Markdown mode.
   */
  suggest(s: { heading: string | null; level?: number; markdown: string; title: string; note?: string; onAccept?: () => void }): boolean;
  focus(): void;
}

export interface CommentMark {
  id: string;
  quote: string;
  prefix?: string;
  active?: boolean;
}

export interface DocsEditorProps {
  /** The page as Markdown (frontmatter included, if the page has one). */
  value: string;
  /** Called with the whole page as Markdown after every change (debounced ~120 ms while typing). */
  onChange: (markdown: string) => void;
  /** Controlled mode; leave out to let the editor keep its own (starts in "visual"). */
  mode?: EditorMode;
  onModeChange?: (mode: EditorMode) => void;
  /** Enables image upload (slash menu Image, drop and paste of image files, Replace, Dark version). */
  onUploadImage?: UploadImage;
  readOnly?: boolean;
  /** Shown in an empty page. */
  placeholder?: string;
  /** The icon / title / description header bound to the frontmatter (default true). */
  showHeader?: boolean;
  /** The Visual / Markdown switch above the editor (default true; hide it when the host renders one). */
  showModeSwitch?: boolean;
  /** Operations offered by the API endpoint block. */
  operations?: ApiOperationOption[];
  /**
   * Maps an image address from the Markdown to one the browser can load here (e.g. `/docs-assets/x.webp`
   * → the site's preview origin). Default: unchanged.
   */
  resolveAssetUrl?: (src: string) => string;
  autoFocus?: boolean;
  className?: string;
  /**
   * How much of the window's top the host's sticky bars cover, in px, read when the caret is
   * scrolled into view: the caret is kept below them. Default: nothing covers the top.
   */
  stickyTop?: () => number;
  /** Accessible name of the editing area (default "Page content"). */
  "aria-label"?: string;
  /** Shows the page icon picker in the header (default true; a host may offer it elsewhere). */
  headerIcon?: boolean;
  /** Rendered above the title, in line with it (a breadcrumb). */
  headerTop?: React.ReactNode;
  /** Receives the editor's API (Find, reveal, fixes). */
  apiRef?: React.Ref<DocsEditorApi | null>;
  /** Enables "Ask AI" in the format toolbar. */
  assist?: AssistFn;
  /** Languages offered by Ask AI › Translate. */
  assistLanguages?: string[];
  /** Enables "Comment" in the format toolbar: called with the selected text. */
  onComment?: (anchor: TextAnchor) => void;
  /** Review comments to highlight in the text (visual mode). */
  comments?: CommentMark[];
  /** A highlighted comment was clicked. */
  onCommentClick?: (id: string) => void;
  /** Flags a link whose target is a problem (wavy underline with the message as its tooltip). */
  checkLink?: (href: string) => { message: string } | null;
  /** Flags images without a description (default false). */
  flagImages?: boolean;
  /** The Find and replace bar was opened (analytics). */
  onFindOpen?: () => void;
}
