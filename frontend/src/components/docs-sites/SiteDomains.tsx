"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, ConfirmDialog, Dialog, Field, Icon, Input, useToast } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { RecordBlock } from "@/components/workspace/RecordBlock";
import { guideEvents } from "@/lib/guidesEvents";
import {
  addSiteDomain, checkSiteDomain, docsErrorMessage, getSite, removeSiteDomain, siteHost, type DomainRecord, type SiteDomain,
} from "@/lib/docsSites";
import { timeAgo } from "./format";
import { useSite } from "./SiteContext";

/** What was typed → a bare hostname (the API checks it properly). */
function cleanHost(raw: string): string {
  let v = raw.trim().toLowerCase();
  if (v.includes("://")) {
    try { v = new URL(v).hostname; } catch { /* the API says what's wrong */ }
  }
  return v.split("/")[0]!.split(":")[0]!.replace(/\.+$/, "");
}

function statusBadge(d: SiteDomain) {
  if (d.status === "live") return <Badge tone="success" size="sm" dot>Live</Badge>;
  if (d.status === "failed") return <Badge tone="danger" size="sm" icon="alertCircle">Problem</Badge>;
  if (d.status === "removing") return <Badge size="sm" icon="clock">Removing…</Badge>;
  if (d.stage === "certificate") return <Badge tone="info" size="sm" icon="lock">Issuing certificate</Badge>;
  return <Badge tone="warning" size="sm" icon="clock">Checking DNS</Badge>;
}

const PURPOSE: Record<string, { label: string; purpose: string }> = {
  route: { label: "CNAME record", purpose: "Sends readers to the guide" },
  ownership: { label: "Ownership record", purpose: "Proves the domain is yours" },
  certificate: { label: "Certificate record", purpose: "Lets the certificate be issued" },
};

function Records({ d, records }: { d: SiteDomain; records: DomainRecord[] }) {
  const cname = records.filter((r) => !r.optional);
  const extra = records.filter((r) => r.optional);
  return (
    <div className="ph-sensitive ph-mask flex min-w-0 flex-col gap-3">
      {cname.map((r) => (
        <RecordBlock key={`${r.type}-${r.name}`} label={PURPOSE[r.purpose]?.label ?? `${r.type} record`} purpose={PURPOSE[r.purpose]?.purpose} type={r.type} name={r.name} value={r.value} />
      ))}
      <p className="text-caption text-text-muted">
        Many DNS providers add your domain to the name for you: there, type just the part before it (for{" "}
        <code className="font-mono">{d.host}</code>, usually <code className="font-mono">{d.host.split(".")[0]}</code>). At Cloudflare,
        set the record to <strong>DNS only</strong> (grey cloud).
      </p>
      {extra.length > 0 && (
        <details className="min-w-0 rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer text-caption text-text-secondary">
            Domain behind another proxy or CDN, or want it checked before you switch the CNAME? Add these too.
          </summary>
          <div className="mt-3 flex min-w-0 flex-col gap-3">
            {extra.map((r) => (
              <RecordBlock key={`${r.type}-${r.name}`} label={PURPOSE[r.purpose]?.label ?? `${r.type} record`} purpose={PURPOSE[r.purpose]?.purpose} type={r.type} name={r.name} value={r.value} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * Settings › "Your own domain": add a domain → the CNAME to add (and Cloudflare's optional TXT
 * records) with copy buttons → a live status (Checking DNS / Issuing certificate / Live / Problem)
 * with Re-check → Remove. The server registers the domain with Cloudflare for SaaS and keeps checking
 * on its own; this screen refreshes the guide while a domain is on its way. Admins change domains;
 * everyone else sees their status.
 */
export default function SiteDomains() {
  const { site, setSite, isAdmin } = useSite();
  const toast = useToast();
  const own = site.own_domains;
  const available = own?.available ?? false;
  const target = own?.target || "cname.guides.markdrop.in";
  const max = own?.max ?? 1;
  const domains = (site.domains ?? []).filter((d) => d && d.host);
  const [addOpen, setAddOpen] = useState(false);
  const [host, setHost] = useState("");
  const [addError, setAddError] = useState("");
  const [busy, setBusy] = useState("");
  const [removing, setRemoving] = useState<SiteDomain | null>(null);
  const seen = useRef<Map<string, string>>(new Map());

  // A domain going live while this screen is open: say so (and count it) once.
  useEffect(() => {
    for (const d of domains) {
      const before = seen.current.get(d.host);
      if (before && before !== "live" && d.status === "live") {
        guideEvents.domainLive();
        toast.success(<><span className="ph-sensitive ph-mask">{d.host}</span> is live.</>);
      }
      seen.current.set(d.host, d.status);
    }
  }, [domains, toast]);

  // While a domain is on its way, refresh the guide now and then (the server does the checking).
  const waiting = domains.some((d) => d.status === "pending" || d.status === "removing");
  const quick = domains.some((d) => d.status === "removing" || (d.status === "pending" && !d.checked_at));
  useEffect(() => {
    if (!waiting) return;
    let stop = false;
    const t = window.setTimeout(async () => {
      if (stop || document.visibilityState === "hidden") return;
      try {
        const fresh = await getSite(site.id);
        if (!stop) setSite(fresh);
      } catch { /* the next tick tries again */ }
    }, quick ? 4000 : 20000);
    return () => { stop = true; window.clearTimeout(t); };
  }, [waiting, quick, site, setSite]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const h = cleanHost(host);
    if (!h) { setAddError("Enter a domain, like help.yourcompany.com."); return; }
    setBusy("add");
    setAddError("");
    try {
      setSite(await addSiteDomain(site.id, h));
      setAddOpen(false);
      setHost("");
      toast.success(<>Added <span className="ph-sensitive ph-mask">{h}</span>. Add the CNAME record below.</>);
    } catch (err) {
      setAddError(docsErrorMessage(err, "Couldn't add that domain. Try again."));
    } finally {
      setBusy("");
    }
  }

  async function recheck(d: SiteDomain) {
    setBusy(`c${d.host}`);
    try {
      const fresh = await checkSiteDomain(site.id, d.host);
      setSite(fresh);
      const now = fresh.domains.find((x) => x.host === d.host);
      if (now?.status === "pending") toast.info(now.stage === "certificate" ? "DNS is right. The certificate is on its way." : "The CNAME record isn't visible yet. DNS changes can take up to an hour.");
    } catch (err) {
      toast.error(docsErrorMessage(err, "Couldn't check. Try again in a minute."));
    } finally {
      setBusy("");
    }
  }

  const canAdd = isAdmin && available && domains.length < max;

  return (
    <section id="domain" aria-labelledby="domain-h" className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-5">
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        <h2 id="domain-h" className="min-w-0 flex-1 text-[16px] font-semibold text-text">Your own domain</h2>
        {!available && <Badge tone="info" size="sm">Not available yet</Badge>}
        {isAdmin && available && domains.length < max && (
          <Button variant={domains.length ? "ghost" : "secondary"} size="sm" iconLeft="plus" onClick={() => { setAddError(""); setAddOpen(true); }}>
            {domains.length ? "Add another" : "Add a domain"}
          </Button>
        )}
      </div>

      {domains.length === 0 && (
        <p className="text-body text-text-secondary">
          {available
            ? <>Serve the guide from a subdomain you own, like <code className="font-mono">help.yourcompany.com</code>: one CNAME record, and the certificate is handled for you. The free address keeps working.</>
            : "Own domains aren't switched on for this Markdrop server yet. The free address always works."}{" "}
          <ReadMore topic="studioDomain" />
        </p>
      )}

      {domains.length > 0 && (
        <ul className="m-0 flex min-w-0 list-none flex-col gap-3 p-0">
          {domains.map((d) => (
            <li key={d.host} className="min-w-0 rounded-lg border border-border">
              <div className="flex min-w-0 flex-wrap items-center gap-2.5 px-3.5 py-3">
                <Icon name="globe" size={16} className="shrink-0 text-text-secondary" />
                <code className="ph-sensitive ph-mask min-w-0 flex-1 font-mono text-[14px] text-text [overflow-wrap:anywhere]">{d.host}</code>
                {statusBadge(d)}
                {d.status === "live" && <Badge tone="info" size="sm" icon="lock">HTTPS</Badge>}
                {d.status === "live" && (
                  <Button size="sm" variant="ghost" iconLeft="external" href={`https://${d.host}`} target="_blank" rel="noreferrer noopener">Visit</Button>
                )}
                {isAdmin && available && (d.status === "pending" || d.status === "failed" || d.status === "live") && (
                  <Button size="sm" variant={d.status === "live" ? "ghost" : "secondary"} iconLeft="refresh" loading={busy === `c${d.host}`} onClick={() => void recheck(d)}>
                    Re-check
                  </Button>
                )}
                {isAdmin && d.status !== "removing" && (
                  <Button size="sm" variant="ghost" iconLeft="trash" onClick={() => setRemoving(d)} aria-label={`Remove ${d.host}`}>Remove</Button>
                )}
              </div>
              {d.status !== "removing" && (
                <div className="flex min-w-0 flex-col gap-3 px-3.5 pb-3.5">
                  {d.status === "live" ? (
                    <p className="text-caption text-text-muted">
                      Readers get the guide here{d.live_at ? ` since ${timeAgo(d.live_at)}` : ""}. Links, the sitemap and search results use this domain from the next publish, which Markdrop started for you. Keep the CNAME record in place.
                    </p>
                  ) : (
                    <p className="text-caption text-text-muted">
                      {d.status === "failed"
                        ? "Markdrop stopped checking. Fix the record below, then choose Re-check."
                        : d.stage === "certificate"
                          ? "DNS is right. Cloudflare is issuing the certificate, usually within a few minutes."
                          : "Add the record below where your domain's DNS is managed. Markdrop checks on its own for 3 days; it's usually live a few minutes after DNS updates."}
                      {d.checked_at ? ` Last checked ${timeAgo(d.checked_at)}.` : ""}
                    </p>
                  )}
                  {d.message && (
                    <Alert tone={d.status === "failed" ? "danger" : "warning"}>
                      <span className="ph-sensitive ph-mask">{d.message}</span>
                    </Alert>
                  )}
                  {isAdmin && d.status !== "live" && <Records d={d} records={d.records ?? [{ type: "CNAME", name: d.host, value: target, purpose: "route", optional: false }]} />}
                  {!isAdmin && d.status !== "live" && <p className="text-caption text-text-secondary">A Guides admin finishes setting up this domain.</p>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {domains.length > 0 && (
        <p className="text-[13px] text-text-muted">
          The free address, <code className="ph-sensitive ph-mask font-mono">{siteHost(site)}</code>, keeps working.{" "}
          {canAdd ? "" : domains.length >= max && isAdmin ? `A guide can have ${max} domains. ` : ""}
          <ReadMore topic="studioDomain" />
        </p>
      )}

      <Dialog
        open={addOpen}
        onClose={() => busy !== "add" && setAddOpen(false)}
        dismissible={busy !== "add"}
        title="Add a domain"
        description="A subdomain you own. You'll add one CNAME record next."
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)} disabled={busy === "add"}>Cancel</Button>
            <Button variant="primary" type="submit" form="add-guide-domain" loading={busy === "add"}>Add domain</Button>
          </>
        }
      >
        <form id="add-guide-domain" onSubmit={add} className="flex min-w-0 flex-col gap-4" noValidate>
          <Field label="Domain" error={addError || undefined} hint="Like help.yourcompany.com or docs.yourcompany.com. Root domains (yourcompany.com) aren't supported yet.">
            <Input mono className="ph-sensitive ph-mask" value={host} onChange={(e) => { setHost(e.target.value); if (addError) setAddError(""); }} placeholder="help.yourcompany.com" autoComplete="off" autoCapitalize="none" spellCheck={false} inputMode="url" />
          </Field>
        </form>
      </Dialog>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={removing ? <>Remove <span className="ph-sensitive ph-mask">{removing.host}</span>?</> : "Remove domain?"}
        body={removing?.status === "live"
          ? "The guide stops answering there right away, and links to it fail. Links, the sitemap and search results go back to the free address. You can delete the CNAME record afterwards."
          : "Markdrop stops checking it. You can delete the CNAME record afterwards."}
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
    </section>
  );
}
