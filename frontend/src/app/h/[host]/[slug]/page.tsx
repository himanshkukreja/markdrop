import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getDocument, API_BASE } from "@/lib/api";
import { resolveAppHost } from "@/lib/hostResolution";
import ArtifactView from "@/app/[slug]/ArtifactView";
import DocumentView from "@/app/[slug]/DocumentView";
import MarkdropLoader from "@/components/MarkdropLoader";

/**
 * A document as served on a workspace's own domain.
 *
 * Reached only by rewrite from middleware, never linked: `/h/<host>/<slug>` is
 * what `cdn.acme.com/<slug>` becomes. Kept as its own route so `/[slug]` can
 * stay statically prerendered for markdrop.in — reading the host inside that
 * shared route would make it dynamic for every visitor.
 *
 * The views are the same components markdrop.in renders. Only the scope and the
 * branding differ, so tenant pages can never drift from the product.
 */

interface Props {
  params: Promise<{ host: string; slug: string }>;
}

/** Custom hosts are per-tenant and low volume, so they render on demand. */
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { host, slug } = await params;
  // resolveAppHost, not resolveHost: this runs independently of the page
  // component, so it must apply the kind check itself or it will describe a
  // document the page is about to refuse to serve.
  const resolved = await resolveAppHost(host);
  // Unbranded fallback rather than leaking "Markdrop" onto a host that has
  // explicitly asked not to show it.
  const siteName = resolved?.site_name || (resolved?.hide_markdrop_branding ? "" : "Markdrop");

  let pageTitle = slug;
  let description = siteName ? `A document on ${siteName}` : "Shared document";
  if (resolved) {
    try {
      const doc = await getDocument(slug, undefined, undefined, {
        revalidate: 60,
        workspaceScope: resolved.workspace_id,
      });
      if (!doc.encrypted) {
        pageTitle = doc.title || slug;
        const preview = doc.content.slice(0, 150).replace(/[#*_`]/g, "");
        if (preview) description = preview;
      }
    } catch {
      /* fall through to the generic card */
    }
  }

  const ogImage = `${API_BASE}/api/v1/og/${slug}.png`;
  const title = siteName ? `${pageTitle} — ${siteName}` : pageTitle;
  return {
    title,
    description,
    icons: resolved?.favicon_url ? [{ rel: "icon", url: resolved.favicon_url }] : undefined,
    openGraph: {
      title,
      description,
      type: "article",
      ...(siteName ? { siteName } : {}),
      images: [{ url: ogImage, width: 1200, height: 630, alt: pageTitle }],
    },
    twitter: { card: "summary_large_image", title, description, images: [ogImage] },
  };
}

export default async function TenantDocumentPage({ params }: Props) {
  const { host, slug } = await params;

  // Null for an unknown host, an unverified one, or one declared for artifacts.
  // Unknown or unverified must serve nothing, or pointing a CNAME at us would be
  // enough to browse the platform. A cdn-kind host has no document surface at
  // all: serving the app there would put the session on an origin that also
  // serves user-authored HTML, which is the one thing the architecture exists
  // to prevent.
  const resolved = await resolveAppHost(host);
  if (!resolved) notFound();

  let doc = null;
  let isPasswordProtected = false;
  try {
    doc = await getDocument(slug, undefined, undefined, {
      revalidate: 60,
      workspaceScope: resolved.workspace_id,
    });
  } catch (e) {
    if (e instanceof Error && e.message === "PASSWORD_REQUIRED") isPasswordProtected = true;
    else notFound();
  }

  if (doc?.kind === "artifact") {
    return (
      <Suspense fallback={<TenantFallback />}>
        <ArtifactView
          slug={slug}
          title={doc.title}
          url={`https://${host}/${slug}`}
          createdAt={doc.created_at}
          views={doc.views}
          isPasswordProtected={false}
          mime={doc.mime ?? "application/octet-stream"}
          renderer={doc.renderer ?? "download"}
          typeLabel={doc.type_label ?? "File"}
          sizeBytes={doc.size_bytes ?? 0}
          originalFilename={doc.original_filename ?? null}
          artifactUrl={doc.artifact_url ?? null}
          downloadUrl={doc.download_url ?? null}
        />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<TenantFallback />}>
      <DocumentView
        slug={slug}
        title={doc?.title ?? null}
        content={doc?.content ?? ""}
        url={`https://${host}/${slug}`}
        createdAt={doc?.created_at ?? new Date().toISOString()}
        expiresAt={doc?.expires_at ?? null}
        views={doc?.views}
        isPasswordProtected={isPasswordProtected}
        isOwned={doc?.is_owned ?? false}
        syncedWithVscode={doc?.vscode_synced ?? false}
        encrypted={doc?.encrypted ?? false}
      />
    </Suspense>
  );
}

function TenantFallback() {
  return (
    <div className="flex-1 min-h-[60vh] flex items-center justify-center">
      <MarkdropLoader label="Opening document…" />
    </div>
  );
}
