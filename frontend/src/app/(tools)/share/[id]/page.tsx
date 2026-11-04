import type { Metadata } from "next";
import DownloadView from "./DownloadView";
import { TRANSFER_OG_IMAGE, ogCard } from "@/lib/og";

export const metadata: Metadata = {
  title: "File transfer — Markdrop",
  description: "Receive files sent with Markdrop, encrypted device to device.",
  // Override the site-wide card from the root layout: a send link shares
  // files, it does not render them, so it must not say "Drop it. It renders."
  ...ogCard("File transfer — Markdrop", "Receive files sent with Markdrop, encrypted device to device.", TRANSFER_OG_IMAGE),
};

export default async function ShareDownloadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DownloadView roomId={id} />;
}
