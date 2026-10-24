import type { Metadata } from "next";
import ConsentClient from "./ConsentClient";

export const metadata: Metadata = {
  title: "Connect an app · Markdrop",
  robots: { index: false, follow: false },
};

/**
 * The OAuth consent screen for Markdrop's MCP server. Static: the request id is read after mount
 * (useQueryFlags), never with useSearchParams. Framing is refused in next.config.ts (clickjacking).
 */
export default function ConsentPage() {
  return <ConsentClient />;
}
