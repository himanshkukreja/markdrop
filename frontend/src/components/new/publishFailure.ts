/**
 * What went wrong when /new tried to publish, in terms the page can act on (REVAMP_PLAN 7.3, 7.22).
 *
 * `createDocument` (lib/api) throws `new Error(detail)`, so the HTTP status is not on the error. The
 * cases are told apart by what each failure looks like:
 * - fetch itself rejects with a TypeError when the request never completes (offline, DNS, CORS on a
 *   dead origin); `navigator.onLine` then separates "you're offline" from "we're unreachable";
 * - the rate limiter (slowapi) answers 429 with `{"error": …}` and no `detail`, so the message is
 *   empty (or mentions a rate limit if a detail is ever added);
 * - a taken or reserved custom link is a 409 whose detail says so.
 * If lib/api starts attaching `status` / `retryAfter` to its errors, those win (forward compatible).
 */
import { TooLargeError } from "@/lib/e2e";

export type PublishFailure =
  | { kind: "slug-taken" }
  | { kind: "slug-reserved" }
  | { kind: "rate"; retryAfter: number | null }
  | { kind: "offline" }
  | { kind: "unreachable" }
  | { kind: "too-large"; message: string }
  | { kind: "other"; message: string };

function parseRetryAfter(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.min(Math.ceil(raw), 3600);
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.min(Math.ceil(n), 3600);
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) {
      const s = Math.ceil((at - Date.now()) / 1000);
      return s > 0 ? Math.min(s, 3600) : null;
    }
  }
  return null;
}

export function classifyPublishError(e: unknown): PublishFailure {
  if (e instanceof TooLargeError) return { kind: "too-large", message: e.message };
  if (e instanceof TypeError) {
    return typeof navigator !== "undefined" && navigator.onLine === false ? { kind: "offline" } : { kind: "unreachable" };
  }
  const err = e as { status?: unknown; retryAfter?: unknown; message?: unknown } | null;
  const status = typeof err?.status === "number" ? err.status : null;
  const message = typeof err?.message === "string" ? err.message.trim() : "";
  if (status === 429 || /rate limit|too many/i.test(message) || (status === null && e instanceof Error && message === "")) {
    return { kind: "rate", retryAfter: parseRetryAfter(err?.retryAfter) };
  }
  if (/already taken/i.test(message)) return { kind: "slug-taken" };
  if (/reserved/i.test(message)) return { kind: "slug-reserved" };
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { kind: "offline" };
  // A 422 from validation arrives as "[object Object]"; nobody can act on that.
  const usable = message && !message.startsWith("[object") ? message : "";
  return { kind: "other", message: usable };
}

/** The Link field's error for a server-side slug failure. */
export function slugFailureText(f: PublishFailure | null): string | undefined {
  if (f?.kind === "slug-taken") return "That link is taken. Pick another or leave it blank.";
  if (f?.kind === "slug-reserved") return "That link is reserved. Pick another or leave it blank.";
  return undefined;
}
