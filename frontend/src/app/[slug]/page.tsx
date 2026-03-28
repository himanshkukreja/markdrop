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
    const preview = doc.content.slice(0, 150).replace(/[#*_`]/g, "");
    return {
      title: `${slug} — Markdrop`,
      description: preview || "A document on Markdrop",
      openGraph: {
        title: `${slug} — Markdrop`,
        description: preview || "A document on Markdrop",
        type: "article",
      },
    };
  } catch {
    return { title: "Not Found — Markdrop" };
  }
}

export default async function SlugPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { new: isNew, secret } = await searchParams;

  let doc;
  try {
    doc = await getDocument(slug);
  } catch {
    notFound();
  }

  return (
    <DocumentView
      slug={doc.slug}
      content={doc.content}
      url={doc.url}
      createdAt={doc.created_at}
      isNew={isNew === "1"}
      editSecret={secret || undefined}
    />
  );
}
