import { changelogMd } from "@/docs/outputs";
import { textResponse } from "@/docs/http";

export const dynamic = "force-static";

export function GET() {
  return textResponse(changelogMd(), "text/markdown");
}
