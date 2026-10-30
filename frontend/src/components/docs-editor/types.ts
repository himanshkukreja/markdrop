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
  /** Accessible name of the editing area (default "Page content"). */
  "aria-label"?: string;
}
