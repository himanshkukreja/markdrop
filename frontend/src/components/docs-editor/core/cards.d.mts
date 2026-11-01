import type { Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

export function cardAt(doc: PMNode, pos: number): { card: PMNode; grid: PMNode; gridPos: number; index: number } | null;
export function moveCard(tr: Transaction, from: number, gridPos: number, to: number): number | null;
export function stepCard(tr: Transaction, pos: number, dir: -1 | 1): number | null;
