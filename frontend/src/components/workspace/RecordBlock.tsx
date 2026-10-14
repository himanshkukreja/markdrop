"use client";

import { Badge, CopyButton } from "@/components/ui";

/**
 * One DNS record to add (REVAMP_PLAN 7.12 Domains, v1): an eyebrow ("Ownership record"), the record
 * type, then the mono Name and Value, each with its own copy button. The values break anywhere so
 * a 40-character TXT value never pushes the page sideways on a phone.
 */
export function RecordBlock({
  label, purpose, type, name, value, nameLabel = "Name",
}: {
  label: string;
  /** e.g. "Proves docs.acme.com is yours". */
  purpose?: string;
  type: string;
  name: string;
  value: string;
  /** What this provider calls the name field ("Host", "Name"…). */
  nameLabel?: string;
}) {
  const rows: Array<[string, string]> = [[nameLabel, name], ["Value", value]];
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-eyebrow uppercase text-text-secondary">{label}</span>
        <Badge size="sm" variant="outline" className="font-mono">{type}</Badge>
        {purpose && <span className="text-caption text-text-muted">{purpose}</span>}
      </div>
      <dl className="m-0 flex min-w-0 flex-col divide-y divide-border bg-surface-inset">
        {rows.map(([k, v]) => (
          <div key={k} className="flex min-w-0 items-center gap-3 px-3 py-1.5">
            <dt className="w-14 shrink-0 text-micro font-semibold uppercase tracking-wide text-text-secondary">{k}</dt>
            <dd className="m-0 min-w-0 flex-1 font-mono text-code text-text [overflow-wrap:anywhere]">{v}</dd>
            <CopyButton
              text={v}
              iconOnly
              size="md"
              label={`Copy ${label.toLowerCase()} ${k.toLowerCase()}`}
              announceText={`${label} ${k.toLowerCase()} copied`}
              className="shrink-0"
            />
          </div>
        ))}
      </dl>
    </div>
  );
}

export default RecordBlock;
