import type { Metadata } from "next";
import { parseSpace } from "@/lib/teams";
import { parseMeetingsTab } from "@/lib/meetings";
import MeetingsHub from "@/components/meetings/MeetingsHub";

type Props = { params: Promise<{ wsId: string }>; searchParams: Promise<{ space?: string; team?: string; tab?: string }> };

export const metadata: Metadata = {
  title: "Meetings · Markdrop",
  robots: { index: false, follow: false },
};

/** A workspace's meetings: import a call, ask across them, open one (components/meetings). */
export default async function Page({ params, searchParams }: Props) {
  const { wsId } = await params;
  const sp = await searchParams;
  // Teams: ?space=team:<id> | project:<id> is a team's Meetings section (lib/teams); ?space=all (or none) is every team's
  // (the sidebar's top-level Meetings) with a Team filter (?team=<id>); ?space=company is company-wide only (older links).
  // ?tab=review | customers | internal opens that tab.
  const space = parseSpace(sp.space);
  const team = typeof sp.team === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(sp.team) ? sp.team : null;
  return <MeetingsHub key={space ?? ""} workspaceId={decodeURIComponent(wsId)} space={space} team={team} tab={parseMeetingsTab(sp.tab)} />;
}
