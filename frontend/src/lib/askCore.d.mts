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

import type { AskSuggestions } from "./ask";
import type { ChatSuggestion } from "@/components/chat/types";
export function askHref(o?: { workspace?: string | null; mine?: boolean; thread?: string | null; q?: string | null }): string;
export function readAskParams(search: string | null | undefined): { workspace: string | null; mine: boolean; thread: string | null; q: string | null };
export function suggestionsOf(sug: AskSuggestions | null | undefined, max?: number): ChatSuggestion[];
export function homeChips(sug: AskSuggestions | null | undefined, max?: number): { label: string; question: string; team: boolean }[];
export function updatedLine(sug: AskSuggestions | null | undefined, now?: number): string;
