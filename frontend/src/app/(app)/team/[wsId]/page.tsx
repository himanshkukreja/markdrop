import type { Metadata } from "next";
import TeamBoard from "@/components/team/TeamBoard";

type Props = { params: Promise<{ wsId: string }> };

export const metadata: Metadata = {
  title: "Team · Markdrop",
  robots: { index: false, follow: false },
};

/** A workspace's Team board: who is doing what, from its meetings and pages (components/team). */
export default async function Page({ params }: Props) {
  const { wsId } = await params;
  return <TeamBoard workspaceId={decodeURIComponent(wsId)} />;
}
