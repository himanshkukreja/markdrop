"use client";

import { useState } from "react";
import {
  Alert, Badge, Button, ConfirmDialog, Dialog, Field, Icon, Input, RadioGroup, RowMenu,
  Skeleton, useToast, type MenuItem,
} from "@/components/ui";
import DnsInstructions from "@/components/workspace/DnsInstructions";
import DomainStepper from "@/components/workspace/DomainStepper";
import { downloadDnsCsv } from "@/lib/dnsCsv";
import { ReadMore } from "@/components/ReadMore";
import {
  addDomain, attachDomain, detachDomain, errorStatus, removeDomain, setPrimaryDomain, verifyDomain,
  type Domain, type DomainKind,
} from "@/lib/workspaces";
import { shortDate } from "../../../settings-shared";
import { Locked, lockProps, type WsTabProps } from "../ws-shared";

function statusBadge(d: Domain) {
  if (d.status === "verified") {
    return d.attached
      ? <Badge size="sm" tone="success" dot>{d.kind === "cdn" ? "Serving" : "Live"}</Badge>
      : <Badge size="sm" tone="info" icon="checkCircle">Verified, not serving</Badge>;
  }
  if (d.status === "lapsed") return <Badge size="sm" tone="danger" icon="alertCircle">Lapsed</Badge>;
  if (d.status === "failed") return <Badge size="sm" tone="danger" icon="alertCircle">Verification failed</Badge>;
  return <Badge size="sm" tone="warning" icon="clock">Awaiting DNS</Badge>;
}

/** What a failed domain call means to a person, by status (501: the server doesn't do domains). */
function domainError(e: unknown, fallback: string): string {
  const s = errorStatus(e);
  if (s === 501) return "Custom domains aren't switched on for this Markdrop server yet. Your records are safe to leave in place.";
  if (s === 409) return e instanceof Error && e.message ? e.message : "Another workspace already verified that domain.";
  if (s === 403) return "Only admins can change domains.";
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * "Your own domain" (Settings › Look and domain): one row per domain (host, status, menu: Make
 * default · Show DNS records · … · Remove), and "Add another domain". A domain that isn't live yet
 * shows its stepper — Added → DNS records → Verified → Live — and the records under its row. Both records stay on
 * show (collapsed once verified, because they must stay in place). "Check DNS" verifies and, when
 * that succeeds, attaches the domain and makes the first verified app domain primary, so "verified"
 * is never a dead end waiting for a second button. Detach (stop serving, keep the verification) and
 * Remove (discard it) stay in the menu behind a confirm.
 */
export default function DomainsCard({ id, ws, isAdmin, domains, refresh }: WsTabProps) {
  const toast = useToast();
  const [busy, setBusy] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [host, setHost] = useState("");
  const [kind, setKind] = useState<DomainKind>("app");
  const [addError, setAddError] = useState("");
  const [confirm, setConfirm] = useState<{ domain: Domain; action: "detach" | "remove" } | null>(null);
  const [recordsOpen, setRecordsOpen] = useState<Set<string>>(new Set());
  const siteName = ws.branding.site_name || undefined;

  async function run(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    try {
      await fn();
      await refresh("domains");
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(domainError(e, "Something went wrong. Try again."));
    } finally {
      setBusy("");
    }
  }

  /** Check DNS, then (on success) go live and pick a primary, in one press. */
  async function checkAndGoLive(d: Domain) {
    setBusy(`v${d.id}`);
    try {
      const v = await verifyDomain(id, d.id);
      if (v.status === "verified") {
        // The server already attaches a verified domain (and makes the first one primary) when it
        // can. Attach here only when that didn't happen and the routing record isn't known to be
        // missing; without hosting credentials (501) going live waits for the routing record.
        let live = v.live ?? v.attached;
        if (!live && v.routing_ok === false) {
          toast.info(`${d.host} is verified. The routing record isn't visible yet; it goes live once it is.`);
        } else if (!live) {
          try {
            const a = await attachDomain(id, d.id);
            live = a?.attached ?? true;
          } catch (e) {
            if (errorStatus(e) === 501) {
              toast.info(`${d.host} is verified. It goes live as soon as the routing record is visible.`);
            } else {
              toast.error(`${d.host} is verified, but going live failed: ${domainError(e, "try again in a minute.")}`);
            }
          }
        }
        if (live) toast.success(`${d.host} is live.`);
      } else {
        const missing = v.txt_ok === false && v.routing_ok === false ? "Neither record is visible yet"
          : v.txt_ok === false ? "The ownership record isn't visible yet"
          : v.routing_ok === false ? "The routing record isn't visible yet"
          : "The records aren't visible yet";
        toast.info(`${missing}. DNS changes can take up to an hour; check again then.`);
      }
      await refresh("domains");
    } catch (e) {
      toast.error(domainError(e, "Couldn't check DNS. Try again."));
    } finally {
      setBusy("");
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const h = host.trim().toLowerCase();
    if (!h) { setAddError("Enter a hostname like docs.yourcompany.com."); return; }
    setBusy("add");
    setAddError("");
    try {
      await addDomain(id, h, kind);
      await refresh("domains");
      setAddOpen(false);
      setHost("");
      toast.success(`${h} added. Add the two DNS records below, then press Check DNS.`);
    } catch (err) {
      setAddError(domainError(err, "Couldn't add that domain. Try again."));
    } finally {
      setBusy("");
    }
  }

  function toggleRecords(domainId: string, open: boolean) {
    setRecordsOpen((s) => { const n = new Set(s); if (open) n.add(domainId); else n.delete(domainId); return n; });
  }

  function menuFor(d: Domain): MenuItem[] {
    const items: MenuItem[] = [];
    if (d.status === "verified" && d.kind === "app" && !d.is_primary) {
      // With several domains the oldest one was silently chosen, so a newer one could never become
      // the address the product hands out.
      items.push({ label: "Make default", icon: "check", description: "Use it for shared links and preview cards", onClick: () => run(`p${d.id}`, () => setPrimaryDomain(id, d.id), `${d.host} is now the default domain.`) });
    }
    if (d.status === "verified") {
      items.push({ label: recordsOpen.has(d.id) ? "Hide DNS records" : "Show DNS records", icon: "list", onClick: () => toggleRecords(d.id, !recordsOpen.has(d.id)) });
      items.push({ label: "Check DNS again", icon: "refresh", onClick: () => run(`v${d.id}`, () => verifyDomain(id, d.id), `Checked ${d.host}.`) });
    }
    items.push({ label: "Download records (CSV)", icon: "download", onClick: () => downloadDnsCsv([d]) });
    if (d.attached) {
      items.push({ label: "Detach", icon: "pause", description: "Stop serving, keep it verified", separated: true, onClick: () => setConfirm({ domain: d, action: "detach" }) });
    }
    items.push({ label: "Remove domain", icon: "trash", danger: true, separated: !d.attached, onClick: () => setConfirm({ domain: d, action: "remove" }) });
    return items;
  }

  function primaryAction(d: Domain) {
    if (d.status !== "verified") {
      return (
        <Locked locked={!isAdmin}>
          <Button size="sm" variant="primary" iconLeft="search" loading={busy === `v${d.id}`}
            {...lockProps(!isAdmin)}
            onClick={isAdmin ? () => void checkAndGoLive(d) : lockProps(true).onClick}>
            {d.status === "lapsed" ? "Check DNS again" : "Check DNS"}
          </Button>
        </Locked>
      );
    }
    if (!d.attached) {
      return (
        <Locked locked={!isAdmin}>
          <Button size="sm" variant="primary" iconLeft="zap" loading={busy === `a${d.id}`}
            {...lockProps(!isAdmin)}
            onClick={isAdmin ? () => run(`a${d.id}`, () => attachDomain(id, d.id), `${d.host} is live.`) : lockProps(true).onClick}>
            Go live
          </Button>
        </Locked>
      );
    }
    if (d.kind === "app") {
      return <Button size="sm" variant="ghost" iconLeft="external" href={`https://${d.host}`} target="_blank" rel="noreferrer noopener" aria-label={`Visit ${d.host}`}>Visit</Button>;
    }
    return null;
  }

  return (
    <section aria-labelledby="ws-domain-h" className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-5">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <h2 id="ws-domain-h" className="flex-1 text-h3 text-text">Your own domain</h2>
        <ReadMore topic="customDomain" className="text-caption">Setup guide</ReadMore>
        {isAdmin && domains && domains.length > 1 && (
          <Button variant="ghost" size="sm" iconLeft="download" onClick={() => downloadDnsCsv(domains)} title="Download every DNS record for this workspace as CSV">
            Records as CSV
          </Button>
        )}
      </div>

      {domains === null ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading domains">
          {[0, 1].map((i) => <Skeleton key={i} variant="rect" height={52} />)}
        </div>
      ) : domains.length === 0 ? (
        <p className="text-body text-text-secondary">
          Serve this workspace from a hostname you own, like <code className="font-mono">docs.yourcompany.com</code>. Links on markdrop.in keep working.
        </p>
      ) : (
        <ul className="m-0 flex min-w-0 list-none flex-col gap-3 p-0">
          {domains.map((d) => (
            <li key={d.id} className="min-w-0">
              <div className="min-w-0 rounded-lg border border-border">
                <div className="flex min-w-0 flex-wrap items-center gap-3 px-3.5 py-3">
                  <Icon name="globe" size={18} className="shrink-0 text-text-secondary" />
                  <h3 className="min-w-0 flex-1 font-mono text-[13px] font-medium text-text [overflow-wrap:anywhere]">{d.host}</h3>
                  {statusBadge(d)}
                  {d.kind === "cdn" && <Badge size="sm" variant="outline">Files only</Badge>}
                  {d.kind === "app" && d.is_primary && d.status === "verified" && domains.length > 1 && (
                    <Badge size="sm" tone="info" icon="check" title="Used for shared links and preview cards">Default</Badge>
                  )}
                  {(d.status !== "verified" || !d.attached) && primaryAction(d)}
                  {isAdmin && <RowMenu portal align="right" label={`Domain actions for ${d.host}`} items={menuFor(d)} />}
                </div>
                <div className={`flex min-w-0 flex-col gap-3 px-3.5 pb-3.5 ${d.status === "verified" && d.attached && !recordsOpen.has(d.id) ? "hidden" : ""}`}>
                  {(d.status !== "verified" || !d.attached) && <DomainStepper domain={d} className="rounded-lg border border-border bg-surface-inset p-3" />}
                  <p className="text-caption text-text-muted">
                    {d.status === "verified"
                      ? `${d.attached ? "Serving" : "Verified"} since ${shortDate(d.verified_at)}${d.last_checked_at ? ` · Last checked ${shortDate(d.last_checked_at)}` : ""}`
                      : d.status === "lapsed"
                        ? `Stopped serving after its records failed checks for three days${d.last_checked_at ? ` · Last checked ${shortDate(d.last_checked_at)}` : ""}`
                        : d.last_checked_at ? `Last checked ${shortDate(d.last_checked_at)}` : `Added ${shortDate(d.created_at)}, not checked yet`}
                  </p>
                  {d.status === "lapsed" && (
                    <Alert tone="danger" title={`${d.host} isn't serving`}>
                      Its DNS records stopped resolving to Markdrop. Put both records back, then check again; links on markdrop.in kept working throughout.
                    </Alert>
                  )}
                  {d.last_error && d.status !== "lapsed" && <Alert tone="warning">{d.last_error}</Alert>}
                  {d.warning && <p className="text-caption text-text-secondary">{d.warning}</p>}
                  {/* The records (and the TXT token that proves ownership) are admin-only: the
                      server sends them only to admins and the owner. */}
                  {!isAdmin ? (
                    d.status !== "verified" && (
                      <p className="text-caption text-text-secondary">An admin of this workspace finishes setting up this domain.</p>
                    )
                  ) : d.status === "verified" ? (
                    recordsOpen.has(d.id) && (
                      <div className="flex flex-col gap-2">
                        <DnsInstructions workspaceId={id} domain={d} siteName={siteName} settled />
                        <Button size="sm" variant="ghost" className="self-start" onClick={() => toggleRecords(d.id, false)}>Hide DNS records</Button>
                      </div>
                    )
                  ) : (
                    <DnsInstructions workspaceId={id} domain={d} siteName={siteName} />
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {domains !== null && (
        <Locked locked={!isAdmin} className="self-start">
          <Button variant={domains.length ? "secondary" : "primary"} iconLeft="plus" className="self-start" {...lockProps(!isAdmin)}
            onClick={isAdmin ? () => { setAddOpen(true); setAddError(""); } : lockProps(true).onClick}>
            {domains.length ? "Add another domain" : "Add a domain"}
          </Button>
        </Locked>
      )}
      {!isAdmin && domains !== null && domains.length === 0 && (
        <p className="text-caption text-text-muted">An admin of this workspace sets up domains.</p>
      )}

      <Dialog
        open={addOpen}
        onClose={() => busy !== "add" && setAddOpen(false)}
        dismissible={busy !== "add"}
        title="Add domain"
        description="Any hostname you control. You'll add two DNS records next."
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)} disabled={busy === "add"}>Cancel</Button>
            <Button variant="primary" type="submit" form="add-domain" loading={busy === "add"}>Add domain</Button>
          </>
        }
      >
        <form id="add-domain" onSubmit={add} className="flex min-w-0 flex-col gap-5" noValidate>
          <Field label="Hostname" error={addError || undefined}>
            <Input mono value={host} onChange={(e) => { setHost(e.target.value); if (addError) setAddError(""); }} placeholder="docs.yourcompany.com" autoComplete="off" spellCheck={false} inputMode="url" />
          </Field>
          <div className="flex flex-col gap-2">
            <span id="domain-kind" className="md-field__label">What it serves</span>
            <RadioGroup
              name="domain-kind"
              aria-labelledby="domain-kind"
              value={kind}
              onChange={(v) => setKind(v as DomainKind)}
              options={[
                { value: "app", label: "Documents and files", description: "Document pages and uploaded files. The usual choice." },
                { value: "cdn", label: "Files only", description: "A plain file host for raw bytes, with no document pages." },
              ]}
            />
          </div>
        </form>
      </Dialog>

      {/* Detach takes a live site off the air; Remove also discards a verification that cost DNS
          propagation to earn. Both name the host so there is no doubt which row was clicked. */}
      <ConfirmDialog
        open={confirm?.action === "detach"}
        onClose={() => setConfirm(null)}
        tone="default"
        title={confirm ? `Detach ${confirm.domain.host}?` : "Detach domain?"}
        body="It stops serving immediately and links to it fail. The domain stays verified, so you can attach it again later without touching DNS."
        confirmLabel="Detach domain"
        onConfirm={async () => {
          const d = confirm!.domain;
          await detachDomain(id, d.id);
          setConfirm(null);
          await refresh("domains");
          toast.success(`${d.host} is no longer serving, but stays verified.`);
        }}
      />
      <ConfirmDialog
        open={confirm?.action === "remove"}
        onClose={() => setConfirm(null)}
        title={confirm ? `Remove ${confirm.domain.host}?` : "Remove domain?"}
        body={
          confirm ? (
            <>
              {confirm.domain.attached ? "It stops serving immediately and links to it fail. " : ""}
              This also discards its verification, so adding it back means adding the DNS records and waiting for them to propagate
              again. Documents keep working on markdrop.in.
              {confirm.domain.attached ? " To pause it instead, use Detach." : ""}
            </>
          ) : undefined
        }
        confirmLabel="Remove domain"
        onConfirm={async () => {
          const d = confirm!.domain;
          await removeDomain(id, d.id);
          setConfirm(null);
          await refresh("domains");
          toast.success(`${d.host} removed.`);
        }}
      />
    </section>
  );
}
