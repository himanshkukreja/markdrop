/** Types for siteFiles.mjs (a docs site's own assets and redirects). */

export declare const ASSET_TYPES: Record<string, string>;
export declare function contentTypeOf(name: string): string;
export declare function isHashedName(name: string): boolean;
export declare const IMMUTABLE: string;
export declare const SHORT: string;
export declare function cacheControlOf(name: string): string;
export declare function resolveAsset(publicDir: string, segments: string[]): { file: string; size: number; mtimeMs: number } | null;
export declare function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null;
export declare function etagOf(size: number, mtimeMs: number): string;

export interface SiteRedirect {
  from: string;
  to: string;
}
export declare function expandRedirects(map: unknown): { redirects: SiteRedirect[]; problems: string[] };
export declare function readRedirects(contentDir: string): { redirects: SiteRedirect[]; problems: string[]; missing: boolean };
export declare function hostPattern(hosts: string[]): string;
export declare function escapeSource(p: string): string;
export declare function nextRedirects(
  contentDir: string,
  hosts: string[],
): Array<{ source: string; destination: string; permanent: true; has: Array<{ type: "host"; value: string }> }>;
export declare function docsHostsFromEnv(env?: Record<string, string | undefined>): string[];
export declare function hasSiteAssets(contentDir: string): boolean;
