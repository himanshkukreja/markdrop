import type { Metadata } from "next";
import GithubSection from "@/components/docs-sites/settings/GithubSection";

export const metadata: Metadata = { title: "GitHub · Settings" };

/** Settings › GitHub: the repository the guide is imported from and kept in sync with, and its sync history. */
export default function Page() {
  return <GithubSection />;
}
