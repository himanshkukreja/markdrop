import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "My files · Markdrop",
  robots: { index: false, follow: false },
};

export default function MyFilesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
