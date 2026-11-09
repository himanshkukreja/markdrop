import type { Metadata } from "next";
import { parseSpace } from "@/lib/teams";
import TeamBoard from "@/components/team/TeamBoard";

type Props = { params: Promise<{ wsId: string }>; searchParams: Promise<{ space?: string }> };

export const metadata: Metadata = {
  title: "Team · Markdrop",
  robots: { index: false, follow: false },
};

/** A workspace's Team board: who is doing what, from its meetings and pages (components/team). */
export default async function Page({ params, searchParams }: Props) {
  const { wsId } = await params;
  // Teams: ?space=team:<id> | project:<id> scopes it to that space (lib/teams).
  const space = parseSpace((await searchParams).space);
  return <TeamBoard key={space ?? ""} workspaceId={decodeURIComponent(wsId)} space={space === "company" || space === "all" ? undefined : space} />;
}
