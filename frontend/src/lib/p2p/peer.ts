import { FALLBACK_ICE_SERVERS } from "@/lib/webrtc";
import { PROTOCOL_VERSION, type CandidateType } from "./protocol";

/**
 * How long to wait for ICE before calling it. A relayed TURN-over-TLS path can
 * take several seconds to come up after the direct candidates have failed, so
 * this is generous — a spinner that gives up too soon on a path that would
 * have worked is worse than one that waits a little longer.
 */
const CONNECT_TIMEOUT_MS = 30_000;

type Outcome = "connected" | "failed" | "timeout";

interface Route {
  local: CandidateType | null;
  remote: CandidateType | null;
  protocol: "udp" | "tcp" | null;
  relay_protocol: "udp" | "tcp" | "tls" | null;
  rtt_ms: number | null;
}

const CANDIDATE_TYPES: CandidateType[] = ["host", "srflx", "prflx", "relay"];

function candidateType(c: { type?: string | null; candidate?: string }): CandidateType | null {
  const t = c.type ?? / typ (\w+)/.exec(c.candidate ?? "")?.[1];
  return CANDIDATE_TYPES.includes(t as CandidateType) ? (t as CandidateType) : null;
}

export interface PeerLinkOptions {
  roomId: string;
  role: "host" | "guest";
  iceServers: RTCIceServer[] | null;
  /** Debug: `?relay=1` forces the TURN path so it can be verified on a network
   *  where a direct path would otherwise win. */
  forceRelay?: boolean;
  sendSignal: (msg: Record<string, unknown>) => void;
  onConnected: (route: Route | null) => void;
  onFailed: (outcome: "failed" | "timeout") => void;
  /** A connection that was up has failed for good (network change, peer gone). */
  onLost?: () => void;
  /** The guest's DataChannel (the host creates its own). */
  onDataChannel?: (channel: RTCDataChannel) => void;
}

/**
 * One RTCPeerConnection attempt, with the parts the old code lacked: a timeout,
 * a reaction to `connectionState: failed` (it used to spin forever), trickle
 * ICE in both directions, and a single diagnostics report per attempt — the
 * data that turns "doesn't work on some Wi-Fi" into a diagnosis.
 */
export class PeerLink {
  readonly pc: RTCPeerConnection;
  private started = performance.now();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settled = false;
  private reported = false;
  private localTypes: Partial<Record<CandidateType, number>> = {};
  private remoteTypes: Partial<Record<CandidateType, number>> = {};
  private states: string[] = [];
  private pendingRemote: RTCIceCandidateInit[] = [];
  private turnOffered: boolean;

  constructor(private opts: PeerLinkOptions) {
    const iceServers = opts.iceServers ?? FALLBACK_ICE_SERVERS;
    this.turnOffered = iceServers.some((s) =>
      [s.urls].flat().some((u) => /^turns?:/.test(u)),
    );
    this.pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: opts.forceRelay ? "relay" : "all",
    });

    this.pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const t = candidateType(e.candidate);
      if (t) this.localTypes[t] = (this.localTypes[t] ?? 0) + 1;
      opts.sendSignal({ type: "ice", candidate: e.candidate.toJSON() });
    };

    const onState = () => {
      const s = this.pc.connectionState ?? this.pc.iceConnectionState;
      this.states.push(`${Math.round(performance.now() - this.started)}:${s}`);
      if (s === "connected") this.succeed();
      else if (s === "failed") {
        if (this.wasConnected) this.opts.onLost?.();
        else this.fail("failed");
      }
    };
    this.pc.onconnectionstatechange = onState;
    // Older Safari only reports ICE state. Elsewhere this reads
    // connectionState too, and succeed()/fail() are idempotent.
    this.pc.oniceconnectionstatechange = onState;

    if (opts.onDataChannel) {
      this.pc.ondatachannel = (e) => opts.onDataChannel!(e.channel);
    }

    this.timer = setTimeout(() => this.fail("timeout"), CONNECT_TIMEOUT_MS);
  }

  get isConnected(): boolean {
    return this.pc.connectionState === "connected";
  }

  /** Host: create the offer (call after createDataChannel). */
  async offer(extra: Record<string, unknown> = {}): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.opts.sendSignal({ type: "offer", sdp: this.pc.localDescription, ...extra });
  }

  /** Guest: answer an offer, advertising our protocol version. */
  async answer(sdp: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(sdp);
    await this.flushCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.opts.sendSignal({ type: "answer", sdp: this.pc.localDescription, v: PROTOCOL_VERSION });
  }

  /** Host: accept the guest's answer. */
  async accept(sdp: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(sdp);
    await this.flushCandidates();
  }

  async addCandidate(c: RTCIceCandidateInit): Promise<void> {
    const t = candidateType(c);
    if (t) this.remoteTypes[t] = (this.remoteTypes[t] ?? 0) + 1;
    // A candidate can beat the description it belongs to; adding it early
    // throws and it used to be dropped. Hold it until the description lands.
    if (!this.pc.remoteDescription) {
      this.pendingRemote.push(c);
      return;
    }
    try {
      await this.pc.addIceCandidate(c);
    } catch {
      /* stale candidate */
    }
  }

  private async flushCandidates() {
    const pending = this.pendingRemote;
    this.pendingRemote = [];
    for (const c of pending) {
      try {
        await this.pc.addIceCandidate(c);
      } catch {
        /* stale candidate */
      }
    }
  }

  private wasConnected = false;

  private async succeed() {
    if (this.settled) return;
    this.settled = true;
    this.wasConnected = true;
    if (this.timer) clearTimeout(this.timer);
    const route = await this.selectedRoute();
    this.report("connected", route);
    this.opts.onConnected(route);
  }

  private fail(outcome: "failed" | "timeout") {
    if (this.settled) return;
    this.settled = true;
    if (this.timer) clearTimeout(this.timer);
    this.report(outcome, null);
    this.opts.onFailed(outcome);
  }

  /** Which candidate pair won — direct (host/srflx) or relayed. */
  private async selectedRoute(): Promise<Route | null> {
    try {
      const stats = await this.pc.getStats();
      let pair: RTCIceCandidatePairStats | undefined;
      stats.forEach((s) => {
        if (s.type === "transport" && s.selectedCandidatePairId) {
          pair = stats.get(s.selectedCandidatePairId);
        }
      });
      if (!pair) {
        stats.forEach((s) => {
          if (s.type === "candidate-pair" && s.state === "succeeded" && (s.nominated || s.selected)) pair = s;
        });
      }
      if (!pair) return null;
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      return {
        local: candidateType({ type: local?.candidateType }),
        remote: candidateType({ type: remote?.candidateType }),
        protocol: local?.protocol ?? null,
        relay_protocol: local?.relayProtocol ?? null,
        rtt_ms: pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
      };
    } catch {
      return null;
    }
  }

  private report(outcome: Outcome, route: Route | null) {
    if (this.reported) return;
    this.reported = true;
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "https://api.markdrop.in";
    try {
      void fetch(`${apiBase}/api/v1/share/diagnostics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          room_id: this.opts.roomId,
          role: this.opts.role,
          outcome,
          elapsed_ms: Math.min(Math.round(performance.now() - this.started), 600_000),
          local_candidates: this.localTypes,
          remote_candidates: this.remoteTypes,
          route,
          turn_offered: this.turnOffered,
          states: this.states.slice(0, 40),
          protocol: PROTOCOL_VERSION,
        }),
      }).catch(() => {});
    } catch {
      /* telemetry is best-effort */
    }
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.settled = true;
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.oniceconnectionstatechange = null;
    this.pc.ondatachannel = null;
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
  }
}
