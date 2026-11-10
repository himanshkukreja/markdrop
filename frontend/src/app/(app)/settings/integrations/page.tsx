import type { Metadata } from "next";
import AccountIntegrationsClient from "./AccountIntegrationsClient";

export const metadata: Metadata = {
  title: "Integrations · Markdrop",
  robots: { index: false, follow: false },
};

export default function IntegrationsPage() {
  return <AccountIntegrationsClient />;
}
