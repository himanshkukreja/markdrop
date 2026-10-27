/**
 * "Is this host us, or a customer's domain?" — one answer for the middleware (edge), the tenant
 * layout (server) and the handoff consumer (browser). A plain module with no runtime imports, so
 * every one of those can use it.
 */

/** Hosts that are *us*. Everything else is a customer domain. */
const PRIMARY_HOSTS = new Set(
  (process.env.NEXT_PUBLIC_PRIMARY_HOSTS || "markdrop.in,www.markdrop.in,localhost")
    .split(",")
    .map((h) => normalizeHost(h))
    .filter(Boolean),
);

/**
 * Lowercase, no port, no trailing dot: `Docs.Acme.com.:443` and `docs.acme.com` are one host.
 * Without the trailing-dot rule `docs.acme.com.` would be a "different" host to every string
 * compare below while DNS and the browser treat it as the same one.
 */
export function normalizeHost(raw: string | null | undefined): string {
  let h = (raw || "").trim().toLowerCase();
  if (h.startsWith("[")) return ""; // IPv6 literal: never a customer domain of ours
  h = h.split(":")[0];
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

export function isPrimaryHost(raw: string): boolean {
  const host = normalizeHost(raw);
  if (!host) return true;
  if (PRIMARY_HOSTS.has(host)) return true;
  // Vercel preview deployments get a generated hostname per build; treating
  // them as customer domains would make every preview 404.
  if (host.endsWith(".vercel.app")) return true;
  if (host === "127.0.0.1" || host === "localhost") return true;
  return false;
}

/** A syntactically plausible customer host (what may appear as `/h/<host>`). */
export function isPlausibleHost(host: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && host.length <= 253;
}

/** The request header the middleware sets on a tenant rewrite (overwriting any client value). */
export const TENANT_HOST_HEADER = "x-markdrop-tenant-host";
