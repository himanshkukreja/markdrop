export function readMeta(meta: string | null | undefined): { title: string; wrap: boolean };
export function setMetaTitle(meta: string | null | undefined, title: string): string | null;
export function setMetaWrap(meta: string | null | undefined, on: boolean): string | null;
export function labelText(label: string | null | undefined): string;
export function textLabel(text: string): string | null;
