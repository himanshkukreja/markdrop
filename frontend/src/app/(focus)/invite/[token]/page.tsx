import type { Metadata } from "next";
import InviteClient from "./InviteClient";

export const metadata: Metadata = {
  title: "Workspace invitation · Markdrop",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** /invite/[token] (REVAMP_PLAN 7.13). The token is a credential: no referrer leaves this page. */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <InviteClient token={token} />;
}
