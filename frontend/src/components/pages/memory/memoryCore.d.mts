export interface BlockLine { level: number | null; text: string }
export interface Section { heading: string | null; level: number | null; start: number; end: number; text: string }
export function sectionAround(blocks: BlockLine[], index: number): Section;
export function contentWords(text: string | null | undefined): string[];
export function sectionKey(p: { title?: string | null; heading?: string | null; selection?: string | null; q?: string | null }): string;
export function isMemoryQuestion(q: string | null | undefined): boolean;
export function shouldCheck(p: { words: number; decisions: number; key: string; checked?: Set<string>; budget: number }): boolean;
export function textHash(s: string | null | undefined): string;
