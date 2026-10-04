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
  | "live"          // link is live (with or without recipients)
  | "reconnecting"  // signalling dropped; recipients already connected carry on
  | "failed";       // unrecoverable (server unreachable)

export type RecipientState =
  | "connecting"    // opened the link, ICE in progress
  | "browsing"      // connected, hasn't asked for anything (yet)
  | "downloading"
  | "done"          // has everything it asked for
  | "left"
  | "failed";       // couldn't connect, or broke mid-transfer

export interface RecipientView {
  gid: string;
  /** "iPhone · Safari" once the recipient says hello; "Recipient 2" before. */
  label: string;
  state: RecipientState;
  route: "direct" | "relay" | null;
  filesDone: number;
  filesWanted: number;
  bytesDone: number;
  bytesWanted: number;
  currentName: string | null;
  rate: number;
  failure: FailureReason | null;
}

export interface SenderFileView {
  id: string;
  file: File;
  /** Recipients who have this file (acknowledged). */
  delivered: number;
  /** Recipients receiving it right now. */
  sending: number;
  /** Highest progress among those receiving it, 0..1. */
  progress: number;
  unreadable: boolean;
  /** Someone has it queued or in flight — can't be withdrawn. */
  busy: boolean;
}

export interface SenderSnapshot {
  status: SenderStatus;
  files: SenderFileView[];
  recipients: RecipientView[];
  failure: FailureReason | null;
  rate: number;
}

interface Entry {
  id: string;
  file: File;
}

interface Peer {
  gid: string;
  seq: number;
  label: string | null;
  link: PeerLink;
  channel: RTCDataChannel;
  version: number;
  state: RecipientState;
  failure: FailureReason | null;
  route: "direct" | "relay" | null;
  queue: string[];
  pumping: boolean;
  /** v1 peer, several files: the archive it was promised. */
  bundle: Entry[] | null;
  wanted: Set<string>;
  delivered: Set<string>;
  current: { id: string; sent: number; received: number | null } | null;
  lastRx: number;
  probeTimer: ReturnType<typeof setTimeout> | null;
  rate: number;
  rateBase: number;
}

class Aborted extends Error {}

/** Recipients who left or failed stay listed for context; only the latest few. */
const KEEP_GONE = 6;
const SOLO = "solo"; // an older server that doesn't assign guest ids

/**
 * One sharing session: a set of files, one link, any number of recipients at
 * once (the server caps it). Each recipient is its own peer connection with
 * its own queue, so a phone pulling three photos doesn't wait behind a laptop
 * pulling a video. The link stays live until the sender ends it or closes the tab.
 */
export class ShareSender {
  private files: Entry[] = [];
  private unreadable = new Set<string>();
  private nextId = 0;
  private status: SenderStatus = "idle";
  private failure: FailureReason | null = null;

  private signal: SignalSocket;
  private iceServers: RTCIceServer[] | null = null;
  private peers = new Map<string, Peer>();
  private gone: Peer[] = [];
  private seq = 0;

  private dirty = false;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private rateAt = 0;
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
        if (this.status === "reconnecting") this.setStatus("live");
      },
      onRetrying: () => {
        if (this.status === "live") this.setStatus("reconnecting");
      },
      onUnreachable: () => {
        this.failure = "signalling";
        this.setStatus("failed");
      },
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  addFiles(list: FileList | File[]): void {
    const added = Array.from(list)
      .filter((f) => !this.files.some((x) => sameFile(x.file, f)))
      .map((file) => ({ id: `f${this.nextId++}`, file }));
    if (!added.length) return;
    this.files = [...this.files, ...added];
    if (this.status === "idle") {
      this.setStatus("live");
      this.ticker = setInterval(() => this.tick(), 200);
      this.signal.connect();
    } else {
      for (const p of this.peers.values()) if (this.isOpen(p) && p.version >= 2) this.sendManifest(p);
    }
    this.emit();
  }

  /** Withdraw a file nobody is waiting on. */
  removeFile(id: string): void {
    for (const p of this.peers.values()) {
      if (p.queue.includes(id) || p.current?.id === id) return;
    }
    this.files = this.files.filter((x) => x.id !== id);
    this.unreadable.delete(id);
    for (const p of this.peers.values()) if (this.isOpen(p) && p.version >= 2) this.sendManifest(p);
    this.emit();
  }

  /** End the share and tell every recipient — connected or still connecting. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.ticker) clearInterval(this.ticker);
    for (const p of this.peers.values()) {
      if (this.isOpen(p) && p.version >= 2) {
        try { p.channel.send(JSON.stringify({ type: "bye" })); } catch { /* closing */ }
      }
    }
    this.signal.send({ type: "bye" });
    for (const p of [...this.peers.values()]) this.closePeer(p);
    this.peers.clear();
    this.signal.close();
  }

  // ── Signalling ────────────────────────────────────────────────────────────

  private isOpen(p: Peer): boolean {
    return p.channel.readyState === "open";
  }

  private async onSignal(msg: Record<string, unknown> & { type: string }) {
    const gid = typeof msg.gid === "string" ? msg.gid : SOLO;
    const peer = this.peers.get(gid);
    switch (msg.type) {
      case "config":
        this.iceServers = (msg.iceServers as RTCIceServer[]) ?? null;
        break;
      case "guest-joined":
        // Sent for a new recipient, and again for each waiting one when our
        // signalling reconnects. A recipient we already have an open channel
        // with must not be renegotiated — that would kill its transfer.
        if (peer && this.isOpen(peer)) break;
        if (peer) this.drop(peer, null);
        await this.startPeer(gid);
        break;
      case "answer":
        if (!peer) break;
        peer.version = typeof msg.v === "number" ? msg.v : 1;
        await peer.link.accept(msg.sdp as RTCSessionDescriptionInit);
        break;
      case "ice":
        await peer?.link.addCandidate(msg.candidate as RTCIceCandidateInit);
        break;
      case "peer-disconnected":
        // The recipient's *signalling* went away. With an open channel that
        // proves nothing — probe it. Without one, they're gone.
        if (!peer) break;
        if (!this.isOpen(peer)) this.drop(peer, null);
        else if (peer.version >= 2) this.probe(peer);
        break;
    }
  }

  private async startPeer(gid: string) {
    const link = new PeerLink({
      roomId: this.roomId,
      role: "host",
      iceServers: this.iceServers,
      forceRelay: this.opts.forceRelay,
      sendSignal: (m) => this.signal.send(gid === SOLO ? m : { ...m, gid }),
      onConnected: (route) => {
        const p = this.peers.get(gid);
        if (!p || p.link !== link) return;
        p.route = route && (route.local === "relay" || route.remote === "relay") ? "relay" : "direct";
        this.emit();
      },
      onFailed: () => {
        const p = this.peers.get(gid);
        if (p?.link === link) this.drop(p, "ice");
      },
      onLost: () => {
        const p = this.peers.get(gid);
        if (p?.link === link) this.drop(p, "transfer");
      },
    });

    const channel = link.pc.createDataChannel("file", { ordered: true });
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = BUFFER_LOW;

    const peer: Peer = {
      gid, seq: ++this.seq, label: null, link, channel, version: 1,
      state: "connecting", failure: null, route: null,
      queue: [], pumping: false, bundle: null,
      wanted: new Set(), delivered: new Set(), current: null,
      lastRx: 0, probeTimer: null, rate: 0, rateBase: 0,
    };
    this.peers.set(gid, peer);
    this.emit();

    channel.onopen = () => {
      if (this.peers.get(gid) !== peer) return;
      peer.state = "browsing";
      if (peer.version >= 2) {
        this.sendManifest(peer);
      } else if (this.files.length === 1) {
        // A version-1 peer (the Go CLI today): one file, the original protocol.
        const f = this.files[0].file;
        channel.send(JSON.stringify({
          type: "meta", name: f.name, size: f.size, mimeType: f.type || "application/octet-stream",
        }));
      } else {
        // Several files for a version-1 peer. It takes one file per
        // connection but unpacks one marked as a folder, so send an archive
        // it will extract — the person sees their files, never a zip.
        const files = this.files.slice();
        const size = zipSize(zipEntries(files.map((f) => f.file)));
        if (size === null) {
          this.drop(peer, "old-peer");
          return;
        }
        peer.bundle = files;
        channel.send(JSON.stringify({
          type: "meta", name: `${ZIP_FOLDER}.zip`, size, mimeType: "application/zip", isFolder: true,
        }));
      }
      this.emit();
    };

    channel.onmessage = (e) => {
      if (this.peers.get(gid) !== peer) return;
      peer.lastRx = performance.now();
      const msg = parseControl<GuestMessage>(e.data);
      if (!msg) return;
      switch (msg.type) {
        case "ping":
          channel.send(JSON.stringify({ type: "pong" }));
          break;
        case "hello":
          peer.label = String(msg.device ?? "").slice(0, 60) || null;
          this.emit();
          break;
        case "request":
          this.enqueue(peer, msg.ids);
          break;
        case "start": // v1: one file, or the bundle
          if (peer.bundle) void this.sendBundle(peer);
          else this.enqueue(peer, [this.files[0]?.id]);
          break;
        case "progress":
          if (peer.current?.id === msg.id) {
            peer.current.received = msg.received;
            this.dirty = true;
          }
          break;
        case "ack":
          this.markDelivered(peer, msg.id);
          break;
      }
    };

    channel.onclose = () => {
      if (this.peers.get(gid) === peer) {
        this.drop(peer, peer.state === "downloading" ? "transfer" : null);
      }
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
  private probe(p: Peer) {
    if (p.probeTimer) return;
    const sentAt = performance.now();
    p.channel.send(JSON.stringify({ type: "ping" }));
    p.probeTimer = setTimeout(() => {
      p.probeTimer = null;
      if (this.peers.get(p.gid) === p && p.lastRx < sentAt) {
        this.drop(p, p.state === "downloading" ? "transfer" : null);
      }
    }, PROBE_TIMEOUT_MS);
  }

  /**
   * Remove a recipient. `reason` null means they simply left. Keep them listed
   * (left / failed) if they ever connected or failed to — someone who opened
   * the link and closed it again before connecting isn't worth a row.
   */
  private drop(p: Peer, reason: FailureReason | null) {
    if (this.peers.get(p.gid) !== p) return;
    this.peers.delete(p.gid);
    const wasConnected = p.state !== "connecting";
    this.closePeer(p);
    p.state = reason ? "failed" : "left";
    p.failure = reason;
    p.current = null;
    p.queue = [];
    p.rate = 0;
    if (wasConnected || reason) this.gone = [p, ...this.gone].slice(0, KEEP_GONE);
    this.emit();
  }

  private closePeer(p: Peer) {
    if (p.probeTimer) clearTimeout(p.probeTimer);
    const ch = p.channel;
    ch.onopen = ch.onmessage = ch.onclose = null;
    try { ch.close(); } catch { /* closed */ }
    p.link.close();
  }

  private sendManifest(p: Peer) {
    const files: ManifestFile[] = this.files.map((f) => ({
      id: f.id,
      name: f.file.name,
      size: f.file.size,
      mime: f.file.type || "application/octet-stream",
    }));
    p.channel.send(JSON.stringify({ type: "manifest", v: 2, files }));
  }

  // ── Transfer ──────────────────────────────────────────────────────────────

  private enqueue(p: Peer, ids: (string | undefined)[]) {
    for (const id of ids) {
      if (!id || !this.files.some((f) => f.id === id)) continue;
      if (p.queue.includes(id) || p.current?.id === id) continue;
      // A recipient may ask again for something it already has (re-download).
      p.delivered.delete(id);
      p.wanted.add(id);
      p.queue.push(id);
    }
    if (p.queue.length) p.state = "downloading";
    this.emit();
    void this.pump(p);
  }

  private async pump(p: Peer) {
    if (p.pumping) return;
    p.pumping = true;
    try {
      while (p.queue.length && this.peers.get(p.gid) === p) {
        const id = p.queue.shift()!;
        const f = this.files.find((x) => x.id === id);
        if (!f) continue;
        const v2 = p.version >= 2;
        p.current = { id, sent: 0, received: null };
        this.emit();
        if (v2) p.channel.send(JSON.stringify({ type: "file-start", id }));
        try {
          await this.stream(p, f.file);
        } catch (e) {
          if (e instanceof Aborted) throw e;
          // The file went away or can't be read (moved, deleted, permission).
          // Close it off short — the receiver sees the size mismatch and marks
          // it interrupted — and carry on with the rest of the batch.
          this.unreadable.add(id);
          p.wanted.delete(id);
          p.current = null;
          if (v2 && this.isOpen(p)) p.channel.send(JSON.stringify({ type: "file-end", id }));
          this.settle(p);
          continue;
        }
        if (v2) {
          p.channel.send(JSON.stringify({ type: "file-end", id }));
        } else {
          // v1 receivers never acknowledge; delivered once our queue drains.
          await this.drained(p, 0);
          this.markDelivered(p, id);
        }
      }
    } catch (e) {
      if (!(e instanceof Aborted)) throw e;
    } finally {
      p.pumping = false;
    }
  }

  private async stream(p: Peer, file: File) {
    let offset = 0;
    while (offset < file.size) {
      const block = await file.slice(offset, Math.min(offset + READ_SIZE, file.size)).arrayBuffer();
      await this.sendBuffer(p, block, (n) => {
        if (p.current) p.current.sent += n;
        this.dirty = true;
      });
      offset += block.byteLength;
    }
  }

  /** Send a buffer as CHUNK_SIZE frames, pausing while the channel is full. */
  private async sendBuffer(p: Peer, block: ArrayBuffer, onSent?: (n: number) => void) {
    for (let i = 0; i < block.byteLength; i += CHUNK_SIZE) {
      if (this.peers.get(p.gid) !== p || !this.isOpen(p)) throw new Aborted();
      if (p.channel.bufferedAmount > BUFFER_HIGH) await this.drained(p, BUFFER_LOW);
      // A copied ArrayBuffer rather than a subarray view: every browser and
      // pion accept it, and 64 KB memcpy is noise next to the network.
      const chunk = block.slice(i, Math.min(i + CHUNK_SIZE, block.byteLength));
      p.channel.send(chunk);
      onSent?.(chunk.byteLength);
    }
  }

  /** Version-1 peer, several files: stream the archive announced in `meta`. */
  private async sendBundle(p: Peer) {
    if (p.pumping || !p.bundle) return;
    p.pumping = true;
    const files = p.bundle;
    try {
      p.state = "downloading";
      for (const f of files) p.wanted.add(f.id);
      this.emit();
      for await (const buf of zipStream(zipEntries(files.map((f) => f.file)), READ_SIZE, (i, n) => {
        const id = files[i].id;
        if (p.current?.id !== id) p.current = { id, sent: 0, received: null };
        p.current.sent += n;
        this.dirty = true;
      })) {
        await this.sendBuffer(p, buf);
      }
      // v1 peers never acknowledge; delivered once the channel has drained.
      await this.drained(p, 0);
      for (const f of files) p.delivered.add(f.id);
      p.current = null;
      this.settle(p);
    } catch (e) {
      if (!(e instanceof Aborted)) throw e;
    } finally {
      p.pumping = false;
    }
  }

  private drained(p: Peer, level: number): Promise<void> {
    const channel = p.channel;
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.peers.get(p.gid) !== p || channel.readyState !== "open") {
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

  private markDelivered(p: Peer, id: string) {
    p.delivered.add(id);
    if (p.current?.id === id) p.current = null;
    this.settle(p);
  }

  /** Done once nothing is queued or in flight and everything asked for arrived. */
  private settle(p: Peer) {
    if (!p.queue.length && !p.current && p.state === "downloading") {
      p.state = [...p.wanted].every((w) => p.delivered.has(w)) && p.wanted.size ? "done" : "browsing";
    }
    this.emit();
  }

  // ── State ─────────────────────────────────────────────────────────────────

  private setStatus(s: SenderStatus) {
    this.status = s;
    this.emit();
  }

  private size(id: string): number {
    return this.files.find((f) => f.id === id)?.file.size ?? 0;
  }

  private bytesDone(p: Peer): number {
    let n = 0;
    for (const id of p.wanted) if (p.delivered.has(id)) n += this.size(id);
    if (p.current) n += p.current.received ?? p.current.sent;
    return n;
  }

  private tick() {
    const now = performance.now();
    const dt = this.rateAt ? (now - this.rateAt) / 1000 : 0;
    this.rateAt = now;
    for (const p of this.peers.values()) {
      const done = this.bytesDone(p);
      if (dt > 0) {
        const inst = Math.max(0, done - p.rateBase) / dt;
        p.rate = p.state === "downloading" ? (p.rate ? p.rate * 0.6 + inst * 0.4 : inst) : 0;
      }
      p.rateBase = done;
    }
    if (this.dirty) {
      this.dirty = false;
      this.emit();
    }
  }

  private view(p: Peer): RecipientView {
    const wanted = [...p.wanted];
    return {
      gid: p.gid,
      label: p.label ?? `Recipient ${p.seq}`,
      state: p.state,
      route: p.route,
      filesDone: wanted.filter((id) => p.delivered.has(id)).length,
      filesWanted: wanted.length,
      bytesDone: this.bytesDone(p),
      bytesWanted: wanted.reduce((n, id) => n + this.size(id), 0),
      currentName: p.current ? this.files.find((f) => f.id === p.current!.id)?.file.name ?? null : null,
      rate: p.rate,
      failure: p.failure,
    };
  }

  private emit() {
    const live = [...this.peers.values()].sort((a, b) => a.seq - b.seq);
    const files: SenderFileView[] = this.files.map((f) => {
      let delivered = 0, sending = 0, progress = 0, busy = false;
      for (const p of [...live, ...this.gone]) if (p.delivered.has(f.id)) delivered++;
      for (const p of live) {
        if (p.current?.id === f.id) {
          sending++;
          busy = true;
          const got = p.current.received ?? p.current.sent;
          progress = Math.max(progress, f.file.size ? got / f.file.size : 1);
        } else if (p.queue.includes(f.id)) {
          busy = true;
        }
      }
      return {
        id: f.id, file: f.file, delivered, sending, progress: Math.min(1, progress),
        unreadable: this.unreadable.has(f.id), busy,
      };
    });
    this.opts.onChange({
      status: this.status,
      files,
      recipients: [...live, ...this.gone].map((p) => this.view(p)),
      failure: this.failure,
      rate: live.reduce((n, p) => n + p.rate, 0),
    });
  }
}

function sameFile(a: File, b: File) {
  return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
}
