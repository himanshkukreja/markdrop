"use client";

import { Alert } from "@/components/ui";
import { RecordBlock } from "@/components/workspace/RecordBlock";
import { hostingRecordsNeeded, type Domain } from "@/lib/workspaces";

/**
 * The TXT records a live domain needs so its certificate is ready on Markdrop's new hosting before its
 * traffic moves (Cloudflare for SaaS pre-validation, backend services/cf_saas.py). Shown to admins while a
 * record is still needed; gone once the certificate is active. Readers notice nothing either way.
 */
export default function HostingRecords({ domain }: { domain: Domain }) {
  const needed = hostingRecordsNeeded(domain);
  if (!needed.length) return null;
  const cert = needed.filter((r) => r.purpose === "certificate");
  const owner = needed.filter((r) => r.purpose === "ownership");
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="hosting-records">
      <Alert tone="info" icon="shield" title="One more record keeps this domain secure">
        Markdrop is moving to faster hosting. Add {cert.length === 1 ? "this TXT record" : "these TXT records"} where
        your DNS lives so <span className="ph-sensitive ph-mask">{domain.host}</span> has its certificate ready before
        the move. Nothing changes for readers, and your other records stay as they are.
      </Alert>
      {domain.hosting_message && (
        <p className="ph-sensitive ph-mask text-caption text-text-secondary">{domain.hosting_message}</p>
      )}
      <div className="grid min-w-0 gap-3">
        {cert.map((r) => (
          <RecordBlock key={`${r.name}-${r.value}`} label="Certificate record" purpose="Lets the new certificate be issued"
            type={r.type} name={r.name} value={r.value} found={false} />
        ))}
        {owner.map((r) => (
          <RecordBlock key={`${r.name}-${r.value}`} label="Hosting ownership record"
            purpose="Usually confirmed without it; add it if it's still listed after an hour"
            type={r.type} name={r.name} value={r.value} />
        ))}
      </div>
    </div>
  );
}
