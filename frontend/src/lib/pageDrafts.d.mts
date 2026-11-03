export interface PageDraft {
  title: string;
  content: string;
  rev: number | null;
  at: number;
  uid: string | null;
}
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined;
export const PAGE_DRAFT_PREFIX: string;
export function pageDraftKey(slug: string, userId: string | null | undefined): string;
export function readPageDraft(storage: DraftStorage, slug: string, userId: string | null | undefined): PageDraft | null;
export function writePageDraft(storage: DraftStorage, slug: string, userId: string | null | undefined, draft: { title?: string; content?: string; rev?: number | null; at?: number }): boolean;
export function clearPageDraft(storage: DraftStorage, slug: string, userId: string | null | undefined): void;
export function dropLegacyPageDraft(storage: DraftStorage, slug: string): void;
