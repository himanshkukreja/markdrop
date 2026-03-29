import type { Metadata } from "next";
import DownloadView from "./DownloadView";

export const metadata: Metadata = {
  title: "File Transfer — Markdrop",
  description: "Receive a peer-to-peer file transfer via Markdrop",
};

export default async function ShareDownloadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DownloadView roomId={id} />;
}
