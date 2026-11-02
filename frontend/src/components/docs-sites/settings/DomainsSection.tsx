"use client";

import { useState } from "react";
import { Alert, Anchor, Badge, Button, ConfirmDialog, CopyButton, Dropdown, Icon, IconButton, type MenuEntry, useToast } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { addressSecuring, checkSiteDomain, docsErrorMessage, removeSiteDomain, siteHost, type SiteDomain } from "@/lib/docsSites";
import { SECURING_COPIED, SECURING_TEXT, SecuringBadge } from "../AddressSecuring";
import { useSite } from "../SiteContext";
import { DomainBadge, domainNote, ownDomains, useDomainRefresh } from "./domainStatus";
import { LockedNote, SectionHeader, SettingsCard } from "./SettingsShell";
import { SECTIONS, domainHref, settingsHref } from "./sections";

/** One address as a row (Settings.dc.html): host and a note, its status, Copy, Open, and a menu. */
function AddressRow({ host, href, note, badge, open, menu, cta, securing }: {
  host: string;
  href?: string;
  note: string;
  badge: React.ReactNode;
  open: boolean;
  menu: MenuEntry[];
  cta?: React.ReactNode;
  /** The free address's certificate is on its way (AddressSecuring.tsx): Open is off, Copy says when it opens. */
  securing?: boolean;
}) {
  const toast = useToast();
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-2.5 rounded-lg border border-border bg-surface-inset py-3 pl-3.5 pr-2.5">
      <Icon name="globe" size={16} className="shrink-0 text-text-secondary" />
      <span className="flex min-w-0 flex-[1_1_220px] flex-col">
        {href ? (
          <Anchor href={href} className="ph-sensitive ph-mask md-focus w-fit rounded font-mono text-[14px] font-semibold text-text no-underline [overflow-wrap:anywhere] hover:underline">{host}</Anchor>
        ) : (
          <span className="ph-sensitive ph-mask font-mono text-[14px] font-semibold text-text [overflow-wrap:anywhere]">{host}</span>
        )}
        <span className="text-caption text-text-muted" role={securing ? "status" : undefined}>{note}</span>
      </span>
      {badge}
      {cta}
      <CopyButton text={`https://${host}`} label="Copy" size="sm" variant="ghost" announceText="Address copied"
        onCopy={securing ? () => toast.info(SECURING_COPIED) : undefined} />
      {open && <Button variant="secondary" size="sm" iconRight="external" href={`https://${host}`} target="_blank" rel="noopener noreferrer" aria-label={`Open ${host} in a new tab`}>Open</Button>}
      {securing && <Button variant="secondary" size="sm" iconRight="external" href={`https://${host}`} disabled title={SECURING_TEXT} aria-label={`Open ${host}: available once the address is secured`}>Open</Button>}
      {menu.length > 0 && (
        <Dropdown align="right" aria-label={`More for ${host}`} items={menu}
          trigger={<IconButton icon="more" label={`More for ${host}`} variant="ghost" size="sm" />} />
      )}
    </li>
  );
}

/**
 * Settings › Domains: every address the guide answers at (its own domains, then the free address),
 * each with its status, Copy, Open in a new tab and a menu; then "Add your own domain", which goes
 * to the setup flow (…/domains/new). A domain's own page (…/domains/<host>) has its DNS steps and
 * live status.
 */
export default function DomainsSection() {
  const { site, setSite, isAdmin, base } = useSite();
  const toast = useToast();
  useDomainRefresh();
  const own = site.own_domains;
  const available = own?.available ?? false;
  const max = own?.max ?? 1;
  const domains = ownDomains(site.domains);
  const free = siteHost(site);
  const freeSecuring = site.status === "live" && addressSecuring(site, false);
  const [removing, setRemoving] = useState<SiteDomain | null>(null);
  const [busy, setBusy] = useState("");
  const canAdd = isAdmin && available && domains.length < max;

  async function recheck(d: SiteDomain) {
    setBusy(d.host);
    try {
      const fresh = await checkSiteDomain(site.id, d.host);
      setSite(fresh);
      const now = fresh.domains.find((x) => x.host === d.host);
      if (now?.status === "live") toast.success(<><span className="ph-sensitive ph-mask">{d.host}</span> is live.</>);
      else if (now?.status === "pending") toast.info(now.stage === "certificate" ? "DNS is right. The certificate is on its way." : "The record isn't visible yet. DNS changes can take up to an hour.");
    } catch (err) {
      toast.error(docsErrorMessage(err, "Couldn't check. Try again in a minute."));
    } finally {
      setBusy("");
    }
  }

  const menuFor = (d: SiteDomain): MenuEntry[] => {
    const items: MenuEntry[] = [{ label: d.status === "live" ? "Status and DNS record" : "Setup steps and status", href: domainHref(base, d.host), icon: "listTree" }];
    if (isAdmin && available && d.status !== "removing") items.push({ label: "Check now", icon: "refresh", busy: busy === d.host, onClick: () => void recheck(d) });
    if (isAdmin && d.status !== "removing") items.push({ label: "Remove domain", icon: "trash", danger: true, separated: true, onClick: () => setRemoving(d) });
    return items;
  };

  return (
    <>
      <SectionHeader title="Domains" description={SECTIONS[1].blurb} />
      <LockedNote />

      <SettingsCard id="domains" title="Address and domains" description={<>Readers get the guide at each live address. <ReadMore topic="studioDomain" /></>}>
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0" aria-label="The guide's addresses">
          {domains.map((d) => (
            <AddressRow
              key={d.host}
              host={d.host}
              href={domainHref(base, d.host)}
              note={domainNote(d)}
              badge={<DomainBadge d={d} />}
              open={d.status === "live"}
              cta={isAdmin && (d.status === "pending" || d.status === "failed") ? <Button variant="secondary" size="sm" href={domainHref(base, d.host)}>Finish setup</Button> : undefined}
              menu={menuFor(d)}
            />
          ))}
          <AddressRow
            host={free}
            note={freeSecuring
              ? "Free address · its certificate is on its way: usually 1–3 minutes, and it opens as soon as it's ready"
              : domains.some((d) => d.status === "live") ? "Free address · always works" : "Free address · always works, even after you add your own domain"}
            badge={freeSecuring ? <SecuringBadge /> : site.status === "live" ? <Badge tone="success" size="sm" dot>Live</Badge> : <Badge size="sm">Not published</Badge>}
            open={site.status === "live" && !freeSecuring}
            securing={freeSecuring}
            menu={isAdmin ? [{ label: "Change the free address", href: `${settingsHref(base, "general")}#address`, icon: "edit" }] : []}
          />
        </ul>

        {canAdd ? (
          <div className="flex flex-wrap items-center gap-2.5 rounded-lg border-[1.5px] border-dashed border-border-strong p-3.5">
            <span className="min-w-0 flex-[1_1_300px] text-body text-text-secondary">
              <strong className="text-text">Add your own domain</strong>, like help.yourcompany.com. One DNS record, and the certificate is automatic.
            </span>
            <Button variant="secondary" size="sm" iconLeft="plus" href={`${base}/settings/domains/new`}>{domains.length ? "Add another" : "Add a domain"}</Button>
          </div>
        ) : !available ? (
          <p className="text-[13px] text-text-muted">Own domains aren&apos;t switched on for this Markdrop server yet. The free address always works.</p>
        ) : isAdmin && domains.length >= max ? (
          <p className="text-[13px] text-text-muted">A guide can have {max} domains. Remove one to add another.</p>
        ) : !isAdmin && domains.length === 0 ? (
          <p className="text-[13px] text-text-muted">A Guides admin can add your company&apos;s own domain, like help.yourcompany.com.</p>
        ) : null}
        {domains.some((d) => d.status === "failed") && (
          <Alert tone="danger" title="A domain isn't live">Open its setup steps to see what's in the way, fix the DNS record, then check again.</Alert>
        )}
      </SettingsCard>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={removing ? <>Remove <span className="ph-sensitive ph-mask">{removing.host}</span>?</> : "Remove domain?"}
        body={removing?.status === "live"
          ? "The guide stops answering there right away, and links to it fail. Links, the sitemap and search results go back to the free address. You can delete the DNS record afterwards."
          : "Markdrop stops checking it. You can delete the DNS record afterwards."}
        confirmLabel="Remove domain"
        onConfirm={async () => {
          const d = removing!;
          try {
            setSite(await removeSiteDomain(site.id, d.host));
            toast.success(<><span className="ph-sensitive ph-mask">{d.host}</span> is being removed.</>);
          } catch (err) {
            toast.error(docsErrorMessage(err, "Couldn't remove it. Try again."));
          }
          setRemoving(null);
        }}
      />
    </>
  );
}
