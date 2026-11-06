import type { Metadata } from "next";
import PersonView from "@/components/team/PersonView";

type Props = { params: Promise<{ wsId: string; userId: string }> };

export const metadata: Metadata = {
  title: "Team · Markdrop",
  robots: { index: false, follow: false },
};

/** One person's Team page (components/team/PersonView). */
export default async function Page({ params }: Props) {
  const { wsId, userId } = await params;
  return <PersonView workspaceId={decodeURIComponent(wsId)} userId={decodeURIComponent(userId)} />;
}
