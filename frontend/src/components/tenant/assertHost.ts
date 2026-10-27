/**
 * SERVER ONLY. The `/h/<host>` param, if and only if it is the host this request was made to.
 *
 * `/h/<host>` must name the host the request actually arrived on (its Host header) AND the one
 * the middleware stamped on the rewrite (`x-markdrop-tenant-host`, overwritten on every tenant
 * request, so a client can't supply it). Anything else is a 404. Before this check,
 * `docs.acme.com/h/other-tenant.com/x` and `www.markdrop.in/h/other-tenant.com/x` rendered
 * another tenant's documents in its chrome.
 *
 * Called by the layout, every page and metadata function, and the icon route: they render
 * independently, and a guard in only one of them leaks (metadata fetched a document's title
 * while the layout was busy 404-ing).
 */

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { TENANT_HOST_HEADER, isPlausibleHost, isPrimaryHost, normalizeHost } from "./hosts";

/** The verified host, or null when the request isn't for it. Never throws. */
export async function tenantHostOf(param: string): Promise<string | null> {
  let host = "";
  try {
    host = normalizeHost(decodeURIComponent(param));
  } catch {
    return null;
  }
  const h = await headers();
  const requested = normalizeHost(h.get("host"));
  const stamped = normalizeHost(h.get(TENANT_HOST_HEADER));
  if (!host || !isPlausibleHost(host) || isPrimaryHost(host) || host !== requested || host !== stamped) {
    return null;
  }
  return host;
}

/** `tenantHostOf`, or notFound(). */
export async function assertTenantHost(param: string): Promise<string> {
  const host = await tenantHostOf(param);
  if (!host) notFound();
  return host;
}
