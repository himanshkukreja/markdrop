import { Suspense } from "react";
import { getDocument, ogImageUrl } from "@/lib/api";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import ArtifactView from "./ArtifactView";
import { MarkdropLoader } from "@/components/ui";
import DocumentView from "./DocumentView";
import { pageFieldsOf } from "./doc/types";

interface Props {
  params: Promise<{ slug: string }>;
}

// Serve the anonymous render from the edge and refresh it in the background.
// Safe because this render is always anonymous (localStorage — and therefore
// the auth header — doesn't exist server-side), the client re-fetches through
// the authorized path on mount, and open pages live-update over the socket.
// The ?new/?edit/?copy/?gsync flags are read from location.search after mount
// (see lib/useQueryFlags): reading searchParams here would force every request to
// render dynamically, and useSearchParams would stop the views being prerendered
// at all — which left the page shipping an empty <main> until hydration.
export const revalidate = 60;

// A dynamic segment only joins the full route cache when it declares
// generateStaticParams. Returning [] prerenders nothing at build time (slugs
// are created at runtime) while still letting each on-demand render be cached
// and background-revalidated, instead of re-rendering for every visitor.
export async function generateStaticParams() {
  return [];
}

/**
 * Safety net for the viewer boundaries. Nothing in them suspends today, now that
 * neither view calls useSearchParams — but `null` is the wrong default for a
 * boundary wrapping the entire page: it renders as app chrome around an empty
 * hole, which reads as broken rather than as loading.
 */
function ViewerFallback() {
  return (
    <div className="flex min-h-[60vh] flex-1 items-center justify-center">
      <MarkdropLoader label="Opening document" delay={300} />
    </div>
  );
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  // Dynamic link-preview card, rendered server-side by the backend. The endpoint
  // is content-safe (generic card for password-protected / unknown slugs), so we
  // advertise it in both metadata branches.
  // `v` busts link-preview caches for a redesigned card; `e` (the access epoch, `x` when the
  // anonymous reader can't open it) busts them when the document is narrowed.
  try {
    const doc = await getDocument(slug, undefined, undefined, { revalidate: 60 });
    const ogImage = ogImageUrl(slug, doc);
    const images = [{ url: ogImage, width: 1200, height: 630, alt: "Markdrop" }];
    // An encrypted document has no readable title or body on this side — its
    // `content` is an envelope and `title` is null. Slicing it would put base64
    // in a link preview and still say nothing.
    const pageTitle = doc.encrypted ? slug : doc.title || slug;
    const preview = doc.encrypted ? "" : doc.content.slice(0, 150).replace(/[#*_`]/g, "");
    const title = `${pageTitle} — Markdrop`;
    const description = doc.encrypted
      ? "An end-to-end encrypted document on Markdrop."
      : preview || "A document on Markdrop";
    return {
      title,
      description,
      openGraph: { title, description, type: "article", images },
      twitter: { card: "summary_large_image", title, description, images: [ogImage] },
    };
  } catch {
    // Password-protected or not found — generic metadata, still a rich card.
    const ogImage = ogImageUrl(slug, null);
    const images = [{ url: ogImage, width: 1200, height: 630, alt: "Markdrop" }];
    const title = `${slug} — Markdrop`;
    const description = "A document on Markdrop";
    return {
      title,
      description,
      openGraph: { title, description, type: "article", images },
      twitter: { card: "summary_large_image", title, description, images: [ogImage] },
    };
  }
}

export default async function SlugPage({ params }: Props) {
  const { slug } = await params;

  let doc = null;
  let isPasswordProtected = false;
  // Which gate the anonymous render hit. A private document with no password
  // must not be presented as "password protected" — there is no password to
  // type, and the reader is left with a box that can never open.
  let gate: "password" | "signin" | null = null;

  try {
    doc = await getDocument(slug, undefined, undefined, { revalidate: 60 });
  } catch (e) {
    if (e instanceof Error && e.message === "PASSWORD_REQUIRED") {
      isPasswordProtected = true;
      gate = "password";
    } else if (e instanceof Error && e.message === "SIGNIN_REQUIRED") {
      // Gated, but not by a password. The view still renders locked — a reader
      // who is already signed in may well have access, and the client retries
      // with their token before showing anyone a door.
      isPasswordProtected = true;
      gate = "signin";
    } else if (e instanceof Error && e.message === "Document not found") {
      notFound();
    } else {
      // F7: only a real 404 is "Nothing at this link". A 5xx or a network
      // failure throws, so app/error.tsx renders and ISR keeps serving the last
      // good copy instead of caching a 404 for a document that exists.
      throw e;
    }
  }

  // An old slug of a renamed document: 307 to the current one. (A gated document's old slug
  // 401s here like any other; the signed-in client retry redirects in useDocumentViewer.)
  if (doc?.moved && doc.slug && doc.slug !== slug) redirect(`/${encodeURIComponent(doc.slug)}`);

  // Artifacts render their file in a sandboxed iframe on the artifact origin
  // rather than as markdown, so they get their own viewer entirely.
  if (doc?.kind === "artifact") {
    return (
      <div className="contents">
      <Suspense fallback={<ViewerFallback />}>
      <ArtifactView
        slug={slug}
        title={doc.title}
        url={`https://markdrop.in/${slug}`}
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
        posterUrl={doc.poster_url ?? null}
        captionsUrl={doc.captions_url ?? null}
        docRef={doc.ref ?? null}
        readTicket={doc.read_ticket ?? null}
        track={doc.track ?? null}
        fileVersion={doc.file_version ?? null}
        workspaceId={doc.workspace_id ?? null}
        folderPath={doc.folder_path ?? []}
        domainUrl={doc.workspace_url ?? null}
      />
      </Suspense>
      </div>
    );
  }

  // A protected document 401s on the anonymous SSR fetch, so we can't yet tell
  // markdown from artifact. DocumentView handles the gate and re-renders once
  // it knows — see its `kind` check after unlock.
  // The page chrome (bar, gates, buttons) is part of a session recording; the document's own
  // content is blocked inside the views (ph-no-capture on the body, outline and lists,
  // ph-sensitive ph-mask on the title and names).
  // data-md-e2e: rendered by the server, so third-party analytics can see before loading anything
  // that this page is an encrypted document — even when it was opened without its #k= key — and an
  // encrypted document's page is blocked wholesale and never recorded.
  return (
    <div className="contents" data-md-e2e={doc?.encrypted ? "" : undefined}>
    <Suspense fallback={<ViewerFallback />}>
    <DocumentView
      slug={slug}
      title={doc?.title ?? null}
      content={doc?.content ?? ""}
      url={`https://markdrop.in/${slug}`}
      createdAt={doc?.created_at ?? new Date().toISOString()}
      expiresAt={doc?.expires_at ?? null}
      views={doc?.views}
      isPasswordProtected={isPasswordProtected}
      gate={gate}
      isOwned={doc?.is_owned ?? false}
      syncedWithVscode={doc?.vscode_synced ?? false}
      encrypted={doc?.encrypted ?? false}
      rev={doc?.rev ?? null}
      docRef={doc?.ref ?? null}
      readTicket={doc?.read_ticket ?? null}
      track={doc?.track ?? null}
      page={doc && !doc.encrypted ? pageFieldsOf(doc as unknown as Record<string, unknown>) : null}
      comments={doc?.comments ?? null}
    />
    </Suspense>
    </div>
  );
}
