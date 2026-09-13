import type { Domain } from "@/lib/workspaces";

/**
 * DNS records as a CSV a registrar will actually accept.
 *
 * Two records per domain, typed out by hand, is where custom-domain setup goes
 * wrong — a trailing space in a TXT value or a transposed character in a CNAME
 * fails verification with no clue why. Handing over a file removes the typing,
 * and it is also the format the person who owns the DNS usually wants, since
 * they are frequently not the person reading this page.
 */

const HEADERS = ["Host", "Type", "Name", "Value", "TTL", "Purpose"] as const;

/** RFC 4180: wrap in quotes when the field contains a comma, quote or newline,
 *  and double any embedded quote. Excel and Google Sheets both rely on this. */
function cell(value: string): string {
  const v = value ?? "";
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function dnsRows(domains: Domain[]): string[][] {
  return domains.flatMap((d) => [
    [d.host, d.dns_record_type, d.dns_record_name, d.dns_record_value, "3600",
     "Proves you own this domain"],
    [d.host, d.dns_target_type, d.dns_target_name, d.dns_target_value, "3600",
     d.kind === "app" ? "Routes documents to Markdrop" : "Routes files to Markdrop"],
  ]);
}

export function dnsCsv(domains: Domain[]): string {
  const rows = [HEADERS as readonly string[], ...dnsRows(domains)];
  // CRLF, which is what RFC 4180 specifies and what Excel is happiest with.
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** Trigger a download of the CSV. Built in the browser — these values are
 *  already on the page, so a round trip to the server would add nothing. */
export function downloadDnsCsv(domains: Domain[], filename?: string): void {
  const name =
    filename ??
    (domains.length === 1
      ? `${domains[0].host}-dns.csv`
      : `markdrop-dns-records.csv`);
  // The BOM makes Excel read it as UTF-8 instead of the local codepage, which
  // otherwise mangles any non-ASCII hostname.
  const blob = new Blob(["﻿" + dnsCsv(domains)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick: revoking synchronously can cancel the download
  // in some browsers before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
