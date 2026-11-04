import type { Metadata } from "next";
import MeetingsHub from "@/components/meetings/MeetingsHub";

type Props = { params: Promise<{ wsId: string }> };

export const metadata: Metadata = {
  title: "Meetings · Markdrop",
  robots: { index: false, follow: false },
};

/** A workspace's meetings: import a call, ask across them, open one (components/meetings). */
export default async function Page({ params }: Props) {
  const { wsId } = await params;
  return <MeetingsHub workspaceId={decodeURIComponent(wsId)} />;
}
