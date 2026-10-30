import { absoluteUrl, agentMarkdown, getAllPages, getPage, getSite, homeMarkdown } from "@/docs/content";
import { markdownResponse } from "@/docs/http";

/** `<page>.md` and `Accept: text/markdown` on a page address (both rewritten here by the middleware). */
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return [{ path: ["index"] }, ...getAllPages().map((p) => ({ path: p.path.slice(1).split("/") }))];
}

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const p = "/" + path.join("/");
  if (p === "/index") return markdownResponse(homeMarkdown(), `${getSite().url}/`);
  const page = getPage(p);
  if (!page) return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return markdownResponse(agentMarkdown(page), absoluteUrl(page.path));
}
