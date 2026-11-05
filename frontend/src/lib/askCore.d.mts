export type AskSegment = { text: string; cite?: undefined; n?: undefined } | { cite: string; n: number; text?: undefined };
export interface AskMoment { label: string; moment: string | null; url: string | null; slug: string | null }
export interface AskSource {
  n: number; shown: number; title: string | null; url: string | null; kind: string | null; slug: string | null;
  task: string | null; moments: AskMoment[];
}
export interface AskCitationLike { label: string; title?: string | null; url?: string | null; kind?: string | null; slug?: string | null; moment?: string | null; text?: string | null }
export type AskBlock = { type: "p"; text: string } | { type: "ul"; items: string[] };
export function askSegments(answer: string | null | undefined, known: Iterable<string>): AskSegment[];
export function sourcesOf(answer: string | null | undefined, citations: AskCitationLike[] | null | undefined): AskSource[];
export function chipOf(sources: AskSource[], label: string): string;
export function blocksOf(text: string | null | undefined): AskBlock[];
export const SUGGESTION_ICONS: Record<string, string>;
export const STAGES: Record<string, string>;
