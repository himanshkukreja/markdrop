import type { Metadata } from "next";
import StudioHome from "@/components/docs-sites/StudioHome";

export const metadata: Metadata = { title: "Your docs sites" };

/** Every docs site you can open, across your workspaces and your personal ones (?ws= filters). */
export default function Page() {
  return <StudioHome />;
}
