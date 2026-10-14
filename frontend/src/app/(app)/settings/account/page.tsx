import type { Metadata } from "next";
import AccountClient from "./AccountClient";

export const metadata: Metadata = {
  title: "Account · Markdrop",
  robots: { index: false, follow: false },
};

export default function AccountSettingsPage() {
  return <AccountClient />;
}
