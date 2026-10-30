import type { Metadata } from "next";
import DocsEditorPage from "@/components/docs-sites/editor/EditorPage";

export const metadata: Metadata = {
  title: "Editor · Docs site · Markdrop",
  robots: { index: false, follow: false },
};

/** The site's editor (Editor board): page tree, the page (?page=<id>), page settings and history. */
export default function Page() {
  return <DocsEditorPage />;
}
