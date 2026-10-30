/** Types for present.mjs. */
export declare function looseText(s: string | undefined | null): string;
export declare function repeats(sentence: string | undefined | null, text: string | undefined | null): boolean;
export declare function pageLede(pages: { showDescription?: boolean } | undefined, description: string | undefined, intro: string | undefined): string | undefined;
export declare function heroLede(headline: string | undefined, description: string | undefined): string | undefined;
export declare function startCardText(
  entry: { title?: string; description?: string } | undefined,
  page: { title: string; description: string },
): { title: string; description: string };
