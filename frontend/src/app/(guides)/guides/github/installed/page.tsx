import type { Metadata } from "next";
import GithubInstalled from "@/components/docs-sites/github/GithubInstalled";

export const metadata: Metadata = { title: "Connecting GitHub" };

/** Back from github.com (the Markdrop Guides app's setup URL and sign-in callback): finishes linking, then returns to Guides. */
export default function Page() {
  return <GithubInstalled />;
}
