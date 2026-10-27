import { tenantHostOf } from "@/components/tenant/assertHost";
import { resolveTenantHostQuietly } from "@/components/tenant/server";

/**
 * `/favicon.ico`, `/icon.svg` and `/apple-icon` on a workspace's own domain (the middleware
 * rewrites them here). The root layout's icon links are file-based, so they can't be overridden
 * per page; answering their URLs is the only way to keep Markdrop's mark off a customer's tab.
 * Redirects to the workspace's favicon (or logo); a 404 when it has neither — the browser then
 * shows its default icon, never ours. (A segment name with a dot can never be a slug or folder.)
 */
export const dynamic = "force-dynamic";

function httpsUrl(v: string | null | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ host: string }> }) {
  const { host: param } = await params;
  const host = await tenantHostOf(param);
  const resolved = host ? await resolveTenantHostQuietly(host) : null;
  const target = httpsUrl(resolved?.favicon_url) || httpsUrl(resolved?.logo_url);
  if (!target) {
    return new Response("Not found", { status: 404, headers: { "cache-control": "public, max-age=300" } });
  }
  return new Response(null, {
    status: 302,
    headers: { location: target, "cache-control": "public, max-age=3600" },
  });
}
