export interface AssetProbe {
  probe(url: string): Promise<boolean>;
  set(url: string, ok: boolean): void;
  readonly pending: number;
}
export function createProbe(load: (url: string) => Promise<boolean> | boolean, opts?: { concurrency?: number }): AssetProbe;
