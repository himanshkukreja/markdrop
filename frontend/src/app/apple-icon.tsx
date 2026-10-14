import { ImageResponse } from "next/og";

// The design-system mark (D4) as the Apple touch icon: the navy pill, the "m" and the blue dot,
// drawn with the same proportions as app/icon.svg (32-unit grid scaled to 180). Logo colours are
// constant in both themes; the mark never inverts.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  const u = 180 / 32;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: "#0f172a" }}>
        <div
          style={{
            position: "absolute",
            left: 3 * u,
            top: 4 * u,
            fontSize: 18 * u,
            lineHeight: 1,
            fontWeight: 700,
            color: "#f1f5f9",
            fontFamily: "monospace",
          }}
        >
          m
        </div>
        <div
          style={{
            position: "absolute",
            left: (27 - 4) * u,
            top: (20 - 4) * u,
            width: 8 * u,
            height: 8 * u,
            borderRadius: 9999,
            background: "#3b82f6",
          }}
        />
      </div>
    ),
    size,
  );
}
