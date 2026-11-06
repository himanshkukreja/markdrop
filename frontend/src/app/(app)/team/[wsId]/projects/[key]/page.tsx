import type { Metadata } from "next";
import ProjectView from "@/components/team/ProjectView";

type Props = { params: Promise<{ wsId: string; key: string }> };

export const metadata: Metadata = {
  title: "Team · Markdrop",
  robots: { index: false, follow: false },
};

/** A recurring project's Team page (components/team/ProjectView). */
export default async function Page({ params }: Props) {
  const { wsId, key } = await params;
  return <ProjectView workspaceId={decodeURIComponent(wsId)} projectKey={decodeURIComponent(key)} />;
}
