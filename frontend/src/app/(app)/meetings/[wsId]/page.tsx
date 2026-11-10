import type { Metadata } from "next";
import { parseSpace } from "@/lib/teams";
import MeetingsHub from "@/components/meetings/MeetingsHub";

type Props = { params: Promise<{ wsId: string }>; searchParams: Promise<{ space?: string }> };

export const metadata: Metadata = {
  title: "Meetings · Markdrop",
  robots: { index: false, follow: false },
};

/** A workspace's meetings: import a call, ask across them, open one (components/meetings). */
export default async function Page({ params, searchParams }: Props) {
  const { wsId } = await params;
  // Teams: ?space=team:<id> | project:<id> scopes it to that space (lib/teams); Company › Meetings is
  // ?space=company (company-wide meetings only), with "Show all I can open" (?space=all).
  const space = parseSpace((await searchParams).space);
  return <MeetingsHub key={space ?? ""} workspaceId={decodeURIComponent(wsId)} space={space} />;
}
