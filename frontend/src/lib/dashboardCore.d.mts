export type Column = "main" | "side";
export interface SettingField {
  kind: "count" | "enum" | "team" | "folder" | "page";
  label: string;
  default?: number | string | null;
  min?: number;
  max?: number;
  options?: string[];
  required?: boolean;
  empty?: string;
}
export interface CatalogEntry {
  type: string;
  label: string;
  description: string;
  icon: string;
  settings: Record<string, SettingField>;
  available: boolean;
}
export type WidgetSettings = Record<string, string | number | null | undefined>;
export interface Widget {
  id: string;
  type: string;
  settings: WidgetSettings;
  available?: boolean;
  note?: string;
  setup?: string;
  title?: string;
}
export interface Layout { main: Widget[]; side: Widget[] }
export const COLUMNS: readonly Column[];
export const MAX_WIDGETS: number;
export function locate(layout: Layout, id: string): { col: Column; index: number } | null;
export function count(layout: Layout): number;
export function other(col: Column): Column;
export function move(layout: Layout, id: string, dir: -1 | 1): Layout;
export function moveAcross(layout: Layout, id: string): Layout;
export function remove(layout: Layout, id: string): Layout;
export function newId(layout: Layout, rand?: () => number): string;
export function defaultSettings(entry: Pick<CatalogEntry, "settings"> | null | undefined): WidgetSettings;
export function add(layout: Layout, entry: Pick<CatalogEntry, "type" | "settings">, col?: Column, settings?: WidgetSettings, max?: number, rand?: () => number): Layout | null;
export function update(layout: Layout, id: string, settings: WidgetSettings): Layout;
export function toBody(layout: Layout): { main: Array<Pick<Widget, "id" | "type" | "settings">>; side: Array<Pick<Widget, "id" | "type" | "settings">> };
export function sameLayout(a: Layout, b: Layout): boolean;
export function stacked(layout: Layout): Array<Widget & { col: Column }>;
export function pickable(catalog: CatalogEntry[], layout: Layout, max?: number): Array<CatalogEntry & { disabled: boolean }>;
export function moves(layout: Layout, id: string): { up: boolean; down: boolean; across: Column | null };
