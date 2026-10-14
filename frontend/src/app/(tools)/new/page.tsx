import type { Metadata } from "next";
import NewEditor from "@/components/new/NewEditor";

export const metadata: Metadata = {
  title: "New document · Markdrop",
  description: "Write or paste markdown and publish it as a link that renders. No sign-in needed.",
};

/** /new: the editor is a client component; the route itself stays static (query input is read after mount). */
export default function NewDocumentPage() {
  return <NewEditor />;
}
