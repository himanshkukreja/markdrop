export const SLICES: number;
export const MIN_SECONDS: number;
export const MAX_SECTIONS: number;
export const MAX_COPIES: number;
export const MAX_VIDEOS: number;
export const REACH_LINE: number;

export interface ViewState {
  path: string;
  n: number;
  deepest: number;
  end: boolean;
  ids: (string | null)[];
  seconds: number;
  copies: [number, number][];
  videos: Map<string, { length: number; mask: number }>;
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
export function readBeacon(view: ViewState | null, rate?: unknown): ReadBeacon | null;
export function brokenBeacon(path: string, referrer: string | null | undefined, origin: string): BrokenBeacon | null;
