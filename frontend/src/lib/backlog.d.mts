export type BacklogCategory = "feature" | "bug" | "improvement" | "task" | "follow_up" | "question";
export type BacklogStatus = "open" | "in_progress" | "done" | "wont_do";
export type BacklogPriority = "urgent" | "high" | "medium" | "low";
export type BacklogGroup = "category" | "priority" | "month" | "company" | "owner";
export interface BacklogLine {
  block: string;
  category: BacklogCategory;
  done: boolean;
  text: string;
  status: BacklogStatus;
  priority: BacklogPriority;
  company: string | null;
  owner: { id: string; name: string } | null;
  from: { title: string; href: string } | null;
  calls: number;
  firstSeen: string | null;
  /** ISO days: first seen, and the latest call it came up in (else first seen). */
  firstDate: string | null;
  lastDate: string | null;
}
export interface BacklogFilter {
  category: string; status: string; company: string; owner: string; search: string; hideDone: boolean;
  priority: string[]; since: string; from: string; to: string; dateBy: "first" | "last"; group: BacklogGroup; items: string[];
}
export const START: string;
export const CATEGORIES: ReadonlyArray<readonly [BacklogCategory, string]>;
export const STATUSES: ReadonlyArray<readonly [BacklogStatus, string]>;
export const PRIORITIES: ReadonlyArray<readonly [BacklogPriority, string]>;
export const PRIORITY_LABEL: Record<BacklogPriority, string>;
export const DATE_RANGES: ReadonlyArray<readonly [string, string]>;
export const GROUPS: ReadonlyArray<readonly [BacklogGroup, string]>;
export const EMPTY_FILTER: BacklogFilter;
export function priorityKey(token: string): BacklogPriority | null;
export function parseDay(s: string | null | undefined, today?: Date): string | null;
export function splitMeta(s: string): string[];
export function parseItem(rest: string, done: boolean, today?: Date): Omit<BacklogLine, "block" | "category" | "done">;
export function parseBacklog(content: string | null | undefined, today?: Date): { items: BacklogLine[]; present: boolean };
export function filterFromQuery(search: string): BacklogFilter;
export function queryWithFilter(search: string, f: BacklogFilter): string;
export function isActive(f: BacklogFilter): boolean;
export function dateRange(f: BacklogFilter, today?: Date): [string | null, string | null];
export function matches(it: BacklogLine, f: BacklogFilter, ignore?: keyof BacklogFilter | null, today?: Date): boolean;
export function categoryCounts(items: BacklogLine[], f: BacklogFilter): Record<BacklogCategory, number>;
export function priorityCounts(items: BacklogLine[], f: BacklogFilter): Record<BacklogPriority, number>;
export function groupItems(items: BacklogLine[], by?: BacklogGroup, dateBy?: "first" | "last"): { key: string; label: string; items: BacklogLine[] }[];
export function choices(items: BacklogLine[]): { companies: string[]; owners: { id: string; name: string }[] };
export function hideCss(items: BacklogLine[], f: BacklogFilter): string;
export function toCsv(items: BacklogLine[], origin?: string): string;
export function toText(items: BacklogLine[]): string;
