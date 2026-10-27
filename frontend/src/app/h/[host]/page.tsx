import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { assertTenantHost, tenantHostOf } from "@/components/tenant/assertHost";
import { fetchTenantFolder, resolveTenantHost, resolveTenantHostQuietly } from "@/components/tenant/server";
import { TenantFolderPage } from "@/components/tenant/TenantFolderPage";

/**
 * The root of a workspace's own domain (`docs.acme.com/` → `/h/docs.acme.com`). Before this
 * route existed the root fell through to markdrop.in's 404, Markdrop header and all, and the
 * tenant 404's "Go to {site name}" pointed at it.
 *
 * Lists the site's top level (`GET /api/v1/host/folder`, path "") as a signed-out reader sees it;
 * a signed-in reader's browser re-asks with their token (TenantFolderPage). With nothing to list,
 * names the site and says how documents are opened. An API outage is the retryable error page,
 * never a 404.
 */
interface Props {
  params: Promise<{ host: string }>;
}

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { host: param } = await params;
  const host = await tenantHostOf(param);
  if (!host) return {};
  const resolved = await resolveTenantHostQuietly(host);
  const siteName = resolved?.site_name || host;
  // Every field set explicitly: anything left out inherits markdrop.in's title and description
  // from the root layout, which must not appear on a customer's domain.
  const description = `Documents from ${siteName}`;
  return {
    title: siteName,
    description,
    icons: resolved?.favicon_url ? [{ rel: "icon", url: resolved.favicon_url }] : undefined,
    openGraph: { title: siteName, description, type: "website", url: `https://${host}/`, siteName },
    twitter: { card: "summary", title: siteName, description },
  };
}

export default async function TenantRootPage({ params }: Props) {
  const { host: param } = await params;
  const host = await assertTenantHost(param);
  const resolved = await resolveTenantHost(host);
  if (!resolved) notFound();
  const siteName = resolved.site_name?.trim() || host;

  const listing = await fetchTenantFolder(host, [], resolved.workspace_id);
  return <TenantFolderPage host={host} siteName={siteName} path={[]} initial={listing} />;
}
