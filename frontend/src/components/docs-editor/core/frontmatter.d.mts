export interface PageMeta {
  title: string;
  description: string;
  icon: string;
}

export function splitFrontmatter(markdown: string): { front: string; body: string };
export function readFrontmatter(front: string): Record<string, unknown>;
export function readMeta(front: string): PageMeta;
export function yamlScalar(value: string): string;
export function writeFrontmatter(front: string, patch: Record<string, string | null | undefined>, options?: { keep?: string[] }): string;
