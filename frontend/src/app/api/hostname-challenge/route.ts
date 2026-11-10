import { API_BASE } from "@/lib/api";
import { isPrimaryHost, normalizeHost } from "@/components/tenant/hosts";

/**
 * Cloudflare for SaaS hostname ownership, answered on a workspace's own domain while it is still served
 * here (before edge.markdrop.in moves to Cloudflare: backend services/cf_saas.py). The middleware sends
 * `/.well-known/cf-custom-hostname-challenge/<id>` on a customer host to this route; the API answers the
 * token Cloudflare gave for exactly that host and path, or 404. Never on Markdrop's own hosts.
 */
export const dynamic = "force-dynamic";

const PREFIX = "/.well-known/cf-custom-hostname-challenge/";
const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export async function GET(request: Request) {
  const host = normalizeHost(request.headers.get("host"));
  const path = new URL(request.url).searchParams.get("path") || "";
  if (!host || isPrimaryHost(host) || !path.startsWith(PREFIX) || path.length > 200) return NOT_FOUND();
  try {
    const res = await fetch(
      `${API_BASE}/api/v1/host/challenge?host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}`,
      { cache: "no-store", signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return NOT_FOUND();
    return new Response(await res.text(), {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  } catch {
    return NOT_FOUND();
  }
}
