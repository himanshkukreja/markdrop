"use client";

import { useEffect, useState } from "react";
import { Alert, Button } from "@/components/ui";
import DnsHandoff from "@/components/workspace/DnsHandoff";
import { RecordBlock } from "@/components/workspace/RecordBlock";
import { downloadDnsCsv } from "@/lib/dnsCsv";
import { dnsProviderHint, type DnsProviderHint, type Domain } from "@/lib/workspaces";

/**
 * The DNS records, phrased the way the customer's own control panel phrases them.
 *
 * One-click setup at GoDaddy and IONOS is behind a paid intermediary, so this is
 * the free version of the same goal: name the provider, link straight to its DNS
 * page, and label the field whatever that provider labels it.
 *
 * The highest-value part is the host value. Most panels append the domain
 * themselves, so pasting the full `_markdrop-challenge.acme.com` produces a
 * record at `_markdrop-challenge.acme.com.acme.com` — which looks right in the
 * form, fails verification, and gives no clue why. When the provider is known we
 * show the exact string to type for that panel.
 */
export default function DnsInstructions({
  workspaceId,
  domain,
  siteName,
}: {
  workspaceId: string;
  domain: Domain;
  siteName?: string;
}) {
  const [hint, setHint] = useState<DnsProviderHint | null>(null);

  // Costs a live DNS lookup, so it is requested only while these instructions
  // are actually on screen — which is exactly when this component is mounted.
  useEffect(() => {
    let cancelled = false;
    dnsProviderHint(workspaceId, domain.id)
      .then((h) => { if (!cancelled) setHint(h); })
      .catch(() => { /* falls back to the generic values below */ });
    return () => { cancelled = true; };
  }, [workspaceId, domain.id]);

  const hostLabel = hint?.detected ? hint.host_field || "Name" : "Name";
  const recordHost = hint?.detected && hint.record_host ? hint.record_host : domain.dns_record_name;
  const targetHost = hint?.detected && hint.target_host ? hint.target_host : domain.dns_target_name;

  return (
    <div className="flex min-w-0 flex-col gap-3 border-t border-border pt-4">
      <p className="text-body text-text-secondary">
        Add these two records where your DNS lives, then check. Nothing changes for readers until both are in place.
      </p>

      {hint?.detected && (
        <Alert
          tone="info"
          icon="server"
          title={`Your DNS is at ${hint.provider_name}`}
          actions={hint.panel_url ? (
            <Button variant="secondary" size="sm" href={hint.panel_url} target="_blank" rel="noreferrer noopener" iconRight="external">
              Open {hint.provider_name} DNS
            </Button>
          ) : undefined}
        >
          The values below are written the way {hint.provider_name} expects them.
          {hint.note && <span className="mt-1 block text-warning">{hint.note}</span>}
        </Alert>
      )}

      <div className="grid min-w-0 gap-3">
        <RecordBlock
          label="Ownership record"
          purpose={`Proves ${domain.host} is yours`}
          type={domain.dns_record_type}
          name={recordHost}
          value={domain.dns_record_value}
          nameLabel={hostLabel}
        />
        <RecordBlock
          label="Routing record"
          purpose="Sends readers to Markdrop"
          type={domain.dns_target_type}
          name={targetHost}
          value={domain.dns_target_value}
          nameLabel={hostLabel}
        />
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1 text-caption text-text-muted">
          Someone else runs your DNS? Send them both records and the steps.
        </span>
        <Button
          variant="ghost"
          size="sm"
          iconLeft="download"
          onClick={() => downloadDnsCsv([domain])}
          title={`Download the DNS records for ${domain.host} as CSV`}
        >
          Download CSV
        </Button>
        <DnsHandoff domains={[domain]} siteName={siteName} />
      </div>
    </div>
  );
}
