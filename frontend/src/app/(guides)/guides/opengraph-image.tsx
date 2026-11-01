import { ImageResponse } from "next/og";

/**
 * The link preview for markdrop.in/guides (the Markdrop Guides landing page), drawn like the docs
 * site's cards (app/docs-site/og): the navy Markdrop mark, an eyebrow, the headline, one line, the
 * address. Static. Studio screens under /guides inherit it, but they're private and unindexed.
 */
export const dynamic = "force-static";
export const alt = "Markdrop Guides: docs that show you what to fix next. Free while in beta.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
  const rows: Array<{ k: string; t: string; n: string; hot?: boolean }> = [
    { k: "Readers leave here", t: "Install the CLI", n: "131 readers", hot: true },
    { k: "Searches with no results", t: "“proxy”", n: "48 searches" },
    { k: "Video drop-off", t: "Product tour at 0:40", n: "59 viewers" },
  ];
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", padding: "60px 64px", background: "#f8fafc", color: "#0f172a", fontFamily: "sans-serif" }}>
        <div style={{ position: "absolute", left: 0, top: 0, right: 0, height: 10, background: "#2563eb" }} />
        <div style={{ display: "flex", flexDirection: "column", width: 640 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ width: 56, height: 56, borderRadius: 14, background: "#0f172a", display: "flex", position: "relative" }}>
              <div style={{ position: "absolute", left: 6, top: 0, fontSize: 36, fontWeight: 700, color: "#f1f5f9", fontFamily: "monospace" }}>m</div>
              <div style={{ position: "absolute", left: 40, top: 28, width: 14, height: 14, borderRadius: 9999, background: "#3b82f6" }} />
            </div>
            <div style={{ fontSize: 30, fontWeight: 700 }}>Markdrop Guides</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center", gap: 22 }}>
            <div style={{ fontSize: 68, fontWeight: 800, lineHeight: 1.05, letterSpacing: -2 }}>Docs that show you what to fix next.</div>
            <div style={{ fontSize: 27, lineHeight: 1.4, color: "#475569" }}>Live demos, video and PDFs. Private pages. Free while in beta.</div>
          </div>
          <div style={{ display: "flex", fontSize: 24, color: "#64748b" }}>markdrop.in/guides</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", marginLeft: 40, width: 420 }}>
          <div style={{ display: "flex", flexDirection: "column", borderRadius: 24, background: "#ffffff", border: "2px solid #e2e8f0", padding: 22, gap: 14, boxShadow: "0 30px 60px -30px rgba(15,23,42,.35)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, fontWeight: 700 }}>
              <span>Fix list</span>
              <span style={{ color: "#64748b", fontWeight: 600 }}>3 to fix</span>
            </div>
            {rows.map((r) => (
              <div key={r.k} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "12px 14px", borderRadius: 14, background: r.hot ? "#eff6ff" : "#f8fafc" }}>
                <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#64748b" }}>{r.k}</span>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 20, fontWeight: 600 }}>
                  <span>{r.t}</span>
                  <span style={{ color: r.hot ? "#b91c1c" : "#b45309", fontSize: 17 }}>{r.n}</span>
                </div>
              </div>
            ))}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 46, borderRadius: 12, background: "#2563eb", color: "#ffffff", fontSize: 19, fontWeight: 700 }}>Draft a fix</div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
