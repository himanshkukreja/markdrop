/**
 * The builder's publish call: `createDocument` from lib/api (POST /api/v1/documents), with its
 * `ApiError` mapped to the states the publish dialog shows (429 countdown, offline, "link taken"
 * on the Link field, anything else as a message).
 */

import { ApiError, createDocument, type DocumentCreateResponse } from "@/lib/api";

export type PublishFailure =
  | { kind: "rate"; retryAfter: number | null }
  | { kind: "offline" }
  | { kind: "slug"; message: string }
  | { kind: "other"; message: string };

export class PublishError extends Error {
  constructor(public failure: PublishFailure) {
    super(failure.kind === "slug" || failure.kind === "other" ? failure.message : failure.kind);
  }
}

export type PublishOptions = NonNullable<Parameters<typeof createDocument>[2]>;

export async function publishDocument(title: string, content: string, options: PublishOptions = {}): Promise<DocumentCreateResponse> {
  try {
    return await createDocument(title, content, options);
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 429) throw new PublishError({ kind: "rate", retryAfter: err.retryAfter ? Math.min(Math.ceil(err.retryAfter), 3600) : null });
      if (err.status === 409) throw new PublishError({ kind: "slug", message: err.message || "That link is taken. Choose another." });
      if (err.status >= 500) throw new PublishError({ kind: "other", message: "Markdrop couldn't publish this right now. Try again in a minute." });
      throw new PublishError({ kind: "other", message: err.message || "Couldn't publish. Check the settings and try again." });
    }
    // fetch() itself rejected: no connection (or the API is unreachable).
    throw new PublishError({ kind: "offline" });
  }
}

export function failureOf(err: unknown): PublishFailure {
  if (err instanceof PublishError) return err.failure;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { kind: "offline" };
  return { kind: "other", message: err instanceof Error && err.message ? err.message : "Couldn't publish. Try again." };
}
