export type BacklogCategory = "feature" | "bug" | "improvement" | "task" | "follow_up" | "question";
export type BacklogStatus = "open" | "in_progress" | "done" | "wont_do";
export interface BacklogLine {
  block: string;
  category: BacklogCategory;
  done: boolean;
  text: string;
  status: BacklogStatus;
  company: string | null;
  owner: { id: string; name: string } | null;
  from: { title: string; href: string } | null;
  calls: number;
  firstSeen: string | null;
}
export interface BacklogFilter { category: string; status: string; company: string; owner: string; search: string; hideDone: boolean }
export const START: string;
export const CATEGORIES: ReadonlyArray<readonly [BacklogCategory, string]>;
export const STATUSES: ReadonlyArray<readonly [BacklogStatus, string]>;
export const EMPTY_FILTER: BacklogFilter;
export function splitMeta(s: string): string[];
export function parseItem(rest: string, done: boolean): Omit<BacklogLine, "block" | "category" | "done">;
export function parseBacklog(content: string | null | undefined): { items: BacklogLine[]; present: boolean };
export function filterFromQuery(search: string): BacklogFilter;
export function queryWithFilter(search: string, f: BacklogFilter): string;
export function isActive(f: BacklogFilter): boolean;
export function matches(it: BacklogLine, f: BacklogFilter, ignore?: keyof BacklogFilter | null): boolean;
export function categoryCounts(items: BacklogLine[], f: BacklogFilter): Record<BacklogCategory, number>;
export function choices(items: BacklogLine[]): { companies: string[]; owners: { id: string; name: string }[] };
export function hideCss(items: BacklogLine[], f: BacklogFilter): string;
export function toCsv(items: BacklogLine[], origin?: string): string;
export function toText(items: BacklogLine[]): string;
