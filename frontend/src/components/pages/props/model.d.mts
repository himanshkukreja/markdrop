export type PropType = "select" | "multi_select" | "person" | "date" | "text" | "link" | "number" | "checkbox";
export type PropColor = "default" | "gray" | "brown" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "red";
export type FilterOp = "is" | "is_not" | "contains" | "not_contains" | "before" | "after" | "on_or_before" | "on_or_after" | "gt" | "lt" | "gte" | "lte" | "is_empty" | "is_not_empty";
export type PropValue = string | number | boolean | string[];

export interface PropOption {
  name: string;
  color: PropColor;
}
export interface PropDef {
  key: string;
  name: string;
  type: PropType;
  options?: PropOption[];
}
export interface ViewRule {
  key: string;
  op?: FilterOp;
  value?: string | number | boolean | null;
  dir?: "asc" | "desc";
}
export interface SavedView {
  id: string;
  name: string;
  type: "table" | "board";
  sort: Array<{ key: string; dir: "asc" | "desc" }>;
  filter: Array<{ key: string; op: FilterOp; value: string | number | boolean | null }>;
  group: string | null;
  hidden: string[];
  widths: Record<string, number>;
  order: string[];
}
export interface DbRow {
  slug: string;
  title: string;
  url: string;
  markdrop_url?: string;
  editor?: string | null;
  updated_at: string | null;
  created_at: string | null;
  rev: number;
  values: Record<string, PropValue>;
  can_edit: boolean;
  icon?: string | null;
  icon_url?: string | null;
}
export interface Person {
  name: string;
  avatar_url?: string | null;
}
export interface Group {
  id: string;
  label: string | null;
  value: PropValue | null;
  color: PropColor | null;
  rows: DbRow[];
}

export const TYPES: PropType[];
export const TYPE_LABELS: Record<PropType, string>;
export const COLORS: PropColor[];
export const FILTER_OPS: FilterOp[];
export const SPECIAL: string[];
export const MAX_PROPERTIES: number;
export const MAX_OPTIONS: number;
export const MAX_VIEWS: number;
export const RESERVED: Set<string>;
export const OP_LABELS: Record<FilterOp, string>;

export function readValues(markdown: string, opts?: { parseYaml?: (text: string) => unknown }): Record<string, PropValue>;
export function writeValues(markdown: string, patch: Record<string, PropValue | null | undefined>, opts?: { parseYaml?: (text: string) => unknown }): string;
export function jsonPy(v: unknown): string;
export function formatLine(values: Record<string, PropValue>): string;
export function keyFromName(name: string, taken?: Set<string>): string;
export function nextColor(options?: PropOption[] | null): PropColor;
export function findProp(schema: PropDef[], ref: string): PropDef | null;
export function optionColor(prop: PropDef | null | undefined, name: string): PropColor;
export function isSlug(v: unknown): boolean;
export function isUrl(v: unknown): boolean;
export function linkList(v: unknown): string[];
export function checkValue(prop: PropDef, v: unknown): string | null;
export function rowValue(row: DbRow, key: string): unknown;
export function matches(row: DbRow, rule: ViewRule, schema: PropDef[]): boolean;
export function sortRows(rows: DbRow[], sort: Array<{ key: string; dir?: "asc" | "desc" }>, schema: PropDef[], people?: Record<string, Person>): DbRow[];
export function applyView(rows: DbRow[], view: Pick<SavedView, "filter" | "sort"> | null | undefined, schema: PropDef[], people?: Record<string, Person>): DbRow[];
export function monthName(ym: string): string;
export function groupRows(rows: DbRow[], key: string, schema: PropDef[], people?: Record<string, Person>): Group[];
export function opsFor(type: PropType): FilterOp[];
export function newViewId(): string;
