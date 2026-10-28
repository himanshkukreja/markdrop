import type { Metadata } from "next";
import PersonalItems from "@/components/workspace/PersonalItems";

export const metadata: Metadata = {
  title: "Shared with me · Markdrop",
  robots: { index: false, follow: false },
};

/** Files people added you to by email, and access requests waiting on you. */
export default function SharedPage() {
  return <PersonalItems mode="shared" />;
}
