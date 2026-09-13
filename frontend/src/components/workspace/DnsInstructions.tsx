"use client";

import { useEffect, useState } from "react";
import CopyButton from "@/components/CopyButton";
import DnsHandoff from "@/components/workspace/DnsHandoff";
import { downloadDnsCsv } from "@/lib/dnsCsv";
import { dnsProviderHint, type DnsProviderHint, type Domain } from "@/lib/workspaces";

/**
 * The DNS records, phrased the way the customer's own control panel phrases
 * them.
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

function Row({
  label, type, host, value, hostLabel,
}: { label: string; type: string; host: string; value: string; hostLabel: string }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-2.5 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">{label}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-500/10 text-gray-500 font-mono">{type}</span>
      </div>
      <div className="flex items-center gap-2 text-[11px]">
        <span className="w-16 shrink-0 text-gray-400">{hostLabel}</span>
        <code className="flex-1 min-w-0 font-mono break-all text-gray-700 dark:text-gray-300">{host}</code>
        <CopyButton text={host} label="Copy" />
      </div>
      <div className="flex items-center gap-2 text-[11px]">
        <span className="w-16 shrink-0 text-gray-400">Value</span>
        <code className="flex-1 min-w-0 font-mono break-all text-gray-700 dark:text-gray-300">{value}</code>
        <CopyButton text={value} label="Copy" />
      </div>
    </div>
  );
}

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
    <div className="mt-2.5 pt-2.5 border-t border-gray-100 dark:border-gray-800 space-y-2.5">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <p className="text-[11px] text-gray-500">
          Add both records at your DNS provider, then Check DNS.
        </p>
        <span className="shrink-0 flex items-center gap-3">
          <DnsHandoff
            domains={[domain]}
            siteName={siteName}
            className="text-[11px] text-gray-500 hover:text-blue-500 transition-colors"
          />
          <button
            onClick={() => downloadDnsCsv([domain])}
            className="inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-blue-500 transition-colors"
            title={`Download the DNS records for ${domain.host} as CSV`}
          >
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
            CSV
          </button>
        </span>
      </div>

      {hint?.detected && (
        <div className="rounded-lg bg-blue-500/5 border border-blue-500/20 px-2.5 py-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-gray-600 dark:text-gray-300">
              This domain&apos;s DNS is managed by{" "}
              <strong className="text-gray-800 dark:text-gray-100">{hint.provider_name}</strong>.
            </span>
            {hint.panel_url && (
              <a
                href={hint.panel_url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
              >
                Open DNS settings
                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M7 17 17 7M9 7h8v8" />
                </svg>
              </a>
            )}
          </div>
          {hint.note && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-1.5 leading-relaxed">
              {hint.note}
            </p>
          )}
          <p className="text-[10px] text-gray-400 mt-1.5">
            The values below are written the way {hint.provider_name} expects them.
          </p>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-2">
        <Row label="Ownership" type={domain.dns_record_type} host={recordHost}
             value={domain.dns_record_value} hostLabel={hostLabel} />
        <Row label="Routing" type={domain.dns_target_type} host={targetHost}
             value={domain.dns_target_value} hostLabel={hostLabel} />
      </div>
    </div>
  );
}
