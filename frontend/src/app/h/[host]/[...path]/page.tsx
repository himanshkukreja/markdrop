import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getDocument, API_BASE } from "@/lib/api";
import { resolveAppHost } from "@/lib/hostResolution";
import ArtifactView from "@/app/[slug]/ArtifactView";
import DocumentView from "@/app/[slug]/DocumentView";
import MarkdropLoader from "@/components/MarkdropLoader";

/**
 * A document as served on a workspace's own domain.
 *
 * Reached only by rewrite from middleware, never linked: `/h/<host>/<path>` is
 * what `docs.acme.com/<path>` becomes.
 *
 * A catch-all rather than a single segment, because folders are part of the
 * address here: a document filed under Data/Reports answers at
 * `/data/reports/<slug>`. The last segment is always the slug — it is the
 * document's identity and is globally unique — and the segments before it must
 * match the folder path the document is actually filed under.
 *
 * A mismatch redirects to the canonical path rather than 404-ing. Filing a
 * document changes its address, and links to the old one are already out in the
 * world — someone who shared `/<slug>` before it was filed should not discover
 * that filing it quietly broke their link. So the slug remains the identity and
 * always resolves; the folder path is how the document is *addressed*, and any
 * other spelling of it is a redirect to the real one.
 *
 * Kept as its own route so `/[slug]` can
 * stay statically prerendered for markdrop.in — reading the host inside that
 * shared route would make it dynamic for every visitor.
 *
 * The views are the same components markdrop.in renders. Only the scope and the
 * branding differ, so tenant pages can never drift from the product.
 */

interface Props {
  params: Promise<{ host: string; path: string[] }>;
}

/** Custom hosts are per-tenant and low volume, so they render on demand. */
export const dynamic = "force-dynamic";

/** Split a tenant URL into its folder path and the document slug. */
function splitPath(path: string[]): { folders: string[]; slug: string } {
  const segments = (path || []).filter(Boolean);
  return { folders: segments.slice(0, -1), slug: segments[segments.length - 1] || "" };
}

/** Does this document actually live where the URL says it does? */
function pathMatches(doc: { folder_path?: string[] } | null, folders: string[]): boolean {
  const actual = doc?.folder_path ?? [];
  return actual.length === folders.length && actual.every((seg, i) => seg === folders[i]);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { host, path } = await params;
  const { slug } = splitPath(path);
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
  const { host, path } = await params;
  const { folders, slug } = splitPath(path);
  if (!slug) notFound();

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
  // Which gate the anonymous render hit. A private document with no password
  // must not be presented as "password protected" — there is no password to
  // type, and the reader is left with a box that can never open.
  let gate: "password" | "signin" | null = null;
  try {
    doc = await getDocument(slug, undefined, undefined, {
      revalidate: 60,
      workspaceScope: resolved.workspace_id,
    });
  } catch (e) {
    if (e instanceof Error && e.message === "PASSWORD_REQUIRED") {
      isPasswordProtected = true;
      gate = "password";
    } else if (e instanceof Error && e.message === "SIGNIN_REQUIRED") {
      isPasswordProtected = true;
      gate = "signin";
    } else notFound();
  }

  // A password prompt reveals nothing about filing, so it is allowed through on
  // any path. Everything else is served only at its canonical address, and any
  // other spelling is redirected there.
  //
  // Temporary (307), never permanent. A document's canonical path is whatever
  // folder it currently sits in, and refiling moves it. A 308 is cached by the
  // browser indefinitely, so a single redirect served from a not-yet-expired
  // render would pin the *old* path in that reader's browser for good — the
  // document would keep bouncing them to its previous home long after the
  // server had stopped saying so, with nothing we could do to take it back.
  if (doc && !pathMatches(doc, folders)) {
    const canonical = [...(doc.folder_path ?? []), slug].join("/");
    redirect(`/${canonical}`);
  }

  if (doc?.kind === "artifact") {
    return (
      <Suspense fallback={<TenantFallback />}>
        <ArtifactView
          slug={slug}
          title={doc.title}
          url={`https://${host}/${[...folders, slug].join("/")}`}
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
          viewerChrome={resolved.viewer_chrome}
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
        url={`https://${host}/${[...folders, slug].join("/")}`}
        createdAt={doc?.created_at ?? new Date().toISOString()}
        expiresAt={doc?.expires_at ?? null}
        views={doc?.views}
        isPasswordProtected={isPasswordProtected}
        gate={gate}
        isOwned={doc?.is_owned ?? false}
        syncedWithVscode={doc?.vscode_synced ?? false}
        encrypted={doc?.encrypted ?? false}
        viewerChrome={resolved.viewer_chrome}
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
