"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Alert, Badge, Button, ConfirmDialog, CopyButton, EmptyState, Field, Icon, Input, Skeleton, Spinner, cx, useToast,
} from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { RecordBlock } from "@/components/workspace/RecordBlock";
import {
  addSiteDomain, checkSiteDomain, docsErrorMessage, removeSiteDomain, type DomainRecord, type SiteDomain,
} from "@/lib/docsSites";
import { downloadGuideRecordCsv, getDomainSetup, handoffMessage, type DomainSetup as Setup } from "@/lib/guideDomains";
import { guideEvents } from "@/lib/guidesEvents";
import { timeAgo } from "../format";
import { useSite } from "../SiteContext";
import { DomainBadge, ownDomains, useDomainRefresh } from "./domainStatus";
import { SectionHeader, SettingsCard } from "./SettingsShell";
import { domainHref, settingsHref } from "./sections";

/** Every this often while the page is open (and visible), the status and DNS are read again. */
const POLL_MS = 45_000;

/** What was typed → a bare hostname (the API checks it properly). */
function cleanHost(raw: string): string {
  let v = raw.trim().toLowerCase();
  if (v.includes("://")) {
    try { v = new URL(v).hostname; } catch { /* the API says what's wrong */ }
  }
  return v.split("/")[0]!.split(":")[0]!.replace(/\.+$/, "");
}

type StepState = "done" | "now" | "later";

/** Your domain → Connect DNS → Live with HTTPS. */
function Stepper({ states }: { states: [StepState, StepState, StepState] }) {
  const labels = ["Your domain", "Connect DNS", "Live with HTTPS"];
  return (
    <ol className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-3" aria-label="Steps">
      {labels.map((label, i) => {
        const s = states[i]!;
        return (
          <li
            key={label}
            aria-current={s === "now" ? "step" : undefined}
            className={cx("flex min-w-0 items-center gap-2.5 rounded-lg border px-3.5 py-2.5", s === "now" ? "border-accent bg-accent-soft" : "border-border bg-surface")}
          >
            <span className={cx(
              "grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-bold",
              s === "done" ? "bg-success-soft text-success" : s === "now" ? "bg-accent text-on-accent" : "bg-surface-inset text-text-muted",
            )}>
              {s === "done" ? <Icon name="check" size={13} /> : i + 1}
            </span>
            <strong className={cx("min-w-0 text-body-strong", s === "later" ? "text-text-muted" : "text-text")}>{label}</strong>
            <span className="sr-only">{s === "done" ? "(done)" : s === "now" ? "(current step)" : "(next)"}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** The live status: Record found → HTTPS certificate → Live, each done, running or waiting. */
function StatusList({ rows }: { rows: Array<{ label: React.ReactNode; note: React.ReactNode; state: "done" | "running" | "waiting" | "failed" }> }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-1 p-0">
      {rows.map((r, i) => (
        <li key={i} className={cx("flex min-w-0 flex-wrap items-center gap-3 rounded-lg px-2.5 py-2", r.state === "running" && "bg-accent-soft", r.state === "failed" && "bg-danger-soft")}>
          <span className={cx("grid size-[22px] shrink-0 place-items-center rounded-full", r.state === "done" ? "bg-success-soft text-success" : r.state === "failed" ? "text-danger" : "bg-surface-inset text-text-muted")}>
            {r.state === "done" ? <Icon name="check" size={13} /> : r.state === "running" ? <Spinner size={13} /> : r.state === "failed" ? <Icon name="alertCircle" size={14} /> : null}
          </span>
          <span className={cx("min-w-0 flex-1", r.state === "waiting" ? "text-text-muted" : "text-text")}>{r.label}</span>
          <span className="text-caption text-text-muted">{r.note}</span>
        </li>
      ))}
    </ol>
  );
}

/** "12 s ago", ticking. */
function useAgo(iso: string | null | undefined): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, []);
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  return timeAgo(iso, now);
}

/** Step 1: the domain to add (…/settings/domains/new, ?host= prefills it). */
function AddDomain() {
  const { site, setSite, isAdmin, base } = useSite();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const own = site.own_domains;
  const [host, setHost] = useState(params.get("host") ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const domains = ownDomains(site.domains);
  const full = domains.length >= (own?.max ?? 1);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const h = cleanHost(host);
    if (!h) { setError("Enter a domain, like help.yourcompany.com."); return; }
    setBusy(true);
    setError("");
    try {
      setSite(await addSiteDomain(site.id, h));
      toast.success(<>Added <span className="ph-sensitive ph-mask">{h}</span>. Now connect its DNS.</>);
      router.replace(domainHref(base, h));
    } catch (err) {
      setError(docsErrorMessage(err, "Couldn't add that domain. Try again."));
      setBusy(false);
    }
  }

  return (
    <>
      <SectionHeader
        back={{ href: settingsHref(base, "domains"), label: "Domains" }}
        title="Add your own domain"
        description="Your guide at an address like help.yourcompany.com. The certificate is automatic, and the free address keeps working."
      />
      <Stepper states={["now", "later", "later"]} />
      {!isAdmin ? (
        <Alert tone="neutral">Only Guides admins add domains.</Alert>
      ) : !own?.available ? (
        <Alert tone="info" title="Not available yet">Own domains aren&apos;t switched on for this Markdrop server yet. The free address always works.</Alert>
      ) : full ? (
        <Alert tone="info">A guide can have {own.max} domains. Remove one to add another.</Alert>
      ) : (
        <SettingsCard id="domain" title="Your domain" description="A subdomain you own. You'll connect it with one DNS record next.">
          <form onSubmit={add} className="flex flex-wrap items-start gap-2" noValidate>
            <Field label="Domain" error={error || undefined} hint="Like help.yourcompany.com or docs.yourcompany.com. Root domains (yourcompany.com) aren't supported yet." className="min-w-0 flex-[1_1_320px]">
              <Input mono className="ph-sensitive ph-mask" value={host} onChange={(e) => { setHost(e.target.value); if (error) setError(""); }} placeholder="help.yourcompany.com" autoComplete="off" autoCapitalize="none" spellCheck={false} inputMode="url" autoFocus />
            </Field>
            <Button type="submit" variant="primary" loading={busy} iconRight="arrowRight" className="sm:mt-[26px]">Continue</Button>
          </form>
        </SettingsCard>
      )}
    </>
  );
}

const PURPOSE: Record<string, { label: string; purpose: string }> = {
  ownership: { label: "Ownership record", purpose: "Proves the domain is yours" },
  certificate: { label: "Certificate record", purpose: "Lets the certificate be issued" },
};

/** Steps 2 and 3 for one domain: connect DNS (one click, the provider's own words, or send it on), then the live status. */
function DomainSteps({ d }: { d: SiteDomain }) {
  const { site, setSite, isAdmin, base } = useSite();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  useDomainRefresh(POLL_MS);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [setupError, setSetupError] = useState("");
  const [checking, setChecking] = useState(false);
  const [lastCheck, setLastCheck] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"remove" | "change" | null>(null);
  const host = d.host;
  const live = d.status === "live";
  const failed = d.status === "failed";

  const load = useCallback(async (fresh = false) => {
    if (!isAdmin) return;
    try {
      setSetup(await getDomainSetup(site.id, host, fresh));
      setSetupError("");
    } catch (e) {
      setSetupError(docsErrorMessage(e, "Couldn't look up the DNS for this domain."));
    }
  }, [isAdmin, site.id, host]);

  useEffect(() => { void load(); }, [load]);

  // While it isn't live: read DNS again every POLL_MS (the API caches it a minute), so "Record found"
  // turns green on its own. The guide itself is refreshed by useDomainRefresh.
  useEffect(() => {
    if (live || !isAdmin) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void load();
      setLastCheck(new Date().toISOString());
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [live, isAdmin, load]);

  const checkNow = useCallback(async (quiet = false) => {
    setChecking(true);
    try {
      const fresh = await checkSiteDomain(site.id, host);
      setSite(fresh);
      await load(true);
      setLastCheck(new Date().toISOString());
      const now = fresh.domains.find((x) => x.host === host);
      if (!quiet && now?.status === "pending") toast.info(now.stage === "certificate" ? "DNS is right. The certificate is on its way." : "The record isn't visible yet. DNS changes can take up to an hour.");
    } catch (err) {
      toast.error(docsErrorMessage(err, "Couldn't check. Try again in a minute."));
    } finally {
      setChecking(false);
    }
  }, [site.id, host, setSite, load, toast]);

  // Back from the provider's one-click page: check right away, once.
  const returned = useRef(false);
  useEffect(() => {
    if (returned.current || params.get("connected") !== "1" || !isAdmin) return;
    returned.current = true;
    toast.info("Back from your DNS provider. Checking for the record…");
    void checkNow(true);
    router.replace(domainHref(base, host));
  }, [params, isAdmin, checkNow, router, base, host, toast]);

  const seen = live || d.stage === "certificate" || setup?.record_seen === true;
  const steps: [StepState, StepState, StepState] = live ? ["done", "done", "done"] : seen ? ["done", "done", "now"] : ["done", "now", "later"];
  const p = setup?.provider;
  const providerName = p?.detected ? p.provider_name : null;
  const records: DomainRecord[] = d.records ?? [];
  const extraRecords = records.filter((r) => r.optional);
  const handoff = setup ? handoffMessage(setup, site.name) : null;
  const checkedAgo = useAgo(lastCheck && (!d.checked_at || lastCheck > d.checked_at) ? lastCheck : d.checked_at);

  const statusRows = [
    {
      label: "Record found",
      state: (seen ? "done" : failed ? "failed" : "running") as "done" | "running" | "failed",
      note: seen ? "points at Markdrop" : setup?.record_points_to ? <>points to <code className="ph-sensitive ph-mask font-mono">{setup.record_points_to}</code> instead</> : failed ? "not found" : "waiting for it to appear",
    },
    {
      label: "HTTPS certificate issued",
      state: (live ? "done" : seen && !failed ? "running" : "waiting") as "done" | "running" | "waiting",
      note: live ? "automatic, renewed for you" : "automatic, usually a few minutes",
    },
    {
      label: <>Live at <span className="ph-sensitive ph-mask font-mono">{host}</span></>,
      state: (live ? "done" : "waiting") as "done" | "waiting",
      note: live ? (d.live_at ? `since ${timeAgo(d.live_at)}` : "readers get the guide here") : "links, sitemap and search switch over",
    },
  ];

  return (
    <>
      <SectionHeader
        back={{ href: settingsHref(base, "domains"), label: "Domains" }}
        title={live ? <span className="ph-sensitive ph-mask">{host}</span> : "Add your own domain"}
        description={live ? "Your guide is live on your own domain. The free address keeps working." : "Your guide at an address like help.yourcompany.com. The certificate is automatic, and the free address keeps working."}
      />
      <Stepper states={steps} />

      <SettingsCard id="domain">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <span className="w-full text-caption text-text-muted">Domain</span>
          <Icon name="globe" size={16} className="shrink-0 text-text-secondary" />
          <strong className="ph-sensitive ph-mask min-w-0 flex-1 font-mono text-[15px] [overflow-wrap:anywhere]">{host}</strong>
          <DomainBadge d={d} />
          {live && <Button variant="secondary" size="sm" iconRight="external" href={`https://${host}`} target="_blank" rel="noopener noreferrer">Open</Button>}
          {isAdmin && !live && d.status !== "removing" && <Button variant="ghost" size="sm" onClick={() => setConfirm("change")}>Change</Button>}
        </div>
      </SettingsCard>

      {d.status === "removing" && <Alert tone="info">This domain is being removed.</Alert>}
      {failed && (
        <Alert tone="danger" title="Not live yet">
          {d.message ? <span className="ph-sensitive ph-mask">{d.message}</span> : "Markdrop stopped checking."} Fix the record below, then choose Check now to start again.
        </Alert>
      )}
      {!failed && d.message && <Alert tone="warning"><span className="ph-sensitive ph-mask">{d.message}</span></Alert>}

      {!isAdmin && !live && <Alert tone="neutral">A Guides admin finishes setting up this domain.</Alert>}

      {isAdmin && !live && d.status !== "removing" && (
        <>
          {setupError && <Alert tone="warning" actions={<Button size="sm" variant="secondary" onClick={() => void load(true)}>Try again</Button>}>{setupError} The record below still works everywhere.</Alert>}
          {!setup && !setupError && <Skeleton variant="rect" height={140} />}

          {setup && (setup.one_click || providerName) && (
            <SettingsCard tone={setup.one_click ? "accent" : undefined}>
              <div className="flex min-w-0 flex-wrap items-center gap-3.5">
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface-inset text-text-secondary"><Icon name="server" size={20} /></span>
                <div className="min-w-0 flex-[1_1_260px]">
                  <h2 className="text-[18px] font-semibold leading-[26px] text-text"><span className="ph-sensitive ph-mask">{setup.zone}</span>&apos;s DNS is at {setup.one_click?.provider_name ?? providerName}</h2>
                  <p className="text-body text-text-secondary">
                    {setup.one_click
                      ? <>We found this from its nameservers. Connect it in one click: sign in to {setup.one_click.provider_name} and approve the record.</>
                      : <>We found this from its nameservers. Add the record below in {providerName}&apos;s DNS settings.</>}
                  </p>
                </div>
                {setup.one_click && <Badge tone="success" size="sm" icon="zap">One click</Badge>}
              </div>
              <div className="flex flex-wrap gap-2">
                {setup.one_click && (
                  <Button variant="primary" size="lg" iconRight="external" href={setup.one_click.url} target="_blank" rel="noopener noreferrer" onClick={() => guideEvents.domainOneClick()}>
                    Connect with {setup.one_click.provider_name}
                  </Button>
                )}
                {p?.panel_url && (
                  <Button variant={setup.one_click ? "secondary" : "primary"} size={setup.one_click ? "lg" : "md"} iconRight="external" href={p.panel_url} target="_blank" rel="noopener noreferrer">
                    Open {providerName} DNS{setup.one_click ? " instead" : ""}
                  </Button>
                )}
              </div>
              {setup.one_click && <p className="text-caption text-text-muted">Markdrop asks {setup.one_click.provider_name} to add one record and nothing else. You see it before you approve.</p>}
            </SettingsCard>
          )}

          <SettingsCard
            id="record"
            title={setup?.one_click ? "Or add the record yourself" : "Add this DNS record"}
            description={
              providerName
                ? <>Written the way {providerName}&apos;s form asks for it.{p?.note ? <> {p.note}</> : null}</>
                : <>Sign in where <span className="ph-sensitive ph-mask">{setup?.zone ?? "your domain"}</span>&apos;s DNS is managed (often where you bought it) and add one record. If the form adds the domain to the name for you, type just <code className="ph-sensitive ph-mask font-mono">{setup?.label ?? host.split(".")[0]}</code>.</>
            }
            aside={setup ? <Button variant="ghost" size="sm" iconLeft="download" onClick={() => { downloadGuideRecordCsv(setup); guideEvents.domainHandoff("csv"); }}>Download as CSV</Button> : undefined}
          >
            <div className="ph-sensitive ph-mask flex min-w-0 flex-col gap-3">
              <RecordBlock
                label="CNAME record"
                purpose="Sends readers to the guide"
                type={setup?.record.type ?? "CNAME"}
                name={setup ? (p?.detected ? setup.record.host : setup.record.name) : host}
                value={setup?.record.value ?? site.own_domains?.target ?? "cname.guides.markdrop.in"}
                nameLabel={p?.detected ? p.host_field || "Name" : "Name"}
                valueLabel={p?.detected ? p.value_field || "Value" : "Value"}
                extra={p?.detected ? (p.extras ?? []).map((x): [string, string] => [x.label, x.value]) : undefined}
                found={setup ? (setup.record_seen === null ? null : seen) : undefined}
              />
              {extraRecords.length > 0 && (
                <details className="min-w-0 rounded-lg border border-border px-3 py-2">
                  <summary className="cursor-pointer text-caption text-text-secondary">
                    Domain behind another proxy or CDN, or want it checked before you switch the CNAME? Add these too.
                  </summary>
                  <div className="mt-3 flex min-w-0 flex-col gap-3">
                    {extraRecords.map((r) => (
                      <RecordBlock key={`${r.type}-${r.name}`} label={PURPOSE[r.purpose]?.label ?? `${r.type} record`} purpose={PURPOSE[r.purpose]?.purpose} type={r.type} name={r.name} value={r.value} />
                    ))}
                  </div>
                </details>
              )}
            </div>
          </SettingsCard>

          {handoff && setup && (
            <SettingsCard id="handoff" title="Someone else runs your DNS?" description="Send them this. It has the record, where to add it, and a link to check it worked.">
              <div className="ph-sensitive ph-mask whitespace-pre-line rounded-lg bg-surface-inset px-4 py-3.5 text-[13px] leading-5 text-text-secondary [overflow-wrap:anywhere]">{handoff.body}</div>
              <div className="flex flex-wrap gap-2">
                <CopyButton text={handoff.body} label="Copy message" variant="secondary" size="sm" announceText="Message copied" onCopy={() => guideEvents.domainHandoff("copy")} />
                <Button variant="secondary" size="sm" iconLeft="mail" href={handoff.mailto} onClick={() => guideEvents.domainHandoff("email")}>Send by email</Button>
                <CopyButton text={setup.check_url} label="Copy a link to these steps" variant="ghost" size="sm" announceText="Link copied" onCopy={() => guideEvents.domainHandoff("link")} />
              </div>
            </SettingsCard>
          )}
        </>
      )}

      {d.status !== "removing" && (
        <SettingsCard
          id="status"
          title="Status"
          aside={
            <>
              {!live && <span className="text-caption text-text-muted">{isAdmin ? "Checking every minute" : "Markdrop keeps checking"}{checkedAgo ? ` · last check ${checkedAgo}` : ""}</span>}
              {isAdmin && site.own_domains?.available && <Button variant="ghost" size="sm" iconLeft="refresh" loading={checking} onClick={() => void checkNow()}>Check now</Button>}
            </>
          }
        >
          <StatusList rows={statusRows} />
          {live ? (
            <p className="text-caption text-text-muted">Readers get the guide here. Links, the sitemap and search results use this domain. Keep the CNAME record in place.</p>
          ) : (
            <p className="text-caption text-text-muted">
              You can leave this page.{setup?.emails_you ? <> We&apos;ll email you when <span className="ph-sensitive ph-mask">{host}</span> is live.</> : " Markdrop keeps checking for 3 days."}{" "}
              <ReadMore topic="studioDomain" />
            </p>
          )}
        </SettingsCard>
      )}

      {isAdmin && d.status !== "removing" && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" iconLeft="trash" onClick={() => setConfirm("remove")}>Remove this domain</Button>
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === "change" ? "Use another domain?" : <>Remove <span className="ph-sensitive ph-mask">{host}</span>?</>}
        body={confirm === "change"
          ? <>Markdrop stops setting up <span className="ph-sensitive ph-mask">{host}</span>, and you type the domain you want instead.</>
          : live
            ? "The guide stops answering there right away, and links to it fail. Links, the sitemap and search results go back to the free address. You can delete the DNS record afterwards."
            : "Markdrop stops checking it. You can delete the DNS record afterwards."}
        confirmLabel={confirm === "change" ? "Use another domain" : "Remove domain"}
        onConfirm={async () => {
          const change = confirm === "change";
          try {
            setSite(await removeSiteDomain(site.id, host));
            if (change) router.replace(`${base}/settings/domains/new?host=${encodeURIComponent(host)}`);
            else {
              toast.success(<><span className="ph-sensitive ph-mask">{host}</span> is being removed.</>);
              router.replace(settingsHref(base, "domains"));
            }
          } catch (err) {
            toast.error(docsErrorMessage(err, "Couldn't remove it. Try again."));
          }
          setConfirm(null);
        }}
      />
    </>
  );
}

/**
 * Settings › Domains › a domain (DomainSetup.dc.html): the stepper, then DNS (one-click Domain
 * Connect where the provider offers it, the provider's own panel and words, the record with a CSV,
 * a message for whoever runs the DNS with a public check link) and the live status, which re-checks
 * on its own while the page is open. `host` null: step 1, adding one.
 */
export default function DomainSetup({ host }: { host: string | null }) {
  const { site, base } = useSite();
  if (host === null) return <AddDomain />;
  const d = ownDomains(site.domains).find((x) => x.host === host.toLowerCase());
  if (!d) {
    return (
      <EmptyState
        icon="globe"
        title="That domain isn't on this guide"
        description="It may have been removed. The guide's addresses are under Domains."
        actions={<Button variant="secondary" href={settingsHref(base, "domains")} iconLeft="arrowLeft">Domains</Button>}
      />
    );
  }
  return <DomainSteps d={d} />;
}
