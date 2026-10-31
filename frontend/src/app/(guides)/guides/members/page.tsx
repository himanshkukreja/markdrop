import type { Metadata } from "next";
import StudioMembers from "@/components/docs-sites/people/StudioMembers";

export const metadata: Metadata = { title: "Members" };

/** Guides › Members (?ws=<id>): a workspace's people and their Guides roles. */
export default function Page() {
  return <StudioMembers />;
}
