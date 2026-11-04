export const DEFAULT_LABEL: string;
export const DEFAULT_OPTIONS: string[];
export const MAX_OPTIONS: number;
export const MAX_OPTION_CHARS: number;
export const MAX_LABEL_CHARS: number;
export type SignoffTone = "success" | "danger" | "warning" | "neutral";
export interface SignoffInfo {
  id: string | null;
  person: string | null;
  label: string;
  options: string[];
  lock: boolean;
}
export function parseOptions(value: unknown): string[];
export function joinOptions(list: readonly string[] | null | undefined): string;
export function signoffInfo(attributes: Record<string, unknown> | null | undefined): SignoffInfo;
export function tone(option: string | null | undefined, options?: readonly string[]): SignoffTone | null;
