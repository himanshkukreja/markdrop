import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { resolveAppHost } from "@/lib/hostResolution";
import { getTenantFolder } from "@/components/tenant/folderIndex";
import { TenantFolderIndex } from "@/components/tenant/TenantFolderIndex";
import { TenantHome } from "@/components/tenant/TenantHome";

/**
 * The root of a workspace's own domain (`docs.acme.com/` → `/h/docs.acme.com`). Before this
 * route existed the root fell through to markdrop.in's 404, Markdrop header and all, and the
 * tenant 404's "Go to {site name}" pointed at it.
 *
 * Lists the site's top level when the folder listing is available, otherwise names the site and
 * says how documents are opened. Never lists anything the API wouldn't show a signed-out reader.
 */
interface Props {
  params: Promise<{ host: string }>;
}

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { host } = await params;
  const resolved = await resolveAppHost(host);
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
  const { host } = await params;
  const resolved = await resolveAppHost(host);
  if (!resolved) notFound();
  const siteName = resolved.site_name?.trim() || host;

  const listing = await getTenantFolder(host, []);
  if (!listing) return <TenantHome siteName={siteName} />;
  return (
    <TenantFolderIndex
      siteName={siteName}
      folder={null}
      folders={listing.folders}
      documents={listing.documents}
      returnPath="/"
    />
  );
}
