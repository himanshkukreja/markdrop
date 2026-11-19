// Per-request phase timings for the Server-Timing header (cloudflare/worker.ts). The Worker entry and the OpenNext
// bundle (open-next.config.ts overrides) are built separately, so they meet on globalThis: the Worker installs the
// recorder for each request (AsyncLocalStorage), the cache overrides call timing(). A no-op outside a request.
// Vercel ignores this file.

type Recorder = (name: string, ms: number) => void;
const KEY = "__mdTiming";

/** Adds `ms` to phase `name` of the current request (no-op when the Worker didn't install a recorder). */
export function timing(name: string, ms: number): void {
  const rec = (globalThis as Record<string, unknown>)[KEY] as Recorder | undefined;
  try {
    rec?.(name, ms);
  } catch {
    // timings never break a request
  }
}

export function installTiming(rec: Recorder): void {
  (globalThis as Record<string, unknown>)[KEY] = rec;
}

/** `edge;dur=3, asset;dur=12, app;dur=40` from the phases recorded (rounded ms). */
export function serverTiming(phases: Record<string, number>): string {
  return Object.entries(phases)
    .filter(([k]) => /^[a-z][a-z0-9-]*$/.test(k))
    .map(([k, v]) => `${k};dur=${Math.round(v)}`)
    .join(", ");
}
