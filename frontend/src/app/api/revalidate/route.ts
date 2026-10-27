import { revalidatePath, revalidateTag } from "next/cache";

import { documentTag } from "@/lib/api";

/**
 * Purge cached renders. Called by the API's durable revalidate outbox
 * (`backend/app/services/revalidate.py`) after every access-affecting change.
 *
 * Two payloads:
 *
 *  - `{"slug": "<slug>"}` — one document: `revalidatePath("/<slug>")` plus the
 *    `doc:<slug>` tag, which also covers the same document rendered on a
 *    workspace's own domain (`components/tenant/server.ts` tags that fetch).
 *  - `{"tag": "<kind>:<id>"}` — one of the listing / host tags:
 *      `wsl:<workspaceId>`  folder listings on a workspace's domain
 *      `host:<host>`        host resolution + branding of a custom domain
 *      `share:<shareId>`    a shared folder page
 *
 * A malformed payload is a 400, which the outbox records as permanent rather
 * than retrying forever.
 *
 * Unauthenticated on purpose: it takes no content and reveals nothing — the
 * worst it can do is make us re-fetch from the API, which is exactly what the
 * 60-second expiry already does on its own.
 */
const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TAG_RE = /^(wsl|host|share):[A-Za-z0-9._:-]{1,200}$/;

export async function POST(request: Request) {
  let body: { slug?: unknown; tag?: unknown } | null;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
  const slug = body?.slug;
  const tag = body?.tag;
  if (typeof slug === "string" && SLUG_RE.test(slug)) {
    revalidatePath(`/${slug}`);
    revalidateTag(documentTag(slug));
    return Response.json({ ok: true });
  }
  if (typeof tag === "string" && TAG_RE.test(tag)) {
    revalidateTag(tag);
    return Response.json({ ok: true });
  }
  return Response.json({ ok: false }, { status: 400 });
}
