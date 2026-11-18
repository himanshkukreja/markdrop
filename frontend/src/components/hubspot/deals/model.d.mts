import type { DealBoard, DealCard } from "@/lib/hubspot";

export interface DealEntry { ws: string; wsName?: string | null; team?: string | null; board: DealBoard }
export type DealRow = DealCard & { ws: string; wsName: string | null; team: string | null };
export interface StageCol { label: string; closed: boolean }
export interface BoardColumn { key: string; label: string; closed: boolean; other?: boolean; deals: DealRow[] }
export interface DealFilters { team?: string; pipeline?: string; owner?: string; company?: string; quiet?: boolean; closed?: boolean }
export type SortKey = "name" | "company" | "stage" | "amount" | "owner" | "close" | "last" | "calls" | "team";

export const QUIET_DAYS: number;
export const CARD_LIMIT: number;
export const NO_COMPANY: string;
export const SORT_KEYS: SortKey[];
export function rowsOf(entries: DealEntry[]): DealRow[];
export function pipelinesOf(entries: DealEntry[]): string[];
export function stagesOf(entries: DealEntry[], pipeline?: string): StageCol[];
export function filterRows(rows: DealRow[], f: DealFilters): DealRow[];
export function ownersOf(rows: DealRow[]): string[];
export function companiesOf(rows: DealRow[]): string[];
export function byAmount(a: DealRow, b: DealRow): number;
export function columnsOf(stages: StageCol[], rows: DealRow[], showClosed: boolean): BoardColumn[];
export function visibleCount(n: number, expanded?: boolean, limit?: number): number;
export function callsLabel(n: number): string | null;
export function signalOf(d: Pick<DealCard, "closed" | "calls" | "days_quiet">): { kind: "none" | "quiet"; label: string } | null;
export function sortRows(rows: DealRow[], key?: SortKey, dir?: "asc" | "desc"): DealRow[];
export function summaryOf(rows: DealRow[]): { open: number; quiet: number; amount: number | null; currency: string | null; mixed: boolean };
export function groupByCompany(rows: DealRow[]): Array<[string, DealRow[]]>;
export function minutes(s: number | null | undefined): string | null;
