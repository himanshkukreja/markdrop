import { revalidatePath } from "next/cache";

/**
 * Purge the cached render of one document.
 *
 * `/[slug]` is served from the data cache for 60 seconds, so an edit stays
 * invisible to fresh visitors for up to a minute. Harmless for a typo fix;
 * not harmless after rotating an encryption key, where that minute is a window
 * in which the *old* link still opens the document, because the cache is still
 * handing out the old ciphertext.
 *
 * Unauthenticated on purpose: it takes no content and reveals nothing — the
 * worst it can do is make us re-fetch a document from the API, which is exactly
 * what the 60-second expiry already does on its own.
 */
export async function POST(request: Request) {
  let slug: unknown;
  try {
    ({ slug } = await request.json());
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
  if (typeof slug !== "string" || !/^[A-Za-z0-9_-]{3,50}$/.test(slug)) {
    return Response.json({ ok: false }, { status: 400 });
  }
  revalidatePath(`/${slug}`);
  return Response.json({ ok: true });
}
