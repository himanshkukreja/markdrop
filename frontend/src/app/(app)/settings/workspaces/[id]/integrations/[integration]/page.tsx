import type { Metadata } from "next";
import WorkspaceIntegrationClient from "./WorkspaceIntegrationClient";

export const metadata: Metadata = {
  title: "Integration · Workspace settings · Markdrop",
  robots: { index: false, follow: false },
};

export default async function WorkspaceIntegrationPage({ params }: { params: Promise<{ id: string; integration: string }> }) {
  const { id, integration } = await params;
  return <WorkspaceIntegrationClient id={id} integration={integration} />;
}
