"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Button, IconButton, Progress, Spinner, announce } from "@/components/ui";
import { KitIcon } from "@/components/kit/DeviceGlyph";
import s from "./enterprise.module.css";

/**
 * "Three steps to your domain" panel (REVAMP_PLAN 7.2 §2). At rest it shows the verified state:
 * both records checked, the path filled, the certificate issued. The ghost "Play" button runs the
 * setup once from the start (ownership check → routing check → certificate progress → live) and
 * announces each step politely. It is user-initiated, so it also plays under reduced motion (only the
 * path's fill transition is dropped). Copy and record shapes mirror the real Domains tab.
 */

// 0 = checking ownership, 1 = checking routing, 2 = issuing the certificate, 3 = live (rest).
type Step = 0 | 1 | 2 | 3;

const RECORDS = [
  { label: "Ownership", type: "TXT", name: "_markdrop-verify.docs", value: "markdrop-verify=7f3k9q", ok: "Verified" },
  { label: "Routing", type: "CNAME", name: "docs", value: "edge.markdrop.in", ok: "Points to Markdrop" },
] as const;

const NODES = ["Ownership verified", "Routing found", "Certificate issued"] as const;

const ANNOUNCE: Record<Step, string> = {
  0: "Checking the ownership record…",
  1: "Ownership verified. Checking the routing record…",
  2: "Routing found. Issuing the certificate…",
  3: "Certificate issued. docs.example.com is live.",
};

/** Decorative controls drawn as in the product; inert here so they are never a dead tab stop. */
function Inert({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span inert aria-hidden="true" className={className}>
      {children}
    </span>
  );
}

export function DnsPanel() {
  const [step, setStep] = useState<Step>(3);
  const [cert, setCert] = useState(100);
  const timers = useRef<number[]>([]);
  const playing = step < 3;

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  function play() {
    if (playing) return;
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    const at = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));
    setCert(0);
    setStep(0);
    announce(ANNOUNCE[0]);
    at(1100, () => { setStep(1); announce(ANNOUNCE[1]); });
    at(2200, () => { setStep(2); announce(ANNOUNCE[2]); });
    for (let i = 1; i <= 5; i++) at(2200 + i * 240, () => setCert(i * 20));
    at(3600, () => { setStep(3); announce(ANNOUNCE[3]); });
  }

  // Record i is checked once step > i; it is being checked while step === i.
  const recordState = (i: number) => (step > i ? "ok" : step === i ? "busy" : "wait");
  // Node i (0 ownership, 1 routing, 2 certificate) is done once step > i.
  const nodeState = (i: number) => (step > i ? "done" : step === i ? "busy" : "wait");
  const filled = Math.min(step, 2) / 2;

  return (
    <div className={s.panel} aria-labelledby="dns-host">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 md:min-h-16 md:px-5">
        <span className="inline-flex size-8 flex-none items-center justify-center rounded-lg border border-border bg-surface-inset text-text-secondary">
          <KitIcon name="globe" size={16} />
        </span>
        <span id="dns-host" className="min-w-0 font-mono text-[15px] leading-5 font-semibold">docs.example.com</span>
        <span className="order-last flex w-full flex-wrap gap-1.5 pl-11 md:order-none md:w-auto md:pl-0">
          {playing ? (
            <Badge tone="neutral" icon="clock">Setting up</Badge>
          ) : (
            <Badge tone="success" dot>Live</Badge>
          )}
          <Badge tone="neutral" variant="outline">Primary</Badge>
          <Badge tone="neutral">Documents</Badge>
        </span>
        <IconButton
          icon="play"
          label={playing ? "Playing the setup" : "Play the setup from the start"}
          size="lg"
          className="ml-auto"
          aria-disabled={playing || undefined}
          onClick={play}
        />
      </div>

      {RECORDS.map((r, i) => {
        const st = recordState(i);
        return (
          <div key={r.type} className={s.record}>
            <div className={s.recordHead}>
              <span className="inline-flex items-center gap-2">
                <span className="text-eyebrow text-text-muted uppercase">{r.label}</span>
                <span className="font-mono text-caption font-bold text-accent-text md:hidden">{r.type}</span>
              </span>
              {st === "ok" && <Badge tone="success" icon="check" size="sm">{r.ok}</Badge>}
              {st === "busy" && (
                <Badge tone="info" size="sm"><Spinner size={12} /> Checking</Badge>
              )}
              {st === "wait" && <Badge tone="neutral" icon="clock" size="sm">Waiting</Badge>}
            </div>
            <div className="hidden md:block">
              <div className="text-micro text-text-muted">Type</div>
              <div className="font-mono text-code font-semibold text-accent-text">{r.type}</div>
            </div>
            <div className="hidden min-w-0 md:block">
              <div className="text-micro text-text-muted">Name</div>
              <div className="truncate font-mono text-code text-text">{r.name}</div>
            </div>
            <div className="hidden min-w-0 md:block">
              <div className="text-micro text-text-muted">Value</div>
              <div className="truncate font-mono text-code text-text">{r.value}</div>
            </div>
            <dl className={s.recordKv}>
              <dt className="text-micro text-text-muted">Name</dt>
              <dd className="m-0 min-w-0 truncate font-mono text-code text-text">{r.name}</dd>
              <dt className="text-micro text-text-muted">Value</dt>
              <dd className="m-0 min-w-0 truncate font-mono text-code text-text">{r.value}</dd>
            </dl>
            <Inert className={s.recordCopyNarrow}>
              <Button variant="ghost" size="sm" iconLeft="copy" tabIndex={-1}>Copy</Button>
            </Inert>
            <Inert className={s.recordCopyWide}>
              <Button variant="secondary" iconLeft="copy" block tabIndex={-1}>Copy value</Button>
            </Inert>
          </div>
        );
      })}

      <div className={s.path}>
        <div className={s.pathRow}>
          <span aria-hidden="true" className={s.pathTrack} />
          <span aria-hidden="true" className={s.pathFill} style={{ transform: `scaleX(${filled})` }} />
          {NODES.map((label, i) => {
            const st = nodeState(i);
            const certBusy = i === 2 && st === "busy";
            return (
              <div key={label} className="relative flex min-h-15 min-w-0 flex-col items-center gap-2 px-1 text-center">
                <span
                  aria-hidden="true"
                  className={`${s.node} ${st === "done" ? s.nodeDone : st === "busy" ? s.nodeBusy : s.nodeWait}`}
                >
                  {st === "done" ? <KitIcon name="check" size={14} /> : st === "busy" ? <Spinner size={12} /> : <span className="text-micro">{i + 1}</span>}
                </span>
                <span className={`text-caption font-semibold ${st === "done" ? "text-text-secondary" : "text-text-muted"}`}>
                  {certBusy ? "Issuing certificate" : label}
                  <span className="sr-only">{st === "done" ? ", done" : st === "busy" ? ", in progress" : ", waiting"}</span>
                </span>
                {certBusy && (
                  <Progress
                    size="sm"
                    value={cert}
                    className="w-full max-w-28"
                    aria-label="Certificate"
                    valueText={`Issuing the certificate, ${cert}%`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-3 px-4 py-3.5 md:flex-row md:items-center md:px-5">
        <span className="flex flex-1 items-start gap-2.5 text-caption text-text-secondary md:items-center">
          <span className="inline-flex pt-0.5 text-text-muted md:pt-0"><KitIcon name="info" size={14} /></span>
          We spot your DNS provider and show each record name the way its panel expects.
        </span>
        <Inert className="flex flex-col gap-2 md:flex-row md:items-center">
          <Button variant="secondary" size="sm" iconLeft="external" tabIndex={-1} className="max-md:h-11">Send to your DNS admin</Button>
          <Button variant="ghost" size="sm" iconLeft="download" tabIndex={-1} className="max-md:h-11">Download CSV</Button>
        </Inert>
      </div>
    </div>
  );
}

export default DnsPanel;
