export const SLICES: number;
export const MIN_SECONDS: number;
export const MAX_SECTIONS: number;
export const MAX_COPIES: number;
export const MAX_VIDEOS: number;
export const REACH_LINE: number;
export const MAX_EMBEDS: number;
export const EMBED_EVENT: string;

/** What an embedded Markdrop file reports (the `md:embed-signal` CustomEvent's detail). */
export type EmbedSignal =
  | { id: string; kind: "video"; length: number; name?: string; mask?: number; from?: number; to?: number; quartile?: 1 | 2 | 3 | 4; seconds?: number }
  | { id: string; kind: "pdf"; pages: number; page: number; name?: string };

export type EmbedState =
  | { i: string; k: "video"; l: number; mask: number; q: number; s: number; name?: string }
  | { i: string; k: "pdf"; n: number; r: number; name?: string };

export interface ViewState {
  path: string;
  n: number;
  deepest: number;
  end: boolean;
  ids: (string | null)[];
  seconds: number;
  copies: [number, number][];
  videos: Map<string, { length: number; mask: number }>;
  embeds?: Map<string, EmbedState>;
}

export interface ReadBeacon {
  k: "read";
  p: string;
  n: number;
  d: number;
  t: number;
  w: number;
  h?: string;
  c?: [number, number][];
  v?: { i: string; l: number; b: string }[];
  e?: Record<string, unknown>[];
}

export interface BrokenBeacon {
  k: "broken";
  p: string;
  f?: string;
}

export function optedOut(nav: unknown, win?: unknown): boolean;
export function sampleRate(v: unknown): number;
export function sampled(rate: unknown, rand: number): boolean;
export function weightOf(rate: unknown): number;
export function deepestReached(tops: number[], height: number, line?: number): number;
export function sectionAt(headingYs: number[], y: number): number;
export function sliceOf(time: number, duration: number): number;
export function markPlayed(mask: number, from: number, to: number, duration: number): number;
export function maskHex(mask: number): string;
export function cleanId(v: unknown): string | null;
export function mergeEmbed(prev: EmbedState | undefined, d: unknown): EmbedState | undefined;
export function embedEntry(e: EmbedState | undefined): Record<string, unknown> | null;
export function readBeacon(view: ViewState | null, rate?: unknown): ReadBeacon | null;
export function brokenBeacon(path: string, referrer: string | null | undefined, origin: string): BrokenBeacon | null;
