"use client";

/**
 * The publish screen's private-pages check: what this publish protects (private pages, private
 * sections), and what to look at first (a page naming a rule that doesn't exist stays locked for
 * everyone; a public page linking to a private one sends readers to a lock). Nothing when the
 * guide has no private content.
 */
import { useEffect, useState } from "react";
import { Anchor, Icon } from "@/components/ui";
import { getPrivate, type PrivateState } from "@/lib/guidePrivate";
import { useSite } from "../SiteContext";
import { settingsHref } from "../settings/sections";

export function PrivateCheck() {
  const { site, base, canEdit } = useSite();
  const [s, setS] = useState<PrivateState | null>(null);
  useEffect(() => {
    if (!canEdit) return;
    getPrivate(site.id).then(setS).catch(() => setS(null));
  }, [site.id, canEdit]);
  if (!s || (!s.protected_pages && !s.private_sections && !s.requests_pending)) return null;
  const items: Array<{ ok: boolean; text: string }> = [
    { ok: true, text: `${s.protected_pages} private ${s.protected_pages === 1 ? "page" : "pages"}, ${s.private_sections} private ${s.private_sections === 1 ? "section" : "sections"}: left out of search, llms.txt, the sitemap and Ask AI for readers who can't open them` },
    ...(s.unknown_rules.length ? [{ ok: false, text: `A page names a rule that doesn't exist (${s.unknown_rules.join(", ")}): it stays locked for everyone` }] : []),
    ...(s.warnings.length ? [{ ok: false, text: `${s.warnings.length} public ${s.warnings.length === 1 ? "page links" : "pages link"} to a private page` }] : []),
    ...(s.requests_pending ? [{ ok: false, text: `${s.requests_pending} access ${s.requests_pending === 1 ? "request is" : "requests are"} waiting` }] : []),
  ];
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-[18px] py-4" data-testid="private-check">
      <h2 className="flex items-center gap-2 text-[14px] font-semibold leading-5 text-text">
        <Icon name="eyeOff" size={14} className="text-text-muted" /> Private pages
      </h2>
      <ul className="flex flex-col gap-1.5">
        {items.map((i) => (
          <li key={i.text} className="flex items-start gap-2 text-[13px] text-text-secondary">
            <Icon name={i.ok ? "checkCircle" : "alertCircle"} size={14} className={`mt-0.5 shrink-0 ${i.ok ? "text-success" : "text-warning"}`} />
            <span>{i.text}</span>
          </li>
        ))}
      </ul>
      <Anchor href={settingsHref(base, "private")} className="text-[13px] font-semibold text-accent-text no-underline hover:underline">Check who can open what</Anchor>
    </div>
  );
}

export default PrivateCheck;
