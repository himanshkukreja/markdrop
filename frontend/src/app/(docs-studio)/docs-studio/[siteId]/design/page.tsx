import type { Metadata } from "next";
import DesignPanel from "@/components/docs-sites/DesignPanel";

export const metadata: Metadata = { title: "Design" };

/** Themes, Match my brand, fonts, colour mode, corners and custom CSS, with a live preview. */
export default function Page() {
  return <DesignPanel />;
}
