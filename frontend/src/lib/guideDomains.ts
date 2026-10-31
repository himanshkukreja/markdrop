/**
 * Setting up a guide's own domain (backend services/docs_domain_setup.py, routers/docs_site_domains.py):
 * who runs its DNS and the record in their words (the same provider table as workspace domains,
 * services/dns_provider.py), whether DNS has it yet, a one-click Domain Connect link where the provider
 * offers one, and the public check page (markdrop.in/d/check/<host>) for whoever runs the DNS.
 *
 * Adding, checking and removing the domain itself are lib/docsSites (addSiteDomain, checkSiteDomain,
 * removeSiteDomain). The messages and CSV here are built in the browser from values already on screen.
 */
import { docsRequest } from "@/lib/docsSites";
import { downloadRecordsCsv } from "@/lib/dnsCsv";
import { mailtoLink } from "@/lib/dnsHandoff";

const enc = encodeURIComponent;

export interface DnsProvider {
  detected: boolean;
  /** The zone the record lives in (acme.com for help.acme.com). */
  zone?: string;
  provider_id?: string | null;
  provider_name?: string | null;
  panel_url?: string | null;
  /** What the provider calls the name and value fields ("Name", "Target" at Cloudflare). */
  host_field?: string | null;
  value_field?: string | null;
  /** Other fields its form asks for: [{label: "Proxy status", value: "DNS only (grey cloud)"}]. */
  extras?: Array<{ label: string; value: string }>;
  note?: string | null;
  nameservers?: string[];
}

export interface GuideRecord {
  type: string;
  /** The full name (help.acme.com). */
  name: string;
  value: string;
  /** The name as this provider's form wants it (help where it appends the zone). */
  host: string;
}

export interface DomainSetup {
  host: string;
  zone: string;
  /** The part before the zone (help). */
  label: string;
  record: GuideRecord;
  provider: DnsProvider;
  /** DNS has the CNAME pointing at Markdrop (true), doesn't (false), or didn't answer (null). */
  record_seen: boolean | null;
  /** Where the name points instead, when it has another CNAME. */
  record_points_to: string | null;
  /** The provider's one-click page, when it offers our Domain Connect template. */
  one_click: { provider_id: string; provider_name: string; url: string; width: number; height: number } | null;
  /** markdrop.in/d/check/<host>: the public, read-only check page. */
  check_url: string;
  /** You added it and Markdrop sends email: you get one when it's live (absent from an older API). */
  emails_you?: boolean;
}

export interface DomainCheck {
  host: string;
  status: "pending" | "live" | "failed" | string;
  stage?: "dns" | "certificate" | null;
  live_at?: string | null;
  checked_at?: string | null;
  record: GuideRecord;
  provider: DnsProvider;
  record_seen: boolean | null;
  record_points_to: string | null;
}

/** Guides admins: the setup screen's help for one domain. `fresh` reads DNS again (else up to a minute old). */
export function getDomainSetup(siteId: string, host: string, fresh = false): Promise<DomainSetup> {
  return docsRequest(`/${enc(siteId)}/domains/${enc(host)}/setup${fresh ? "?fresh=true" : ""}`);
}

/** Public: how far along a domain is (the check page). */
export function getDomainCheck(host: string): Promise<DomainCheck> {
  return docsRequest(`/domain-check/${enc(host)}`);
}

/** The check page's address on this app (the API gives the canonical one in `check_url`). */
export const domainCheckPath = (host: string) => `/d/check/${enc(host)}`;

/** The record's rows the way the provider's form asks for them: [label, value, copyable]. */
export function recordRows(r: GuideRecord, p: DnsProvider | null | undefined): Array<[string, string, boolean]> {
  const known = !!p?.detected;
  return [
    ["Type", r.type, false],
    [known ? p!.host_field || "Name" : "Name", known ? r.host : r.name, true],
    [known ? p!.value_field || "Value" : "Value", r.value, true],
    ...(known ? (p!.extras ?? []).map((x): [string, string, boolean] => [x.label, x.value, false]) : []),
  ];
}

/** The message for whoever runs the DNS: the record, where, and a link to check it worked. */
export function handoffMessage(d: { host: string; zone: string; record: GuideRecord; provider: DnsProvider; check_url: string }, guide?: string) {
  const p = d.provider;
  const where = p.detected && p.provider_name ? ` (it's at ${p.provider_name})` : "";
  const name = p.detected ? d.record.host : d.record.name;
  const extra = p.detected ? (p.extras ?? []).map((x) => `   ${x.label}: ${x.value}`) : [];
  const subject = `DNS record needed for ${d.host}`;
  const body = [
    "Hi!",
    "",
    `We're putting ${guide ? `our ${guide} guide` : "our help center"} on ${d.host} with Markdrop Guides.`,
    `Could you add this DNS record for ${d.zone}${where}?`,
    "",
    `   Type: ${d.record.type}`,
    `   ${p.detected ? p.host_field || "Name" : "Name"}: ${name}`,
    `   ${p.detected ? p.value_field || "Value" : "Value"}: ${d.record.value}`,
    ...extra,
    "",
    // An unknown provider: the one thing that goes wrong most (the name doubled by the panel).
    ...(p.detected ? [] : [
      `If the form adds ${d.zone} to the name for you, type just "${d.host.endsWith(`.${d.zone}`) ? d.host.slice(0, -(d.zone.length + 1)) : d.host}".`,
      "",
    ]),
    "That's all: Markdrop issues the HTTPS certificate itself. It doesn't touch email or any other",
    "name. You can check it worked here:",
    d.check_url,
    "",
    "Thanks!",
  ].join("\n");
  return { subject, body, mailto: mailtoLink(subject, body) };
}

/** The record as a CSV a registrar will take (lib/dnsCsv's format). */
export function downloadGuideRecordCsv(d: { host: string; record: GuideRecord }): void {
  downloadRecordsCsv([{ host: d.host, type: d.record.type, name: d.record.name, value: d.record.value, purpose: "Sends readers to the guide" }], `${d.host}-dns.csv`);
}

/** An import's redirects, for Settings › Redirects (read-only). */
export function getImportedRedirects(siteId: string, limit = 200): Promise<{ count: number; redirects: Array<{ from: string; to: string }> }> {
  return docsRequest(`/${enc(siteId)}/redirects/imported?limit=${limit}`);
}
