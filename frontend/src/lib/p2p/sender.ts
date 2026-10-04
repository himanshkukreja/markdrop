import { encodeShareMeta } from "@/lib/webrtc";
import { PeerLink } from "./peer";
import {
  BUFFER_HIGH,
  BUFFER_LOW,
  CHUNK_SIZE,
  PROBE_TIMEOUT_MS,
  READ_SIZE,
  parseControl,
  type FailureReason,
  type GuestMessage,
  type ManifestFile,
} from "./protocol";
import { SignalSocket } from "./signal";
import { ZIP_FOLDER, zipEntries, zipSize, zipStream } from "./zip";

export type SenderStatus =
  | "idle"          // nothing chosen yet
  | "waiting"       // link is live, nobody has opened it
  | "connecting"    // recipient opened it, ICE in progress
  | "connected"     // channel open — idle or transferring
  | "reconnecting"  // signalling dropped while nobody was connected
  | "failed";       // unrecoverable (server unreachable)

export type SenderFileStatus = "ready" | "queued" | "sending" | "delivered" | "unreadable";

export interface SenderFile {
  id: string;
  file: File;
  status: SenderFileStatus;
  sent: number;
}

export interface SenderSnapshot {
  status: SenderStatus;
  files: SenderFile[];
  /** Something worth telling the sender that doesn't end the session. */
  notice: FailureReason | null;
  /** Fatal reason when status is "failed". */
  failure: FailureReason | null;
  route: "direct" | "relay" | null;
  /** Bytes per second, smoothed. */
  rate: number;
  /** Recipients who have connected during this session. */
  recipients: number;
}

class Aborted extends Error {}

/**
 * One sharing session: a set of files, one link, any number of recipients one
 * after another. The link stays live until the sender ends it or closes the tab.
 */
export class ShareSender {
  private files: SenderFile[] = [];
  private nextId = 0;
  private status: SenderStatus = "idle";
  private notice: FailureReason | null = null;
  private failure: FailureReason | null = null;
  private route: "direct" | "relay" | null = null;
  private recipients = 0;

  private signal: SignalSocket;
  private iceServers: RTCIceServer[] | null = null;
  private link: PeerLink | null = null;
  private channel: RTCDataChannel | null = null;
  private guestVersion = 1;
  /** Files going to a version-1 peer as one auto-extracted archive. */
  private bundle: SenderFile[] | null = null;
  private lastRx = 0;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;

  private queue: string[] = [];
  private pumping = false;

  private rate = 0;
  private rateBase = 0;
  private rateAt = 0;
  private dirty = false;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private roomId: string,
    private opts: {
      onChange: (s: SenderSnapshot) => void;
      getToken: () => string | null;
      forceRelay?: boolean;
    },
  ) {
    this.signal = new SignalSocket(roomId, "host", {
      onMessage: (m) => void this.onSignal(m),
      onOpen: () => {
        if (this.status === "reconnecting") this.setStatus("waiting");
      },
      onRetrying: () => {
        if (!this.channelOpen) this.setStatus("reconnecting");
      },
      onUnreachable: () => this.fatal("signalling"),
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  addFiles(list: FileList | File[]): void {
    const added = Array.from(list)
      .filter((f) => !this.files.some((x) => sameFile(x.file, f)))
      .map((file) => ({ id: `f${this.nextId++}`, file, status: "ready" as const, sent: 0 }));
    if (!added.length) return;
    this.files = [...this.files, ...added];
    if (this.status === "idle") {
      this.setStatus("waiting");
      this.ticker = setInterval(() => this.tick(), 200);
      this.signal.connect();
    } else if (this.channelOpen && this.guestVersion >= 2) {
      this.sendManifest();
    }
    this.emit();
  }

  /** Only files the current recipient hasn't asked for can be withdrawn. */
  removeFile(id: string): void {
    const f = this.files.find((x) => x.id === id);
    if (!f || f.status === "queued" || f.status === "sending") return;
    this.files = this.files.filter((x) => x.id !== id);
    if (this.channelOpen && this.guestVersion >= 2) this.sendManifest();
    this.emit();
  }

  stop(): void {
    this.stopped = true;
    if (this.ticker) clearInterval(this.ticker);
    this.teardownPeer();
    this.signal.close();
  }

  // ── Signalling ────────────────────────────────────────────────────────────

  private get channelOpen(): boolean {
    return this.channel?.readyState === "open";
  }

  private async onSignal(msg: Record<string, unknown> & { type: string }) {
    switch (msg.type) {
      case "config":
        this.iceServers = (msg.iceServers as RTCIceServer[]) ?? null;
        break;
      case "guest-joined":
        // Sent for a new recipient, and again to a host whose signalling
        // reconnected while one was waiting. If we're already talking to
        // someone over an open channel, renegotiating would kill that transfer.
        if (!this.channelOpen) await this.startPeer();
        break;
      case "answer":
        this.guestVersion = typeof msg.v === "number" ? msg.v : 1;
        await this.link?.accept(msg.sdp as RTCSessionDescriptionInit);
        break;
      case "ice":
        await this.link?.addCandidate(msg.candidate as RTCIceCandidateInit);
        break;
      case "peer-disconnected":
        // The recipient's *signalling* went away. If the data channel is up
        // that is irrelevant — its own close event will tell us if they left.
        if (!this.channelOpen) {
          this.teardownPeer();
          this.setStatus("waiting");
        } else if (this.guestVersion >= 2) {
          this.probe();
        }
        break;
    }
  }

  private async startPeer() {
    this.teardownPeer();
    this.notice = null;
    this.route = null;
    this.setStatus("connecting");

    const link = new PeerLink({
      roomId: this.roomId,
      role: "host",
      iceServers: this.iceServers,
      forceRelay: this.opts.forceRelay,
      sendSignal: (m) => this.signal.send(m),
      onConnected: (route) => {
        if (this.link !== link) return;
        this.route = route && (route.local === "relay" || route.remote === "relay") ? "relay" : "direct";
        this.emit();
      },
      onFailed: () => {
        if (this.link !== link) return;
        // This recipient couldn't reach us; the link stays live for a retry.
        this.teardownPeer();
        this.notice = "ice";
        this.setStatus("waiting");
      },
      onLost: () => {
        if (this.link !== link) return;
        this.recipientGone("transfer");
      },
    });
    this.link = link;

    const channel = link.pc.createDataChannel("file", { ordered: true });
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = BUFFER_LOW;
    this.channel = channel;

    channel.onopen = () => {
      if (this.channel !== channel) return;
      this.recipients += 1;
      this.setStatus("connected");
      if (this.guestVersion >= 2) {
        this.sendManifest();
      } else if (this.files.length === 1) {
        // A version-1 peer (the Go CLI today): one file, the original protocol.
        const f = this.files[0].file;
        channel.send(JSON.stringify({
          type: "meta",
          name: f.name,
          size: f.size,
          mimeType: f.type || "application/octet-stream",
        }));
      } else {
        // Several files for a version-1 peer. It takes one file per
        // connection but unpacks one marked as a folder, so send an archive
        // it will extract — the person sees their files, never a zip.
        const files = this.files.slice();
        const size = zipSize(zipEntries(files.map((f) => f.file)));
        if (size === null) {
          this.teardownPeer();
          this.notice = "old-peer";
          this.setStatus("waiting");
          return;
        }
        this.bundle = files;
        channel.send(JSON.stringify({
          type: "meta",
          name: `${ZIP_FOLDER}.zip`,
          size,
          mimeType: "application/zip",
          isFolder: true,
        }));
      }
    };

    channel.onmessage = (e) => {
      if (this.channel !== channel) return;
      this.lastRx = performance.now();
      const msg = parseControl<GuestMessage>(e.data);
      if (!msg) return;
      if (msg.type === "ping") channel.send(JSON.stringify({ type: "pong" }));
      else if (msg.type === "request") this.enqueue(msg.ids);
      else if (msg.type === "start") {
        // v1: one file, or the bundle
        if (this.bundle) void this.sendBundle(channel, this.bundle);
        else this.enqueue([this.files[0]?.id]);
      }
      else if (msg.type === "ack") this.markDelivered(msg.id);
    };

    channel.onclose = () => {
      if (this.channel !== channel) return;
      this.recipientGone("recipient-left");
    };

    const total = this.files.reduce((n, f) => n + f.file.size, 0);
    const first = this.files[0]?.file;
    await link.offer({
      x: encodeShareMeta({
        name: first?.name ?? "",
        size: total,
        mime: first?.type || "application/octet-stream",
        token: this.opts.getToken(),
        count: this.files.length,
      }),
    });
  }

  /** Is the recipient still there, now that its signalling has gone? */
  private probe() {
    const channel = this.channel;
    if (!channel || this.probeTimer) return;
    const sentAt = performance.now();
    channel.send(JSON.stringify({ type: "ping" }));
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (this.channel === channel && this.lastRx < sentAt) this.recipientGone("recipient-left");
    }, PROBE_TIMEOUT_MS);
  }

  private recipientGone(reason: FailureReason) {
    const unfinished = this.files.some((f) => f.status === "queued" || f.status === "sending");
    this.teardownPeer();
    this.notice = unfinished ? reason : null;
    if (!this.stopped) this.setStatus(this.signal.isOpen ? "waiting" : "reconnecting");
  }

  private teardownPeer() {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = null;
    const ch = this.channel;
    this.channel = null;
    if (ch) {
      ch.onopen = ch.onmessage = ch.onclose = null;
      try { ch.close(); } catch { /* closed */ }
    }
    this.link?.close();
    this.link = null;
    this.guestVersion = 1;
    this.bundle = null;
    this.queue = [];
    // Anything not acknowledged goes back to ready for the next recipient.
    this.files = this.files.map((f) =>
      f.status === "delivered" ? f : { ...f, status: "ready", sent: 0 },
    );
  }

  private sendManifest() {
    const files: ManifestFile[] = this.files.map((f) => ({
      id: f.id,
      name: f.file.name,
      size: f.file.size,
      mime: f.file.type || "application/octet-stream",
    }));
    this.channel?.send(JSON.stringify({ type: "manifest", v: 2, files }));
  }

  // ── Transfer ──────────────────────────────────────────────────────────────

  private enqueue(ids: (string | undefined)[]) {
    for (const id of ids) {
      const f = this.files.find((x) => x.id === id);
      if (!f || f.status === "queued" || f.status === "sending") continue;
      // A recipient may re-request something it already has (re-download).
      f.status = "queued";
      f.sent = 0;
      this.queue.push(f.id);
    }
    this.emit();
    void this.pump();
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const channel = this.channel;
        const f = this.files.find((x) => x.id === this.queue[0]);
        this.queue.shift();
        if (!f || !channel) continue;
        const v2 = this.guestVersion >= 2;
        f.status = "sending";
        this.emit();
        if (v2) channel.send(JSON.stringify({ type: "file-start", id: f.id }));
        try {
          await this.stream(channel, f);
        } catch (e) {
          if (e instanceof Aborted) throw e;
          // The file went away or can't be read (moved, deleted, permission).
          // Close it off short — the receiver sees the size mismatch and marks
          // it interrupted — and carry on with the rest of the batch.
          f.status = "unreadable";
          if (v2 && channel.readyState === "open") {
            channel.send(JSON.stringify({ type: "file-end", id: f.id }));
          }
          this.emit();
          continue;
        }
        if (v2) {
          channel.send(JSON.stringify({ type: "file-end", id: f.id }));
        } else {
          // v1 receivers never acknowledge; delivered once our queue drains.
          await this.drained(channel, 0);
          this.markDelivered(f.id);
        }
      }
    } catch (e) {
      if (!(e instanceof Aborted)) throw e;
    } finally {
      this.pumping = false;
      // A new recipient's requests can arrive while the previous recipient's
      // loop is still unwinding; it would have returned early on `pumping`.
      if (this.queue.length && this.channelOpen) void this.pump();
    }
  }

  private async stream(channel: RTCDataChannel, f: SenderFile) {
    const file = f.file;
    let offset = 0;
    while (offset < file.size) {
      const block = await file.slice(offset, Math.min(offset + READ_SIZE, file.size)).arrayBuffer();
      await this.sendBuffer(channel, block, (n) => {
        f.sent += n;
        this.dirty = true;
      });
      offset += block.byteLength;
    }
  }

  /** Send a buffer as CHUNK_SIZE frames, pausing while the channel is full. */
  private async sendBuffer(channel: RTCDataChannel, block: ArrayBuffer, onSent?: (n: number) => void) {
    for (let i = 0; i < block.byteLength; i += CHUNK_SIZE) {
      if (this.channel !== channel || channel.readyState !== "open") throw new Aborted();
      if (channel.bufferedAmount > BUFFER_HIGH) await this.drained(channel, BUFFER_LOW);
      // A copied ArrayBuffer rather than a subarray view: every browser and
      // pion accept it, and 64 KB memcpy is noise next to the network.
      const chunk = block.slice(i, Math.min(i + CHUNK_SIZE, block.byteLength));
      channel.send(chunk);
      onSent?.(chunk.byteLength);
    }
  }

  /** Version-1 peer, several files: stream the archive announced in `meta`. */
  private async sendBundle(channel: RTCDataChannel, files: SenderFile[]) {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const f of files) {
        f.status = "queued";
        f.sent = 0;
      }
      this.emit();
      const entries = zipEntries(files.map((f) => f.file));
      for await (const buf of zipStream(entries, READ_SIZE, (i, n) => {
        files[i].status = "sending";
        files[i].sent += n;
        this.dirty = true;
      })) {
        await this.sendBuffer(channel, buf);
      }
      // v1 peers never acknowledge; delivered once the channel has drained.
      await this.drained(channel, 0);
      for (const f of files) this.markDelivered(f.id);
    } catch (e) {
      if (!(e instanceof Aborted)) throw e;
    } finally {
      this.pumping = false;
    }
  }

  private drained(channel: RTCDataChannel, level: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.channel !== channel || channel.readyState !== "open") {
          cleanup();
          reject(new Aborted());
        } else if (channel.bufferedAmount <= level) {
          cleanup();
          resolve();
        }
      };
      // bufferedamountlow fires at BUFFER_LOW; poll as well for level 0 and
      // for a channel that closes while we wait.
      const poll = setInterval(check, 50);
      const cleanup = () => {
        clearInterval(poll);
        channel.removeEventListener("bufferedamountlow", check);
      };
      channel.addEventListener("bufferedamountlow", check);
      check();
    });
  }

  private markDelivered(id: string) {
    const f = this.files.find((x) => x.id === id);
    if (!f) return;
    f.status = "delivered";
    f.sent = f.file.size;
    this.emit();
  }

  // ── State ─────────────────────────────────────────────────────────────────

  private fatal(reason: FailureReason) {
    this.failure = reason;
    this.teardownPeer();
    this.setStatus("failed");
  }

  private setStatus(s: SenderStatus) {
    this.status = s;
    this.emit();
  }

  private tick() {
    const now = performance.now();
    const sent = this.files.reduce((n, f) => n + (f.status === "sending" || f.status === "delivered" ? f.sent : 0), 0);
    if (this.rateAt) {
      const dt = (now - this.rateAt) / 1000;
      const inst = Math.max(0, sent - this.rateBase) / dt;
      const active = this.files.some((f) => f.status === "sending" || f.status === "queued");
      this.rate = active ? (this.rate ? this.rate * 0.6 + inst * 0.4 : inst) : 0;
    }
    this.rateBase = sent;
    this.rateAt = now;
    if (this.dirty) {
      this.dirty = false;
      this.emit();
    }
  }

  private emit() {
    this.opts.onChange({
      status: this.status,
      files: this.files.map((f) => ({ ...f })),
      notice: this.notice,
      failure: this.failure,
      route: this.route,
      rate: this.rate,
      recipients: this.recipients,
    });
  }
}

function sameFile(a: File, b: File) {
  return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
}
