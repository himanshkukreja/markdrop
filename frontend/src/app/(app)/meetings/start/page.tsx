import type { Metadata } from "next";
import MeetingsStart from "./MeetingsStart";

export const metadata: Metadata = {
  title: "Meetings · Markdrop",
  robots: { index: false, follow: false },
};

/**
 * /meetings/start: the landing's "Start with your team". Signs you in if needed, then opens your
 * first workspace's Meetings with the Connect Google Meet steps (lib/meetingsStart.ts). A static
 * segment, so it wins over /meetings/[wsId].
 */
export default function Page() {
  return <MeetingsStart />;
}
