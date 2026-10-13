import type { Metadata } from "next";
import DownloadView from "./DownloadView";

export const metadata: Metadata = {
  title: "File transfer — Markdrop",
  description: "Receive files sent with Markdrop, encrypted device to device.",
  // Override the site-wide card from the root layout: a send link shares
  // files, it does not render them, so it must not say "Drop it. It renders."
  openGraph: {
    title: "File transfer — Markdrop",
    description: "Receive files sent with Markdrop, encrypted device to device.",
  },
  twitter: {
    card: "summary",
    title: "File transfer — Markdrop",
    description: "Receive files sent with Markdrop, encrypted device to device.",
  },
};

export default async function ShareDownloadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DownloadView roomId={id} />;
}
