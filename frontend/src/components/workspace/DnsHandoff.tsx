"use client";

import { useState } from "react";
import Modal from "@/components/Modal";
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
  className = "",
}: {
  domains: Domain[];
  siteName?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  if (domains.length === 0) return null;
  const { subject, body } = dnsEmail(domains, siteName || "Markdrop");

  async function copy() {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* Clipboard can be blocked; the textarea below is selectable either way. */
    }
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className={className}>
        Send to your DNS admin
      </button>

      {open && (
        <Modal title="Hand these records to whoever manages your DNS" onClose={() => setOpen(false)}>
          <div className="space-y-4">
            <p className="text-xs text-gray-500 leading-relaxed">
              If you don&apos;t have access to the DNS for{" "}
              {domains.length === 1 ? (
                <code className="font-mono text-gray-700 dark:text-gray-300">{domains[0].host}</code>
              ) : (
                "these hostnames"
              )}
              , copy the message below and send it on. It contains the exact records, what they
              do, and what they don&apos;t touch.
            </p>

            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 block mb-1.5">
                Subject
              </label>
              <input
                readOnly
                value={subject}
                onFocus={(e) => e.target.select()}
                className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm font-mono"
              />
            </div>

            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 block mb-1.5">
                Message
              </label>
              <textarea
                readOnly
                value={body}
                rows={14}
                onFocus={(e) => e.target.select()}
                className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-[11px] font-mono leading-relaxed resize-y"
              />
            </div>

            <div className="flex flex-wrap gap-2 justify-end">
              <button
                onClick={() => downloadDnsCsv(domains)}
                className="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                Download CSV
              </button>
              <a
                href={dnsMailto(domains, siteName || "Markdrop")}
                className="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                Open in email
              </a>
              <button
                onClick={copy}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
              >
                {copied ? "Copied" : "Copy message"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
