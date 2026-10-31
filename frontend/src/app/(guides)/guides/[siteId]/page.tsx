import type { Metadata } from "next";
import DocsEditorPage from "@/components/docs-sites/editor/EditorPage";

export const metadata: Metadata = { title: "Editor" };

/** The site's editor: page tree, the page (?page=<id>) in the visual editor, page settings and history. */
export default function Page() {
  return <DocsEditorPage />;
}
