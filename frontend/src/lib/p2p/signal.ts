import { getWsUrl } from "@/lib/webrtc";

/** Close codes the server uses (see backend/app/routers/share.py). */
export const CLOSE = {
  DUPLICATE_HOST: 4000,
  NO_HOST: 4001,
  BAD_ROLE: 4002,
  ROOM_BUSY: 4003,
  BAD_ROOM: 4004,
  SERVER_FULL: 4005,
} as const;

const PING_MS = 25_000;
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];

type Msg = Record<string, unknown> & { type: string };

/**
 * The signalling WebSocket, kept alive.
 *
 * Two things used to strand a share silently: nginx closes a WebSocket that has
 * been idle for an hour, and every backend deploy restarts the process. The
 * sender's page never noticed either — it went on saying "Waiting for recipient"
 * on a link that no longer led anywhere. This pings every 25 s so idleness never
 * happens, and reconnects with backoff when the socket drops anyway.
 *
 * Reconnecting is safe because rooms are addressed by id: the same id rejoins
 * the same room, and the server tells a returning host about a waiting guest.
 */
export class SignalSocket {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closedByUs = false;
  /** Set when the server refused us for a reason a retry can't fix. */
  private fatal = false;
  private everOpened = false;

  constructor(
    private roomId: string,
    private role: "host" | "guest",
    private handlers: {
      onMessage: (msg: Msg) => void;
      /** Socket is (re)open. `reconnect` is false only the first time. */
      onOpen?: (reconnect: boolean) => void;
      /** Socket dropped and a retry is scheduled. */
      onRetrying?: () => void;
      /** Server refused us with a close code a retry can't fix. */
      onFatal?: (code: number) => void;
      /** Gave up after repeated failures to even open. */
      onUnreachable?: () => void;
    },
  ) {}

  connect(): void {
    this.closedByUs = false;
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(getWsUrl(this.roomId, this.role));
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      const reconnect = this.attempt > 0 || this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      this.pingTimer = setInterval(() => this.send({ type: "ping" }), PING_MS);
      this.handlers.onOpen?.(reconnect);
    };

    ws.onmessage = (evt) => {
      if (typeof evt.data !== "string") return;
      try {
        const msg = JSON.parse(evt.data);
        if (msg && typeof msg.type === "string") this.handlers.onMessage(msg);
      } catch {
        /* not JSON — ignore */
      }
    };

    ws.onclose = (evt) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.ws === ws) this.ws = null;
      if (this.closedByUs || this.fatal) return;

      // Refusals that mean something. A duplicate host right after our own
      // drop is just the server not having reaped the old socket yet — retry.
      if (
        evt.code === CLOSE.NO_HOST ||
        evt.code === CLOSE.ROOM_BUSY ||
        evt.code === CLOSE.BAD_ROOM ||
        evt.code === CLOSE.BAD_ROLE
      ) {
        this.fatal = true;
        this.handlers.onFatal?.(evt.code);
        return;
      }

      if (!opened && this.attempt >= BACKOFF_MS.length && !this.everOpened) {
        this.handlers.onUnreachable?.();
        return;
      }
      const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
      this.attempt += 1;
      this.handlers.onRetrying?.();
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: Record<string, unknown>): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  close(): void {
    this.closedByUs = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pingTimer = null;
    this.retryTimer = null;
    this.ws?.close();
    this.ws = null;
  }
}
