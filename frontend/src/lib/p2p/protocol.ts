/**
 * Wire protocol for peer-to-peer file share.
 *
 * Two layers:
 *
 *  - **Signalling** (WebSocket, relayed by api.markdrop.in): config, offer,
 *    answer, ice, plus server notices. Only enough to open a DataChannel.
 *  - **Transfer** (RTCDataChannel "file", peer to peer): JSON control messages
 *    as strings, file bytes as binary frames.
 *
 * Version 1 (single file, what the Go CLI speaks):
 *   host → meta {name,size,mimeType,isFolder?}   guest → start   host → bytes…
 *
 * Version 2 (many files, one session):
 *   host → manifest {files[]}          (re-sent whenever the list changes)
 *   guest → request {ids[]}            (queued by the host, sent in order)
 *   host → file-start {id} · bytes… · file-end {id}
 *   guest → ack {id}                   (only once the file is stored — this is
 *                                       what "Delivered" means on the sender)
 *   either → ping · other → pong       (liveness probe, see below)
 *
 * The guest advertises its version as `v` on its signalling `answer`. A peer that
 * says nothing is version 1, so an old CLI on either end still works: the sender
 * falls back to `meta` for it, and the receiver accepts `meta` from an old sender.
 *
 * Liveness: when the server says the other side's *signalling* went away, that
 * alone proves nothing — the WebSocket can drop while the data channel is fine.
 * But a peer that really vanished (tab killed, laptop shut) leaves the channel
 * looking open until ICE consent fails ~30 s later. So we ping over the channel
 * and treat silence — no message of any kind, chunks included — as gone.
 */

export const PROTOCOL_VERSION = 2;

/** 65535, not 65536: pion (the Go CLI's WebRTC stack) reads into a
 *  math.MaxUint16 buffer, and one byte more fails with "short buffer". */
export const CHUNK_SIZE = 65535;

/** Read the file this much at a time and slice chunks from memory — one
 *  async disk read per ~1 MiB instead of one per 64 KiB. */
export const READ_SIZE = 16 * CHUNK_SIZE;

/** Pause sending above this much queued in the channel, resume below LOW.
 *  Chrome closes a channel whose queue passes 16 MiB, so stay well clear,
 *  but keep enough in flight to fill a fast, high-latency path. */
export const BUFFER_HIGH = 8 * 1024 * 1024;
export const BUFFER_LOW = 2 * 1024 * 1024;

export interface ManifestFile {
  id: string;
  name: string;
  size: number;
  mime: string;
}

export type CandidateType = "host" | "srflx" | "prflx" | "relay";

// ── Transfer-layer messages ─────────────────────────────────────────────────

export type HostMessage =
  | { type: "meta"; name: string; size: number; mimeType: string; isFolder?: boolean }
  | { type: "manifest"; v: number; files: ManifestFile[] }
  | { type: "file-start"; id: string }
  | { type: "file-end"; id: string }
  | { type: "ping" }
  | { type: "pong" };

export type GuestMessage =
  | { type: "start" }
  | { type: "request"; ids: string[] }
  | { type: "ack"; id: string }
  | { type: "ping" }
  | { type: "pong" };

/** How long a peer may stay silent after a liveness ping before it's gone. */
export const PROBE_TIMEOUT_MS = 6_000;

export function parseControl<T>(data: unknown): T | null {
  if (typeof data !== "string") return null;
  try {
    const msg = JSON.parse(data);
    return msg && typeof msg.type === "string" ? (msg as T) : null;
  } catch {
    return null;
  }
}

// ── Failures, in words a person can act on ──────────────────────────────────

export type FailureReason =
  | "signalling"     // could not reach api.markdrop.in at all
  | "no-host"        // nobody is sharing on this link
  | "room-busy"      // someone else is already receiving
  | "ice"            // no network path between the two devices
  | "sender-left"
  | "recipient-left"
  | "old-peer"       // an old CLI that can't take several files
  | "transfer";      // channel broke mid-file

export const FAILURE_COPY: Record<FailureReason, { title: string; detail: string }> = {
  signalling: {
    title: "Can't reach Markdrop",
    detail: "Your connection to markdrop.in dropped. Check you're online and try again.",
  },
  "no-host": {
    title: "This link isn't active",
    detail: "Files are only available while the sender keeps their Markdrop tab open. Ask them to open it again or send a new link.",
  },
  "room-busy": {
    title: "Someone else is receiving right now",
    detail: "This link serves one recipient at a time. Try again once they're done, or ask the sender for a new link.",
  },
  ice: {
    title: "Couldn't connect the two devices",
    detail: "Neither a direct nor a relayed route worked. A VPN or a very strict network is the usual cause — try switching off the VPN or using another network.",
  },
  "sender-left": {
    title: "The sender closed Markdrop",
    detail: "Files stop being available when the sender's tab closes. Anything already saved is yours to keep.",
  },
  "recipient-left": {
    title: "The recipient left",
    detail: "They closed the page before everything arrived. Your link is still live — they can open it again.",
  },
  "old-peer": {
    title: "The recipient's CLI is out of date",
    detail: "It can only receive one file at a time. Ask them to update (brew upgrade markdrop), or send a single file.",
  },
  transfer: {
    title: "The transfer was interrupted",
    detail: "The connection dropped partway through. Files that finished are saved; open the link again to fetch the rest.",
  },
};
