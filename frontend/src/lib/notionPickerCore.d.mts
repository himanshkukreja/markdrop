export interface PickerItem {
  id: string;
  kind: "page" | "database" | "row";
  title: string;
  icon?: string | null;
  parent_id: string | null;
  parent_kind?: "page" | "database" | "row" | null;
  row_count?: number;
  url?: string | null;
  last_edited?: string | null;
}
export interface PickerNode extends PickerItem { children: PickerNode[]; rowsLoaded?: boolean }
export interface Selection { roots: Set<string>; excluded: Set<string> }
export interface PickerTree { roots: PickerNode[]; byId: Map<string, PickerNode>; parentOf: Map<string, string> }
export function emptySelection(): Selection;
export function buildTree(items: PickerItem[], rowsByDb?: Map<string, PickerItem[]> | Record<string, PickerItem[]>, rowParents?: Record<string, string>): PickerTree;
export function isUnder(id: string, anc: string, parentOf: Map<string, string>): boolean;
export function isOn(id: string, sel: Selection, parentOf: Map<string, string>): boolean;
export function isMixed(id: string, sel: Selection, parentOf: Map<string, string>): boolean;
export function toggle(id: string, sel: Selection, parentOf: Map<string, string>): Selection;
export function importBody(sel: Selection, byId: Map<string, PickerNode>): { pages: { id: string; kind: "page" | "database"; title: string }[]; exclude: string[] };
export function summary(sel: Selection, tree: PickerTree): { pages: number; databases: number; leftOut: number; text: string };
export function leavesOutRows(sel: Selection, byId: Map<string, PickerNode>): boolean;
