"use client";

/**
 * TransferStage (REVAMP_PLAN 8.2 + 6.2 "Transfer" signature moment).
 *
 * - `static`: the idle /share picture (laptop → phone, Direct, one packet parked mid-path). Never animates.
 * - `hub`: the sender console. "You" on the left, one node per recipient fanning right, each with a
 *   device glyph, progress ring and label. A path bends through an "Encrypted relay" node ONLY for a
 *   peer whose reported route is "relay".
 * - `pair`: the receiver. "Their device" → "This device" with the route badge above the path.
 *
 * Motion is driven only by real fields the caller passes: packets travel while `state === "active"`
 * (the caller sets that only while bytes rise), cadence bucketed by rate (<1 MB/s 1.6s, 1–10 MB/s
 * 1.0s, >10 MB/s 0.6s); "stalled" parks one packet at 50% and dims the path; marching ants only while
 * "connecting"; "done" fills the path with success once. Reduced motion: one packet parked at 50%,
 * no ants, rings jump to value. Packets use SVG animateMotion (they follow the exact path the
 * geometry draws); the parked packet sits at the path's computed midpoint (no animation at all).
 */
import { memo } from "react";
import { Badge, Icon, RouteBadge, cx } from "@/components/ui";
import { DeviceGlyph, type DeviceKind } from "@/components/kit/DeviceGlyph";
import { useReducedMotion, useWidth } from "./live";
import s from "./TransferStage.module.css";

export type StageState = "connecting" | "waiting" | "active" | "stalled" | "done" | "left" | "failed";

export interface StagePeer {
  id: string;
  kind: DeviceKind;
  label: string;
  /** Short caption under the label ("64% · 4.2 MB/s · direct"). */
  caption?: string;
  /** Very short caption for the compact phone strip ("64%", "Done"). */
  short?: string;
  route: "direct" | "relay" | null;
  state: StageState;
  /** 0..1 */
  progress: number;
  /** bytes/s, only for the packet cadence. */
  rate: number;
}

type Pt = { x: number; y: number };
const seg = (a: Pt, b: Pt) => {
  const mx = a.x + (b.x - a.x) / 2;
  return `C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
};
const pathThrough = (pts: Pt[]) => pts.slice(1).reduce((d, p, i) => `${d} ${seg(pts[i], p)}`, `M ${pts[0].x} ${pts[0].y}`);

const MB = 1024 * 1024;
function cadence(rate: number): { dur: number; count: number } {
  if (rate > 10 * MB) return { dur: 0.6, count: 3 };
  if (rate >= MB) return { dur: 1.0, count: 2 };
  return { dur: 1.6, count: 1 };
}

/** Where a packet parks: the middle of the first segment (a midpoint the geometry knows exactly). */
function parkOn(a: Pt, b: Pt): { x: number; y: number; deg: number } {
  // seg() uses control points (mx, a.y) and (mx, b.y), so B(0.5) is the plain midpoint and
  // B'(0.5) is (0.75·dx, 1.5·dy).
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, deg: (Math.atan2(1.5 * (b.y - a.y), 0.75 * (b.x - a.x)) * 180) / Math.PI };
}

/** Packets travelling `d` (moving), or one packet parked at `park`. */
function Packets({ d, park, moving, rate, small }: { d: string; park: { x: number; y: number; deg: number }; moving: boolean; rate: number; small?: boolean }) {
  const w = small ? 10 : 14, h = small ? 5 : 6;
  const shape = (
    <>
      <rect className={s.packetHalo} x={-w / 2 - 3} y={-h / 2 - 3} width={w + 6} height={h + 6} rx={(h + 6) / 2} />
      <rect className={s.packet} x={-w / 2} y={-h / 2} width={w} height={h} rx={h / 2} />
    </>
  );
  if (!moving) return <g transform={`translate(${park.x} ${park.y}) rotate(${park.deg})`}>{shape}</g>;
  const { dur, count } = cadence(rate);
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <g key={`${dur}-${i}`}>
          {shape}
          <animateMotion path={d} rotate="auto" dur={`${dur}s`} begin={`${(-dur * i) / count}s`} repeatCount="indefinite" />
        </g>
      ))}
    </>
  );
}

function pathClass(state: StageState, relayed: boolean, reduced: boolean): string {
  switch (state) {
    case "connecting": return cx(s.path, reduced ? s.ghost : s.ants);
    case "active": return cx(s.path, s.active, relayed && s.relayed);
    case "stalled": return cx(s.path, s.stalled, relayed && s.relayed);
    case "done": return cx(s.path, s.done);
    case "left": return cx(s.path, s.gone);
    case "failed": return cx(s.path, s.failed);
    default: return cx(s.path, s.idle, relayed && s.relayed);
  }
}

function Ring({ c, r, progress, done }: { c: Pt; r: number; progress: number; done: boolean }) {
  const p = done ? 100 : Math.max(0, Math.min(100, progress * 100));
  return (
    <>
      <circle className={s.track} cx={c.x} cy={c.y} r={r} />
      {p > 0 && (
        <circle className={cx(s.ring, done && s.ringDone)} cx={c.x} cy={c.y} r={r} pathLength={100}
          strokeDasharray={`${p} 100`} transform={`rotate(-90 ${c.x} ${c.y})`} />
      )}
    </>
  );
}

/* ── Hub ─────────────────────────────────────────────────────────────────────────────────────── */

function HubStage({ peers, ariaLabel, className }: { peers: StagePeer[]; ariaLabel: string; className?: string }) {
  const [ref, w] = useWidth<HTMLDivElement>(760);
  const reduced = useReducedMotion();
  const compact = w < 560;
  const shown = peers.slice(0, 10);
  const n = shown.length;
  const hubR = compact ? 20 : 32;
  const hubX = compact ? 4 + hubR : 40 + hubR;
  const nodeR = n > 4 || compact ? 14 : 20;
  const labelW = compact ? 52 : Math.min(220, Math.max(140, w * 0.27));
  const nodeX = w - labelW - 14 - nodeR;
  const spacing = n > 4 ? nodeR * 2 + 8 : compact ? 36 : 56;
  const H = Math.max(compact ? 104 : 184, (Math.max(n, 1) - 1) * spacing + nodeR * 2 + 40);
  const cy = Math.round(H / 2) - (compact ? 6 : 8);
  const start: Pt = { x: hubX + hubR, y: cy };
  const anyRelay = shown.some((p) => p.route === "relay");

  const geo = shown.map((p, i) => {
    const y = n === 1 ? cy : cy + (i - (n - 1) / 2) * spacing;
    const c: Pt = { x: nodeX, y };
    const end: Pt = { x: nodeX - nodeR - 5, y };
    const relayed = p.route === "relay";
    const relay: Pt | null = relayed ? { x: Math.round((start.x + end.x) / 2), y: Math.abs(y - cy) < 2 ? cy + (compact ? 24 : 40) : y } : null;
    const d = relay ? pathThrough([start, relay, end]) : pathThrough([start, end]);
    const park = parkOn(start, relay ?? end);
    return { p, c, d, relay, relayed, park };
  });

  return (
    <div className={cx("min-w-0", className)}>
      {!compact && n > 0 && (
        <div aria-hidden className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-text-secondary">
          <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-[18px] rounded-full bg-accent" />Direct</span>
          {anyRelay && <span className="inline-flex items-center gap-1.5"><span className="w-[18px] border-t-2 border-dotted border-accent" />Relayed, encrypted</span>}
          <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-[18px] rounded-full bg-success-fill" />Delivered</span>
        </div>
      )}
      <div ref={ref} role="img" aria-label={ariaLabel} className={s.stage} style={{ height: H }}>
        <svg className={s.svg} width={w} height={H} viewBox={`0 0 ${w} ${H}`} aria-hidden>
          {n === 0 && (
            <path className={cx(s.path, s.ghost)} d={pathThrough([start, { x: nodeX - nodeR - 5, y: cy }])} />
          )}
          {geo.map(({ p, d, relayed }) => (
            <g key={p.id}>
              {p.state === "active" && !relayed && <path className={cx(s.path, s.halo)} d={d} />}
              <path className={pathClass(p.state, relayed, reduced)} d={d} />
              {p.state === "done" && <path className={cx(s.path, s.done, s.fill)} d={d} pathLength={100} />}
            </g>
          ))}
          {geo.map(({ p, c }) => (
            <Ring key={`r-${p.id}`} c={c} r={nodeR + 4} progress={p.progress} done={p.state === "done"} />
          ))}
          {geo.map(({ p, d, park }) =>
            p.state === "active" || p.state === "stalled" ? (
              <Packets key={`p-${p.id}`} d={d} park={park} moving={p.state === "active" && !reduced} rate={p.rate} small={compact} />
            ) : null,
          )}
        </svg>

        {/* Hub: you */}
        <div className={s.abs} style={{ left: hubX - hubR, top: cy - hubR }} aria-hidden>
          <DeviceGlyph kind="laptop" framed={hubR * 2} size={compact ? 18 : 26} tone="accent" className={s.hub} />
        </div>
        <div className={cx(s.abs, "text-center")} style={{ left: hubX - 50, top: cy + hubR + 8, width: 100 }} aria-hidden>
          <div className={compact ? "text-micro font-semibold text-text" : "text-body-strong text-text"}>You</div>
          {!compact && <div className="text-caption text-text-secondary">This tab</div>}
        </div>

        {/* Relay nodes: only for a peer whose real route is "relay" */}
        {geo.map(({ p, relay }) =>
          relay ? (
            <div key={`x-${p.id}`} aria-hidden>
              <div className={cx(s.abs, s.relayNode)} style={{ left: relay.x - (compact ? 10 : 16), top: relay.y - (compact ? 10 : 16), width: compact ? 20 : 32, height: compact ? 20 : 32 }}>
                <Icon name="wave" size={compact ? 11 : 14} />
              </div>
              {!compact && (
                <div className={cx(s.abs, "text-center text-micro text-text-secondary")} style={{ left: relay.x - 60, top: relay.y - 38, width: 120 }}>Encrypted relay</div>
              )}
            </div>
          ) : null,
        )}

        {/* Empty: one ghost node */}
        {n === 0 && (
          <>
            <div aria-hidden className={cx(s.abs, s.ghostNode)} style={{ left: nodeX - 20, top: cy - 20, width: 40, height: 40 }}>
              <Icon name="user" size={18} />
            </div>
            <div className={cx(s.abs, s.label)} style={{ left: nodeX + 32, top: cy - 22, width: Math.max(80, w - nodeX - 36) }} aria-hidden>
              <div className="text-body-strong text-text">{compact ? "Waiting" : "Waiting for someone to open the link"}</div>
              {!compact && <div className="text-caption text-text-secondary">Send the link or let them scan the code. Nothing moves until they do.</div>}
            </div>
          </>
        )}

        {/* Peer nodes + labels */}
        {geo.map(({ p, c }) => {
          const gone = p.state === "left" || p.state === "failed";
          return (
            <div key={`n-${p.id}`} aria-hidden>
              <div className={s.abs} style={{ left: c.x - nodeR, top: c.y - nodeR }}>
                <DeviceGlyph kind={p.kind} framed={nodeR * 2} size={nodeR > 16 ? 20 : 15} className={gone ? s.peerGone : s.peer} />
                {p.state === "done" && <span className={s.check} style={nodeR < 16 ? { width: 14, height: 14, right: -4, bottom: -4 } : undefined}><Icon name="check" size={nodeR < 16 ? 9 : 12} /></span>}
              </div>
              <div className={cx(s.abs, s.label)} style={{ left: c.x + nodeR + 12, top: c.y - (compact || n > 4 ? 9 : 18), width: labelW }}>
                {compact ? (
                  <div className={cx(s.sub, "text-micro font-semibold", p.state === "done" ? "text-success" : gone ? "text-text-muted" : "text-text-secondary")}>{p.short}</div>
                ) : (
                  <>
                    <div className={cx(s.name, gone && "text-text-muted")} title={p.label}>
                      {p.label}{n > 4 && p.short ? <span className="font-normal text-text-secondary"> · {p.short}</span> : null}
                    </div>
                    {n <= 4 && (
                      <div className={cx(s.sub, "text-caption", p.state === "done" ? "text-success" : gone ? "text-text-muted" : "text-text-secondary")}>
                        {p.state === "done" && <Icon name="checkCircle" size={12} className="mr-1 inline-block align-[-2px]" />}
                        {p.caption}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {peers.length > 10 && <p className="mt-1 text-caption text-text-muted">Showing the first 10.</p>}
    </div>
  );
}

/* ── Pair (receiver) and static (idle) ──────────────────────────────────────────────────────── */

export interface PairStageProps {
  state: "connecting" | "waiting" | "active" | "stalled" | "done" | "failed";
  route: "direct" | "relay" | null;
  progress?: number;
  rate?: number;
  fromKind?: DeviceKind;
  toKind?: DeviceKind;
  fromLabel?: string;
  toLabel?: string;
  /** Text above the path when there's no route badge yet ("Finding a route…"). */
  pending?: string;
  /** Replay key for the one-shot drop into "This device" (pass a value that changes once, on done). */
  dropKey?: string | number | null;
  /** Static (decorative) illustration: no RouteBadge tooltip tab stop, no motion. */
  illustration?: boolean;
  ariaLabel?: string;
  className?: string;
}

function PairStage({
  state, route, progress = 0, rate = 0, fromKind = "laptop", toKind = "monitor",
  fromLabel = "Their device", toLabel = "This device", pending, dropKey, illustration, ariaLabel, className,
}: PairStageProps) {
  const [ref, w0] = useWidth<HTMLDivElement>(440);
  const reduced = useReducedMotion() || !!illustration;
  const w = Math.min(560, w0);
  const compact = w < 380;
  const R = compact ? 20 : 24;
  const H = compact ? 96 : 112;
  const cy = compact ? 40 : 48;
  const a: Pt = { x: R + 16, y: cy };
  const b: Pt = { x: w - R - 16, y: cy };
  const relayed = route === "relay";
  const relay: Pt | null = relayed ? { x: Math.round(w / 2), y: cy } : null;
  const start = { x: a.x + R + 4, y: cy }, end = { x: b.x - R - 6, y: cy };
  const d = `M ${start.x} ${cy} L ${end.x} ${cy}`;
  const showRing = state === "active" || state === "stalled" || state === "done";
  const live = state === "active" || state === "stalled";

  return (
    <div ref={ref} role="img" aria-label={ariaLabel ?? `${fromLabel} to ${toLabel}`} className={cx(s.stage, "mx-auto", className)} style={{ height: H, maxWidth: 560 }}>
      <svg className={s.svg} width={w} height={H} viewBox={`0 0 ${w} ${H}`} aria-hidden>
        {state === "active" && !relayed && <path className={cx(s.path, s.halo)} d={d} />}
        <path className={pathClass(state === "waiting" ? "waiting" : state, relayed, reduced)} d={d} />
        {state === "done" && <path className={cx(s.path, s.done, s.fill)} d={d} pathLength={100} />}
        {showRing && !illustration && <Ring c={b} r={R + 5} progress={progress} done={state === "done"} />}
        {(live || illustration) && <Packets d={d} park={parkOn(start, relay ? { x: relay.x, y: cy } : end)} moving={state === "active" && !reduced} rate={rate} small={compact} />}
      </svg>

      <div className={s.abs} style={{ left: a.x - R, top: cy - R }} aria-hidden>
        <DeviceGlyph kind={fromKind} framed={R * 2} size={compact ? 18 : 22} className={s.peer} />
      </div>
      <div className={s.abs} style={{ left: b.x - R, top: cy - R }} aria-hidden>
        <DeviceGlyph kind={toKind} framed={R * 2} size={compact ? 18 : 22} tone="accent" />
        {state === "done" && !reduced && dropKey != null && <span key={String(dropKey)} className={s.drop} />}
      </div>
      <div className={cx(s.abs, "text-center text-caption text-text-secondary")} style={{ left: a.x - 48, top: cy + R + 10, width: 96 }} aria-hidden>{fromLabel}</div>
      <div className={cx(s.abs, "text-center text-caption font-semibold text-text")} style={{ left: b.x - 48, top: cy + R + 10, width: 96 }} aria-hidden>{toLabel}</div>

      {relay && (
        <div aria-hidden className={cx(s.abs, s.relayNode)} style={{ left: relay.x - 14, top: relay.y - 14, width: 28, height: 28 }}>
          <Icon name="wave" size={13} />
        </div>
      )}
      {state === "failed" && (
        <div aria-hidden className={cx(s.abs, s.fail)} style={{ left: w / 2 - 10, top: cy - 10 }}>
          <Icon name="x" size={12} />
        </div>
      )}
      {/* Route badge (real, with its tooltip) or the pending caption, centred above the path */}
      <div className={cx(s.abs, "flex justify-center")} style={{ left: 0, width: w, top: relay ? cy - 46 : cy - 34 }}>
        {route && state !== "failed" ? (
          illustration
            ? <span aria-hidden><Badge tone="success" icon="arrowRight" size="sm">Direct</Badge></span>
            : <RouteBadge route={route} />
        ) : pending ? (
          <span className="text-caption text-text-secondary" aria-hidden>{pending}</span>
        ) : null}
      </div>
    </div>
  );
}

export type TransferStageProps =
  | ({ mode: "hub"; peers: StagePeer[]; ariaLabel: string; className?: string })
  | ({ mode: "pair" } & PairStageProps)
  | ({ mode: "static"; className?: string });

function TransferStageImpl(props: TransferStageProps) {
  if (props.mode === "hub") return <HubStage peers={props.peers} ariaLabel={props.ariaLabel} className={props.className} />;
  if (props.mode === "static") {
    return (
      <PairStage state="active" route="direct" fromKind="laptop" toKind="phone" fromLabel="You" toLabel="Their phone"
        illustration ariaLabel="Illustration: your laptop sends straight to their phone, direct, with nothing stored in between."
        className={props.className} />
    );
  }
  const { mode: _m, ...rest } = props;
  void _m;
  return <PairStage {...rest} />;
}

export const TransferStage = memo(TransferStageImpl);
export default TransferStage;
