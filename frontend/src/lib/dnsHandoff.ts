import type { Domain } from "@/lib/workspaces";

/**
 * A message to send to whoever actually controls the DNS.
 *
 * The person setting up a custom domain very often cannot change its DNS — that
 * sits with IT, an agency, or one colleague who owns the registrar login. Until
 * now the only way to hand it over was to screenshot this page, which loses the
 * exact values that must be copied character for character.
 *
 * The wording assumes the reader is competent and busy: what to add, where, and
 * what it does. It deliberately says what these records do *not* do, because
 * that is the first question anyone sensible asks before touching a zone file
 * on someone else's say-so.
 */

function block(d: Domain): string {
  return [
    `Domain: ${d.host}`,
    ``,
    `  1. ${d.dns_record_type} record  (proves we own the domain)`,
    `     Name:  ${d.dns_record_name}`,
    `     Value: ${d.dns_record_value}`,
    `     TTL:   3600`,
    ``,
    `  2. ${d.dns_target_type} record  (points the hostname at the service)`,
    `     Name:  ${d.dns_target_name}`,
    `     Value: ${d.dns_target_value}`,
    `     TTL:   3600`,
  ].join("\n");
}

export function dnsEmail(domains: Domain[], siteName = "Markdrop"): {
  subject: string;
  body: string;
} {
  const one = domains.length === 1;
  const subject = one
    ? `DNS records needed for ${domains[0].host}`
    : `DNS records needed for ${domains.length} hostnames`;

  const body = [
    `Hi,`,
    ``,
    one
      ? `Could you add two DNS records for ${domains[0].host}? We're setting it up to`
      : `Could you add the DNS records below? We're setting these hostnames up to`,
    `serve our documentation through ${siteName}.`,
    ``,
    domains.map(block).join("\n\n"),
    ``,
    `What these do:`,
    `  · The ${domains[0]?.dns_record_type ?? "TXT"} record is a one-off ownership check. It holds no`,
    `    configuration and can be removed once the domain is verified.`,
    `  · The ${domains[0]?.dns_target_type ?? "CNAME"} record routes ${one ? "that hostname" : "those hostnames"} to the service.`,
    ``,
    `What these do not do: they don't affect email (no MX or SPF changes), they`,
    `don't touch the root domain, and they don't change where any existing`,
    `hostname points.`,
    ``,
    `Once they're in, let me know and I'll run the verification — it usually`,
    `picks them up within a few minutes, though DNS can take up to an hour to`,
    `propagate. The certificate is issued automatically after that.`,
    ``,
    `Thanks!`,
  ].join("\n");

  return { subject, body };
}

/** A `mailto:` for the reader's own mail client.
 *
 *  Some clients truncate very long URLs, so this is offered next to a copy
 *  button rather than instead of one — copy always works. */
export function dnsMailto(domains: Domain[], siteName = "Markdrop"): string {
  const { subject, body } = dnsEmail(domains, siteName);
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
