import { PeerLink } from "./peer";
import {
  PROBE_TIMEOUT_MS,
  parseControl,
  type FailureReason,
  type HostMessage,
  type ManifestFile,
} from "./protocol";
import { CLOSE, SignalSocket } from "./signal";
import { deviceLabel } from "./device";

export type ReceiverStatus =
  | "connecting"        // finding the sender / ICE in progress
  | "sender-away"       // sender's signalling dropped before we connected; waiting for it
  | "ready"             // file list known
  | "failed";

export type ReceivedFileStatus = "available" | "requested" | "receiving" | "done" | "failed";

export interface ReceivedFile extends ManifestFile {
  status: ReceivedFileStatus;
  received: number;
  blob: Blob | null;
}

export interface ReceiverSnapshot {
  status: ReceiverStatus;
  files: ReceivedFile[];
  failure: FailureReason | null;
  route: "direct" | "relay" | null;
  rate: number;
  /** 1 = an old single-file sender (the Go CLI). */
  protocol: 1 | 2;
  /** True once ICE has been trying for a while — worth saying so. */
  slow: boolean;
}

/** How long to wait for a sender whose signalling dropped before we connected. */
const SENDER_GRACE_MS = 45_000;
const SLOW_AFTER_MS = 8_000;
const V1_ID = "v1";

/**
 * The receiving side of a share. Files arrive one at a time; each is
 * assembled, acknowledged, and handed to `onFileReady` so the page can save it
 * immediately — 200 photos never have to finish before the first is on disk.
 */
export class ShareReceiver {
  private files: ReceivedFile[] = [];
  private status: ReceiverStatus = "connecting";
  private failure: FailureReason | null = null;
  private route: "direct" | "relay" | null = null;
  private protocol: 1 | 2 = 2;
  private slow = false;

  private signal: SignalSocket;
  private iceServers: RTCIceServer[] | null = null;
  private link: PeerLink | null = null;
  private channel: RTCDataChannel | null = null;

  private current: { file: ReceivedFile; chunks: ArrayBuffer[] } | null = null;
  private lastRx = 0;
  /** The files asked for together, timed so the sender-side admin can see real
   *  transfer speeds (direct vs relayed). */
  private batch: { ids: Set<string>; t0: number } | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private dirty = false;
  private rate = 0;
  private rateBase = 0;
  private rateAt = 0;

  constructor(
    private roomId: string,
    private opts: {
      onChange: (s: ReceiverSnapshot) => void;
      onFileReady: (f: ReceivedFile) => void;
      forceRelay?: boolean;
    },
  ) {
    this.signal = new SignalSocket(roomId, "guest", {
      onMessage: (m) => void this.onSignal(m),
      onFatal: (code) => {
        if (code === CLOSE.ROOM_BUSY) this.fail("room-busy");
        else if (code === CLOSE.ROOM_FULL) this.fail("room-full");
        else if (code === CLOSE.NO_HOST) this.fail("no-host");
        else this.fail("signalling");
      },
      onUnreachable: () => {
        if (!this.channelOpen) this.fail("signalling");
      },
    });
  }

  start(): void {
    this.ticker = setInterval(() => this.tick(), 200);
    this.slowTimer = setTimeout(() => {
      if (this.status === "connecting") {
        this.slow = true;
        this.emit();
      }
    }, SLOW_AFTER_MS);
    this.signal.connect();
    this.emit();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.teardownPeer();
    this.signal.close();
  }

  /** Ask for files. Version-1 senders only have one, and start on "start". */
  request(ids: string[]): void {
    if (!this.channelOpen) return;
    const wanted = this.files.filter(
      (f) => ids.includes(f.id) && (f.status === "available" || f.status === "failed"),
    );
    if (!wanted.length) return;
    if (!this.batch) this.batch = { ids: new Set(), t0: performance.now() };
    for (const f of wanted) {
      f.status = "requested";
      f.received = 0;
      this.batch.ids.add(f.id);
    }
    if (this.protocol === 1) this.channel!.send(JSON.stringify({ type: "start" }));
    else this.channel!.send(JSON.stringify({ type: "request", ids: wanted.map((f) => f.id) }));
    this.emit();
  }

  requestAll(): void {
    this.request(this.files.filter((f) => f.status === "available" || f.status === "failed").map((f) => f.id));
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
      case "no-host":
        this.fail("no-host");
        break;
      case "room-busy":
        this.fail("room-busy");
        break;
      case "room-full":
        this.fail("room-full");
        break;
      case "room-closed":
        // The sender pressed End sharing (or closed the tab cleanly). Say so
        // now rather than after a liveness timeout.
        this.fail("sender-ended");
        break;
      case "offer":
        // A sender whose signalling reconnected renegotiates from scratch.
        if (this.graceTimer) clearTimeout(this.graceTimer);
        this.graceTimer = null;
        await this.startPeer(msg.sdp as RTCSessionDescriptionInit);
        break;
      case "ice":
        await this.link?.addCandidate(msg.candidate as RTCIceCandidateInit);
        break;
      case "peer-disconnected":
        // The sender's *signalling* dropped. Once we're connected that is
        // irrelevant (the old code failed the transfer here anyway); before,
        // give it a grace period to come back — a deploy restart, a laptop
        // waking up — rather than declaring the link dead.
        if (!this.channelOpen) {
          this.teardownPeer();
          this.setStatus(this.files.length ? "ready" : "sender-away");
          if (this.graceTimer) clearTimeout(this.graceTimer);
          this.graceTimer = setTimeout(() => {
            if (!this.channelOpen) this.fail("sender-left");
          }, SENDER_GRACE_MS);
        } else if (this.protocol === 2) {
          this.probe();
        }
        break;
    }
  }

  private async startPeer(offer: RTCSessionDescriptionInit) {
    this.teardownPeer();
    if (this.status !== "ready") this.setStatus("connecting");

    const link = new PeerLink({
      roomId: this.roomId,
      role: "guest",
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
        this.fail("ice");
      },
      onLost: () => {
        if (this.link !== link) return;
        this.channelClosed();
      },
      onDataChannel: (channel) => {
        if (this.link !== link) return;
        channel.binaryType = "arraybuffer";
        this.channel = channel;
        channel.onmessage = (e) => {
          if (this.channel !== channel) return;
          this.lastRx = performance.now();
          this.onData(e.data);
        };
        channel.onclose = () => {
          if (this.channel === channel) this.channelClosed();
        };
        // Introduce ourselves so the sender's list can say who this is.
        const hello = () => channel.send(JSON.stringify({ type: "hello", device: deviceLabel() }));
        if (channel.readyState === "open") hello();
        else channel.onopen = hello;
      },
    });
    this.link = link;
    await link.answer(offer);
  }

  /** Is the sender still there, now that its signalling has gone? Chunks in
   *  flight count as an answer — the pong may be queued behind megabytes. */
  private probe() {
    const channel = this.channel;
    if (!channel || this.probeTimer) return;
    const sentAt = performance.now();
    channel.send(JSON.stringify({ type: "ping" }));
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (this.channel === channel && this.lastRx < sentAt) this.channelClosed();
    }, PROBE_TIMEOUT_MS);
  }

  private teardownPeer() {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = null;
    const ch = this.channel;
    this.channel = null;
    if (ch) {
      ch.onmessage = ch.onclose = ch.onopen = null;
      try { ch.close(); } catch { /* closed */ }
    }
    this.link?.close();
    this.link = null;
    if (this.current) {
      this.current.file.status = "failed";
      this.current = null;
    }
    this.batch = null; // a broken connection's timing would mislead
    // Requested-but-not-started files can be asked for again.
    for (const f of this.files) if (f.status === "requested") f.status = "available";
  }

  private channelClosed() {
    const midFile = !!this.current || this.files.some((f) => f.status === "requested");
    this.teardownPeer();
    this.fail(midFile ? "transfer" : "sender-left");
  }

  // ── Transfer ──────────────────────────────────────────────────────────────

  private onData(data: unknown) {
    if (typeof data !== "string") {
      this.onChunk(data as ArrayBuffer);
      return;
    }
    const msg = parseControl<HostMessage>(data);
    if (!msg) return;

    switch (msg.type) {
      case "ping":
        this.channel?.send(JSON.stringify({ type: "pong" }));
        break;
      case "bye":
        this.fail("sender-ended");
        break;

      case "meta": // version 1 sender: one file, starts on our "start"
        this.protocol = 1;
        this.files = [{
          id: V1_ID,
          name: msg.name,
          size: msg.size,
          mime: msg.mimeType || "application/octet-stream",
          status: "available",
          received: 0,
          blob: null,
        }];
        this.setStatus("ready");
        break;

      case "manifest": {
        this.protocol = 2;
        const prev = new Map(this.files.map((f) => [f.id, f]));
        // Keep what we've already got or are getting; take the sender's word
        // for everything else (files can be added or withdrawn mid-session).
        const next: ReceivedFile[] = msg.files.map((m) => {
          const had = prev.get(m.id);
          return had ?? { ...m, status: "available", received: 0, blob: null };
        });
        for (const f of this.files) {
          if (f.status !== "available" && !next.some((n) => n.id === f.id)) next.push(f);
        }
        this.files = next;
        this.setStatus("ready");
        break;
      }

      case "file-start": {
        const f = this.files.find((x) => x.id === msg.id);
        if (!f) return;
        f.status = "receiving";
        f.received = 0;
        this.current = { file: f, chunks: [] };
        this.emit();
        break;
      }

      case "file-end":
        if (this.current?.file.id === msg.id) this.finish(true);
        break;
    }
  }

  private onChunk(buf: ArrayBuffer) {
    if (!this.current && this.protocol === 1) {
      const f = this.files[0];
      if (!f) return;
      f.status = "receiving";
      this.current = { file: f, chunks: [] };
    }
    const cur = this.current;
    if (!cur) return;
    cur.chunks.push(buf);
    cur.file.received += buf.byteLength;
    this.dirty = true;
    // Version 1 has no end marker: the byte count is the only signal.
    if (this.protocol === 1 && cur.file.received >= cur.file.size) this.finish(false);
  }

  private finish(ack: boolean) {
    const cur = this.current!;
    this.current = null;
    const f = cur.file;
    if (f.received !== f.size) {
      f.status = "failed";
      this.emit();
      this.maybeReportBatch();
      return;
    }
    f.blob = new Blob(cur.chunks, { type: f.mime || "application/octet-stream" });
    f.status = "done";
    if (ack && this.channelOpen) this.channel!.send(JSON.stringify({ type: "ack", id: f.id }));
    this.emit();
    this.opts.onFileReady({ ...f });
    this.maybeReportBatch();
  }

  private maybeReportBatch() {
    const b = this.batch;
    if (!b) return;
    const files = this.files.filter((f) => b.ids.has(f.id));
    if (files.some((f) => f.status === "requested" || f.status === "receiving")) return;
    this.batch = null;
    const done = files.filter((f) => f.status === "done");
    const bytes = done.reduce((n, f) => n + f.size, 0);
    const ms = Math.max(1, Math.round(performance.now() - b.t0));
    if (!done.length) return;
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "https://api.markdrop.in";
    try {
      void fetch(`${apiBase}/api/v1/share/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({ room_id: this.roomId, bytes, ms, files: done.length, route: this.route, protocol: this.protocol }),
      }).catch(() => {});
    } catch {
      /* telemetry is best-effort */
    }
  }

  // ── State ─────────────────────────────────────────────────────────────────

  private fail(reason: FailureReason) {
    if (this.status === "failed") return;
    this.failure = reason;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.teardownPeer();
    this.signal.close();
    this.setStatus("failed");
  }

  private setStatus(s: ReceiverStatus) {
    this.status = s;
    this.emit();
  }

  private reported = -1;

  private tick() {
    // Tell the sender how far we've got, so their list shows our progress
    // rather than how much they've queued (which runs megabytes ahead).
    if (this.current && this.protocol === 2 && this.channelOpen && this.current.file.received !== this.reported) {
      this.reported = this.current.file.received;
      this.channel!.send(JSON.stringify({ type: "progress", id: this.current.file.id, received: this.reported }));
    }
    const now = performance.now();
    const got = this.files.reduce((n, f) => n + f.received, 0);
    if (this.rateAt) {
      const inst = Math.max(0, got - this.rateBase) / ((now - this.rateAt) / 1000);
      this.rate = this.current ? (this.rate ? this.rate * 0.6 + inst * 0.4 : inst) : 0;
    }
    this.rateBase = got;
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
      failure: this.failure,
      route: this.route,
      rate: this.rate,
      protocol: this.protocol,
      slow: this.slow,
    });
  }
}
