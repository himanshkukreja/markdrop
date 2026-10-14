"use client";

import { useState } from "react";
import { Button, CopyButton, Dialog, Field, Input, Textarea } from "@/components/ui";
import { downloadDnsCsv } from "@/lib/dnsCsv";
import { dnsEmail, dnsMailto } from "@/lib/dnsHandoff";
import type { Domain } from "@/lib/workspaces";

/**
 * "I don't control the DNS" — the common case, made a two-click handover.
 *
 * Offers the same records three ways because the recipient decides which is
 * useful: a written message to paste into an email, a CSV for someone who bulk
 * imports into a registrar, and a mailto for people who just want their mail
 * client to open.
 */
export default function DnsHandoff({
  domains,
  siteName,
  className,
}: {
  domains: Domain[];
  siteName?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  if (domains.length === 0) return null;
  const { subject, body } = dnsEmail(domains, siteName || "Markdrop");

  return (
    <>
      <Button variant="secondary" size="sm" iconLeft="send" className={className} onClick={() => setOpen(true)}>
        Send to your DNS admin
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title="Send these records to whoever manages your DNS"
        description={
          domains.length === 1
            ? `If you can't edit the DNS for ${domains[0].host}, send this on. It has the exact records, what they do, and what they don't touch.`
            : "If you can't edit the DNS for these hostnames, send this on. It has the exact records, what they do, and what they don't touch."
        }
        footer={
          <>
            <Button variant="ghost" iconLeft="download" onClick={() => downloadDnsCsv(domains)}>Download CSV</Button>
            <Button variant="secondary" iconLeft="mail" href={dnsMailto(domains, siteName || "Markdrop")}>Open in email</Button>
            <CopyButton text={body} label="Copy message" variant="primary" size="md" announceText="Message copied" />
          </>
        }
      >
        <div className="flex min-w-0 flex-col gap-4">
          <Field label="Subject">
            <Input readOnly mono value={subject} onFocus={(e) => e.currentTarget.select()} />
          </Field>
          <Field label="Message">
            <Textarea readOnly mono value={body} rows={12} onFocus={(e) => e.currentTarget.select()} className="text-code" />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
