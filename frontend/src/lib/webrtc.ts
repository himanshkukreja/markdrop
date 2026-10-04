/**
 * Used only if the signalling server never sends its `config` (an older
 * backend). The real list — STUN plus short-lived Cloudflare TURN credentials —
 * comes from the server, so the relay can change without redeploying clients.
 */
export const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

/**
 * Derive the WebSocket signalling URL from the configured API base URL.
 * e.g. https://api.markdrop.in → wss://api.markdrop.in/ws/share/<id>?role=host
 */
export function getWsUrl(roomId: string, role: "host" | "guest"): string {
  const apiBase =
    process.env.NEXT_PUBLIC_API_URL ?? "https://api.markdrop.in";
  const wsBase = apiBase
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://");
  return `${wsBase}/ws/share/${roomId}?role=${role}`;
}

/**
 * Encode share metadata into a single opaque base64url blob to fold into the
 * WebRTC signalling offer (field `x`). This lets the server record lightweight
 * usage metadata (filename, size, and the sharer's id when signed in) without
 * emitting an obviously-labelled "we're logging your file against your account"
 * frame — the network tab just shows protocol-noise-looking base64. The server
 * strips it before relaying the offer to the recipient. Obfuscation, not
 * encryption: it hides intent from a glance, not from a determined inspector.
 *
 * For several files `name`/`mime` describe the first and `size` is the total.
 */
export function encodeShareMeta(meta: {
  name: string;
  size: number;
  mime: string;
  token: string | null;
  count: number;
}): string {
  const payload = JSON.stringify({
    n: meta.name,
    s: meta.size,
    m: meta.mime,
    t: meta.token,
    c: meta.count,
  });
  // UTF-8 safe base64url (handles non-ASCII filenames)
  const bytes = new TextEncoder().encode(payload);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a 10-char hex room ID using the Web Crypto API. */
export function generateRoomId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 10);
}

/** Human-readable file size. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

/** Human-readable throughput, e.g. "12.4 MB/s". */
export function formatRate(bytesPerSecond: number): string {
  if (!isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "";
  return `${formatBytes(bytesPerSecond)}/s`;
}
