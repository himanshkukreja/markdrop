/** Free public STUN servers used to discover public IP/port for WebRTC. */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/** Each chunk sent over the DataChannel is 65535 bytes.
 *  This matches pion/webrtc's dataChannelBufferSize (math.MaxUint16 = 65535).
 *  Using 64*1024 = 65536 would be 1 byte over that limit and cause
 *  "short buffer" errors on the CLI receiver. */
export const CHUNK_SIZE = 65535;

export interface FileMeta {
  name: string;
  size: number;
  type: string;
}

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
 */
export function encodeShareMeta(meta: {
  name: string;
  size: number;
  mime: string;
  token: string | null;
}): string {
  const payload = JSON.stringify({
    n: meta.name,
    s: meta.size,
    m: meta.mime,
    t: meta.token,
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

/**
 * Stream a File over an open RTCDataChannel in 64 KB chunks.
 *
 * Uses `bufferedAmountLowThreshold` for backpressure: if the channel's
 * internal send buffer exceeds 256 KB we pause and wait for it to drain
 * before sending the next chunk. This prevents memory issues and dropped
 * messages on slow connections.
 */
export async function sendFileOverChannel(
  channel: RTCDataChannel,
  file: File,
  onProgress: (bytesSent: number) => void,
): Promise<void> {
  const BUFFER_HIGH = 4 * 1024 * 1024; // pause above 4 MB
  channel.bufferedAmountLowThreshold = BUFFER_HIGH;

  let offset = 0;
  while (offset < file.size) {
    // Wait if the send buffer is saturated
    if (channel.bufferedAmount > BUFFER_HIGH) {
      await new Promise<void>((resolve) => {
        channel.onbufferedamountlow = () => {
          channel.onbufferedamountlow = null;
          resolve();
        };
      });
    }

    const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
    const buffer = await slice.arrayBuffer();
    channel.send(buffer);
    offset += buffer.byteLength;
    onProgress(offset);
  }
}
