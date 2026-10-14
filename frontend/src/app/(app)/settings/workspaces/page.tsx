import type { Metadata } from "next";
import WorkspacesClient from "./WorkspacesClient";

export const metadata: Metadata = {
  title: "Workspaces · Markdrop",
  robots: { index: false, follow: false },
};

export default function WorkspacesPage() {
  return <WorkspacesClient />;
}
