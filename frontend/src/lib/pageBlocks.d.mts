export const SLUG_RE: RegExp;
export const PAGE_EMBED_MODES: readonly ["live", "preview", "card"];
export type PageEmbedMode = "live" | "preview" | "card";
export function embedSlug(src: unknown, extraHosts?: string[]): string | null;
export function embedMode(v: unknown): PageEmbedMode;
export function webEmbedUrl(src: unknown): string | null;
export function assetId(src: unknown): string | null;
export function pageRefs(markdown: string): { slugs: string[]; embeds: string[]; mentions: string[]; assets: string[] };
export interface LockedText {
  title: string;
  body: string;
  action: "signin" | "open" | null;
}
export const LOCKED: Record<"signin" | "denied" | "password" | "encrypted" | "missing", LockedText>;
export function lockedOf(state: string | null | undefined): LockedText;
export function refreshDelay(resolved: Record<string, { expires_at?: string | null } | null | undefined> | null | undefined, now?: number, margin?: number): number | null;
export function assetRefreshDelay(assets: Record<string, { expires_at?: string | null }> | null | undefined, now?: number, margin?: number): number | null;
export function pagePath(slug: string, opts?: { tenant?: boolean; folderPath?: string[]; ancestors?: string[] }): string;
export function fillTemplate(content: string, opts?: { title?: string; date?: Date | string }): string;
export function appendMarkdown(current: string, addition: string): string;
