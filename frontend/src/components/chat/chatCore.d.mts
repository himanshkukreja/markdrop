export declare const DEFAULT_CITE: RegExp;
export declare function numberCitations(answer: string, tokens: string[], pattern?: RegExp): Map<string, number>;
export declare function linkCitations(answer: string, known: Set<string> | string[], pattern?: RegExp, streaming?: boolean): string;
export declare function plainAnswer(answer: string, citations: Array<{ token: string; title: string; subtitle?: string | null; meta?: string | null; href?: string | null }>, pattern?: RegExp): string;
export declare function revealStep(shown: number, total: number): number;
export declare function historyOf(turns: Array<{ state: string; question: string; answer: string }>, max?: number): Array<{ question: string; answer: string }>;
export declare function autoGrowHeight(scrollHeight: number, max?: number): number;
