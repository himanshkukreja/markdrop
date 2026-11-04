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

/* ── AI (streaming): one interface, a page's and a guide's implementation ── */

/** What AI can do with a selection (Ask AI ✦ in the format toolbar). */
export type AiAction = "improve" | "shorten" | "fix" | "tone" | "translate" | "checklist" | "table" | "explain";
export type AiTone = "professional" | "friendly" | "concise";

export interface AiStreamOptions {
  /** Stop: aborts the request (the promise rejects with an AbortError). */
  signal: AbortSignal;
  /** Each piece of the answer as it arrives (Markdown). `reset`: replace what came so far. */
  onDelta: (text: string, reset?: boolean) => void;
}

/**
 * The editor's AI, implemented by its host (lib/pages-ai/client.ts: a page's endpoints or a
 * guide's). Every stream resolves with the whole answer (page Markdown) or rejects with an Error
 * whose message is a sentence to show (limits included); a stop rejects with name "AbortError".
 */
export interface EditorAi {
  /** Why AI can't be used here, shown in its menu instead of the actions ("AI is off for this workspace"). */
  off?: string | null;
  /** Languages Translate offers first (any other can be typed). */
  languages?: string[];
  transform(req: { action: AiAction; text: string; tone?: AiTone; lang?: string; before?: string; after?: string }, o: AiStreamOptions): Promise<string>;
  /** "/ai": a draft from a prompt, with the text around the caret as context. */
  write?(req: { prompt: string; before?: string; after?: string }, o: AiStreamOptions): Promise<string>;
  /** To-dos from the selection (or the whole page when `text` is left out). */
  actionItems?(req: { text?: string }, o: AiStreamOptions): Promise<string>;
  /** A `:::note[Summary]` callout for the top of the page. */
  summary?(o: AiStreamOptions): Promise<string>;
  /** A description for an image just uploaded (its address as written: `asset:<id>`, `/docs-assets/…`); null: none. */
  altText?(src: string): Promise<string | null>;
}

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

/* ── Markdrop files (::markdrop) ─────────────────────────────────────────── */

/** Why a guide's readers (signed out) can't see a file (the API's `reason`). */
export type MarkdropFileBlock = "private" | "signin" | "password" | "encrypted" | "unavailable";

/** One file in the picker (GET …/embeds/library). */
export interface MarkdropLibraryItem {
  slug: string;
  src: string;
  title: string;
  kind: "artifact" | "document";
  renderer: string;
  type_label: string;
  filename?: string | null;
  size_bytes?: number | null;
  updated_at?: string | null;
  public: boolean;
  reason: MarkdropFileBlock | null;
  embeddable: boolean;
}

export interface MarkdropLibraryPage {
  items: MarkdropLibraryItem[];
  total: number;
  page: number;
  pages: number;
  workspace: { id: string; name: string } | null;
}

/** What a link is, and whether the guide's readers can see it (POST …/embeds/check). */
export interface MarkdropFileInfo extends Omit<MarkdropLibraryItem, "embeddable"> {
  url: string;
  reason_text?: string | null;
  access_level: "private" | "link" | "workspace";
  has_password: boolean;
  workspace_name?: string | null;
  can_share: boolean;
  embeddable: boolean;
  can_pin: boolean;
  current_version: number | null;
  versions: Array<{ version: number; created_at?: string | null; size_bytes?: number | null; filename?: string | null; current: boolean }>;
  media?: { duration?: number | null; width?: number | null; height?: number | null } | null;
  poster_url?: string | null;
}

export type MarkdropLibraryType = "all" | "html" | "bundle" | "pdf" | "sheet" | "docx" | "video" | "image" | "doc";

/**
 * Enables the "Markdrop file" block's picker (your files, the guide's workspace, a pasted link,
 * an upload), its sharing check and version pins, and its live preview (`config`, the same as a
 * published page's, without analytics).
 */
export interface MarkdropFilesHost {
  config: { api: string; app: string; files: string | null; site: string; guide: string; extraHosts?: string[] };
  library(params: { scope: "mine" | "workspace"; q?: string; type?: MarkdropLibraryType; page?: number }): Promise<MarkdropLibraryPage>;
  check(src: string): Promise<MarkdropFileInfo>;
  /** "Anyone with the link can view" (the file's owner). */
  share(src: string): Promise<MarkdropFileInfo>;
  pin(src: string, version: number): Promise<{ version: number; current_version: number }>;
  /** Uploads a file to Markdrop (viewable by anyone with the link) and resolves with its info. */
  upload?(file: File, onProgress?: (pct: number) => void): Promise<MarkdropFileInfo>;
  /** The guide's workspace, for the picker's second tab (null for a personal guide). */
  workspaceName?: string | null;
  /** Accepted upload types (an <input accept>). */
  accept?: string;
  /** A block was added, replaced or removed (analytics). */
  onEvent?(name: "inserted" | "uploaded" | "shared" | "pinned", detail?: Record<string, unknown>): void;
}

/* ── Pages (a Markdrop document in the block editor) ─────────────────────── */

/** One item the page embed / mention picker offers. */
export interface PagePickItem {
  slug: string;
  title: string | null;
  kind: "markdown" | "artifact";
  renderer?: string | null;
  type_label?: string | null;
  mime?: string | null;
  updated_at?: string | null;
  encrypted?: boolean;
}

/** An embed or mention resolved for the person editing (the page's embeds endpoint). */
export interface PageResolvedItem {
  state: "ok" | "signin" | "denied" | "password" | "encrypted" | "missing";
  kind?: "document" | "artifact";
  renderer?: string;
  title?: string | null;
  url?: string | null;
  artifact_url?: string | null;
  viewer_url?: string | null;
  download_url?: string | null;
  poster_url?: string | null;
  expires_at?: string | null;
  preview?: { excerpt?: string | null; updated_at?: string | null; author_name?: string | null } | null;
}

/**
 * Hosts a page (a document, not a guide): `::markdrop{src=<slug> mode=…}` embeds and
 * `:markdrop[Title]{src=<slug>}` mentions get a picker over the author's documents and files and
 * their workspace's items, and a live preview resolved for the author.
 */
export interface PagesEditorHost {
  /** Search one source; `cursor` pages on (null: no more). */
  search(scope: "mine" | "workspace", q: string, cursor?: string | null): Promise<{ items: PagePickItem[]; cursor: string | null }>;
  /** The page's workspace (the picker's second tab), null for a personal page. */
  workspaceName?: string | null;
  /** Resolve slugs for the preview (batched by the caller). */
  resolve(slugs: string[]): Promise<Record<string, PageResolvedItem>>;
  /** Draws a resolved embed exactly as readers see it (the page renderer's component). */
  renderEmbed(p: { slug: string | null; mode: "live" | "preview" | "card"; label?: string | null; resolved: PageResolvedItem | null | undefined }): React.ReactNode;
  /** Draws a mention chip as readers see it. */
  renderMention(p: { slug: string | null; label?: string | null; resolved: PageResolvedItem | null | undefined }): React.ReactNode;
  /** A link's preview for a bookmark (title, description, image), fetched by the server. */
  linkPreview?(url: string): Promise<{ title?: string | null; description?: string | null; image_url?: string | null; site_name?: string | null; favicon_url?: string | null }>;
  /** Workspace members, for `@person`. */
  people?(q: string): Promise<Array<{ id: string; name: string; avatar_url?: string | null }>>;
  /** The page's sign-offs for this viewer (components/pages/signoff/store.ts): the blocks' state and the lock. */
  signoffs?: import("@/components/pages/signoff/store").SignoffStore | null;
  /** Uploads a video, audio or other file to Markdrop (beside the page) for a `::markdrop` embed. */
  uploadFile?(file: File, onProgress?: (pct: number) => void): Promise<{ slug: string; title?: string | null }>;
  /** Creates a sub-page of this page (the "/page" block); resolves with its slug and title. */
  createSubPage?(title: string): Promise<{ slug: string; title: string }>;
  /** This page's ancestors and title, for the breadcrumb block. */
  crumbs?: Array<{ slug: string; title: string | null }>;
  pageTitle?: string | null;
  /** A page's address (links in the breadcrumb and sub-page blocks). */
  href?(slug: string, ancestors: string[]): string;
}

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
  /**
   * Runs one of the editor's AI commands (needs `ai`; Visual mode): "summary" suggests a summary
   * callout at the top, "actions" the page's action items, "write" opens the "/ai" prompt at the
   * caret. False when it can't (Markdown mode, no AI, something else open).
   */
  runAi(command: "summary" | "actions" | "write"): boolean;
  focus(): void;
  /** The caret at the very start of the page, on an empty line (Enter in a page's title). */
  focusStart(): void;
  /** Adds an empty "Markdrop file" block at the caret (its picker opens); Markdown mode adds the line. */
  insertMarkdropFile(): void;
  /**
   * Adds Markdown at the end of the page without touching the rest (the caret, the selection and
   * undo stay): a page's live `appended` event (an AI app adding blocks while someone edits).
   */
  append(markdown: string): void;
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
  /** The guide's private-page rules, for a private section's picker. */
  accessRules?: Array<{ id: string; name: string; kind: string }>;
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
  /** Enables "Ask AI" in the format toolbar (non-streaming; `ai` replaces it when given). */
  assist?: AssistFn;
  /**
   * AI in the editor: Ask AI ✦ on a selection, "/ai" and Space on an empty line, ⌘/Ctrl J, Find
   * action items, Summarize, alt text for uploaded images. Leave out to show no AI at all.
   */
  ai?: EditorAi | null;
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
  /** Enables the "Markdrop file" block's picker, sharing check, version pins and live preview. */
  markdrop?: MarkdropFilesHost;
  /**
   * The "/" menu's blocks, by id (blocks.ts), in this order; default: every block. A page offers
   * PAGE_BLOCKS (no Guides-only blocks).
   */
  blocks?: readonly string[];
  /** A page: embeds and mentions of Markdrop items (replaces `markdrop` for the ::markdrop block). */
  pages?: PagesEditorHost;
  /** Images may have a dark-theme version (default true; a page's images don't). */
  darkImages?: boolean;
  /**
   * The Visual editor is ready (its TipTap editor), or gone (null: Markdown mode, unmount). A page
   * uses it to swap its server-rendered body for the editor without a flash, and for its phone
   * toolbar (undo, redo, format, the block menu).
   */
  onEditor?: (editor: import("@tiptap/react").Editor | null) => void;
}
