export const SLUG_RE: RegExp;
export const RESERVED: Set<string>;
export function slugProblem(value: string): string | null;
export function cleanSlugInput(raw: string): string;
export function slugFromTitle(title: string | null | undefined): string;
export function splitLink(url: string): { host: string; folders: string[]; base: string; slug: string };
export function shortBase(base: string, max?: number): string;
