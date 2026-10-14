import type { Metadata } from "next";
import CallbackClient from "./CallbackClient";

export const metadata: Metadata = {
  title: "Signing in · Markdrop",
  robots: { index: false, follow: false },
};

/** Where Google OAuth and magic links land: the session token arrives in the URL fragment. */
export default function AuthCallbackPage() {
  return <CallbackClient />;
}
