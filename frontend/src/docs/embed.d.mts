/** Types for embed.mjs. */
export type EmbedMode = "live" | "preview" | "card";
export type EmbedRenderer = "html" | "bundle" | "pdf" | "sheet" | "docx" | "text" | "image" | "video" | "audio" | "doc" | "file";
export type EmbedState = "private" | "password" | "signin" | "encrypted" | "unavailable" | "unsupported" | "error" | "invalid";

export interface EmbedAttrs {
  src: string | null;
  slug: string | null;
  title: string | null;
  height: number | null;
  aspect: string | null;
  mode: EmbedMode;
  version: number | null;
  captions: string | null;
  chapters: string | null;
  errors: string[];
  warnings: string[];
}

/** GET /api/v1/embeds/{slug}: what the API says about a file (services/docs_embeds.py). */
export interface EmbedResolve {
  state: "ok" | Exclude<EmbedState, "error" | "invalid">;
  slug: string;
  url?: string;
  app?: string;
  kind?: "artifact" | "document";
  renderer?: string;
  title?: string | null;
  type_label?: string | null;
  filename?: string | null;
  size_bytes?: number | null;
  frame_url?: string | null;
  raw_url?: string | null;
  poster_url?: string | null;
  media?: { duration?: number | null; width?: number | null; height?: number | null } | null;
  version?: number | null;
  current_version?: number | null;
  pinned?: boolean;
  updated_at?: string | null;
  excerpt?: string | null;
  ref?: string | null;
}

interface ViewBase {
  slug: string | null;
  title: string | null;
  typeLabel: string | null;
  meta: string[];
  open: string | null;
  icon?: string;
  renderer?: EmbedRenderer;
  updatedAt?: string | null;
}
export type EmbedView =
  | (ViewBase & { type: "loading" })
  | (ViewBase & { type: "state"; state: EmbedState })
  | (ViewBase & { type: "frame"; src: string; sandbox: string; paper: boolean })
  | (ViewBase & { type: "video"; src: string; poster: string | null; w: number | null; h: number | null; duration: string | null })
  | (ViewBase & { type: "audio"; src: string })
  | (ViewBase & { type: "image"; src: string; w: number | null; h: number | null })
  | (ViewBase & { type: "card"; excerpt: string | null });

export declare const MARKDROP_HOSTS: string[];
export declare const EMBED_MODES: EmbedMode[];
export declare const SLUG_RE: RegExp;
export declare const SANDBOX: string;
export declare const MIN_HEIGHT: number;
export declare const MAX_HEIGHT: number;
export declare const DEFAULT_HEIGHT: Record<string, number>;
export declare const EMBED_ATTRS: string[];
export declare const KIND: Record<string, { label: string; icon: string }>;
export declare const STATES: Record<EmbedState, { title: string; body: string; open: boolean; retry?: boolean }>;
export declare function parseMarkdropSrc(src: unknown, extraHosts?: string[]): string | null;
export declare function markdropLink(slug: string, app?: string): string;
export declare function parseAspect(v: unknown): number | null;
export declare function vttPath(v: unknown): string | null;
export declare function embedAttrs(raw?: Record<string, unknown> | null, opts?: { label?: string | null; extraHosts?: string[] }): EmbedAttrs;
export declare function rendererOf(res: unknown): EmbedRenderer;
export declare function kindOf(renderer: string): { label: string; icon: string };
export declare function themedFrameSrc(url: string, theme?: string | null): string | null;
export declare function safeFrameUrl(url: unknown, allowedOrigin?: string | null): string | null;
export declare function formatBytes(n: unknown): string;
export declare function clock(sec: unknown): string;
export declare function frameHeight(attrs: Pick<EmbedAttrs, "height" | "aspect"> | null | undefined, renderer: string, width: number): number;
export declare function embedView(res: EmbedResolve | null, attrs: EmbedAttrs, opts?: { theme?: string | null; artifactOrigin?: string | null }): EmbedView;
export declare function embedPlainLine(attrs: { src?: string; title?: string; label?: string }): string | null;
