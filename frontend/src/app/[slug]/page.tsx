import { getDocument } from "@/lib/api";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import DocumentView from "./DocumentView";

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ new?: string; secret?: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  try {
    const doc = await getDocument(slug);
    const pageTitle = doc.title || slug;
    const preview = doc.content.slice(0, 150).replace(/[#*_`]/g, "");
    return {
      title: `${pageTitle} — Markdrop`,
      description: preview || "A document on Markdrop",
      openGraph: {
        title: `${pageTitle} — Markdrop`,
        description: preview || "A document on Markdrop",
        type: "article",
      },
    };
  } catch {
    // Password-protected or not found — return generic metadata
    return {
      title: `${slug} — Markdrop`,
      description: "A document on Markdrop",
    };
  }
}

export default async function SlugPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { new: isNew, secret } = await searchParams;

  let doc = null;
  let isPasswordProtected = false;

  try {
    doc = await getDocument(slug);
  } catch (e) {
    if (e instanceof Error && e.message === "PASSWORD_REQUIRED") {
      isPasswordProtected = true;
    } else {
      notFound();
    }
  }

  return (
    <DocumentView
      slug={slug}
      title={doc?.title ?? null}
      content={doc?.content ?? ""}
      url={`https://markdrop.in/${slug}`}
      createdAt={doc?.created_at ?? new Date().toISOString()}
      expiresAt={doc?.expires_at ?? null}
      views={doc?.views}
      isNew={isNew === "1"}
      editSecret={secret || undefined}
      isPasswordProtected={isPasswordProtected}
    />
  );
}
