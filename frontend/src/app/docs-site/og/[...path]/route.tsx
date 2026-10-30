import { ImageResponse } from "next/og";
import { getAllPages, getChangelog, getPage, getSite, groupOf } from "@/docs/content";
import { formatDate } from "@/docs/outputs";
import { ogTheme } from "@/docs/brand";
import { ogLook } from "@/docs/themeSite";

/**
 * Open Graph cards (1200×630), one per page, the home (`/og/index`), the changelog and each entry.
 * Colours and mark from site.json `brand.og`: with `mark: "markdrop"` it is drawn like the app's
 * icon (apple-icon.tsx), the navy mark, the mono "m", the blue dot; otherwise just the site name.
 * A site with a theme gets its palette (ground, text, accent eyebrow), its corners on the mark, an
 * accent rule, and its initial on an accent tile when it has no mark (themeSite.ts ogLook).
 */
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return [
    { path: ["index"] },
    { path: ["changelog"] },
    ...getChangelog().entries.map((e) => ({ path: ["changelog", e.id] })),
    ...getAllPages().map((p) => ({ path: p.path.slice(1).split("/") })),
  ];
}

function card(eyebrow: string, title: string, body: string, foot: string) {
  const site = getSite();
  const og = ogTheme(site);
  const look = ogLook(site);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: "64px 72px", background: look.ground, color: look.text }}>
        {look.accent && <div style={{ position: "absolute", left: 0, top: 0, right: 0, height: 10, background: look.accent.fill }} />}
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          {og.mark === "markdrop" && (
            <div style={{ width: 64, height: 64, borderRadius: look.radius, background: og.ground, display: "flex", position: "relative" }}>
              <div style={{ position: "absolute", left: 6, top: 2, fontSize: 40, fontWeight: 700, color: "#f1f5f9", fontFamily: "monospace" }}>m</div>
              <div style={{ position: "absolute", left: 46, top: 32, width: 16, height: 16, borderRadius: 9999, background: og.dot }} />
            </div>
          )}
          {og.mark !== "markdrop" && look.accent && (
            <div style={{ width: 64, height: 64, borderRadius: look.radius, background: look.accent.fill, color: look.accent.on, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 36, fontWeight: 800 }}>
              {(site.brand?.name ?? site.name).trim().charAt(0).toUpperCase()}
            </div>
          )}
          <div style={{ fontSize: 30, fontWeight: 700, color: look.text }}>{site.name}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center", gap: 22 }}>
          {eyebrow && <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", color: look.eyebrow ?? og.eyebrow }}>{eyebrow}</div>}
          <div style={{ fontSize: title.length > 48 ? 58 : 68, fontWeight: 800, lineHeight: 1.08, letterSpacing: -1.5, maxWidth: 1040 }}>{title}</div>
          {body && <div style={{ fontSize: 28, lineHeight: 1.4, color: look.body, maxWidth: 1000 }}>{body.length > 150 ? body.slice(0, 147) + "…" : body}</div>}
        </div>
        <div style={{ display: "flex", fontSize: 24, color: look.foot }}>{foot}</div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const site = getSite();
  const host = site.url.replace(/^https?:\/\//, "");
  const p = "/" + path.join("/");
  if (p === "/index") return card("", site.headline ?? site.name, site.description, host);
  if (p === "/changelog") return card("Changelog", site.changelog?.title ?? "Changelog", site.changelog?.description ?? "", `${host}/changelog`);
  if (path[0] === "changelog" && path[1]) {
    const e = getChangelog().entries.find((x) => x.id === path[1]);
    if (e) return card(`Changelog · ${formatDate(e.date)}`, e.title, e.summary, `${host}/changelog/${e.id}`);
  }
  const page = getPage(p);
  if (!page) return new Response("Not found", { status: 404 });
  return card(groupOf(page.path)?.group ?? "", page.meta.title, page.meta.description, host + page.path);
}
