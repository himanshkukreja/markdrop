import { hasChangelog } from "@/docs/content";
import { changelogRss } from "@/docs/outputs";
import { notFoundText, textResponse } from "@/docs/http";

export const dynamic = "force-static";

export function GET() {
  if (!hasChangelog()) return notFoundText();
  return textResponse(changelogRss(), "application/rss+xml");
}
