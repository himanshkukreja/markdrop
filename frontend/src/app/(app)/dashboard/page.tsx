import type { Metadata } from "next";
import Home from "@/components/home/Home";

export const metadata: Metadata = {
  title: "Home · Markdrop",
  robots: { index: false, follow: false },
};

/** Home: what needs you, where you left off, your meetings and workspaces (components/home). */
export default function DashboardPage() {
  return <Home />;
}
