import type { Metadata } from "next";
import AccountIntegrationClient from "./AccountIntegrationClient";

export const metadata: Metadata = {
  title: "Integration · Markdrop",
  robots: { index: false, follow: false },
};

export default async function IntegrationPage({ params }: { params: Promise<{ integration: string }> }) {
  const { integration } = await params;
  return <AccountIntegrationClient integration={integration} />;
}
