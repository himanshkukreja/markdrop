/**
 * The theme builder's live preview: the builder (LivePreview.tsx) hosts the studio's /theme-preview in
 * an iframe on the same origin and posts it the design on every change; the frame
 * (PreviewFrame.tsx) renders sample guide pages with the docs engine's own stylesheet, markup
 * classes and theme maths (theme.mjs themeCss / themeAttrs), so what it shows is what a published
 * guide looks like. Both sides check the message's origin.
 */

/** A studio path (lib/studioHost): guides.markdrop.in/theme-preview, /guides/theme-preview locally. */
export const PREVIEW_PATH = "/theme-preview";

export type PreviewPage = "home" | "article";

/** builder → frame */
export interface PreviewState {
  type: "guide-theme-preview:state";
  /** site.json `theme` and `brand` (lib/guideThemes.ts engineTheme). */
  theme: Record<string, unknown>;
  brand: { accent?: string; accentDark?: string; colors?: string[] };
  name: string;
  logo: string | null;
  dark: boolean;
  page: PreviewPage;
}

/** frame → builder: mounted and listening (the builder then sends the state). */
export interface PreviewReady {
  type: "guide-theme-preview:ready";
}

export function isPreviewState(d: unknown): d is PreviewState {
  return !!d && typeof d === "object" && (d as { type?: unknown }).type === "guide-theme-preview:state";
}

export function isPreviewReady(d: unknown): d is PreviewReady {
  return !!d && typeof d === "object" && (d as { type?: unknown }).type === "guide-theme-preview:ready";
}
