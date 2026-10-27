"use client";

import { useState } from "react";
import {
  Alert, Badge, Button, Card, ConfirmDialog, Dialog, Disclosure, EmptyState, Field, Input, RadioGroup, RowMenu,
  Skeleton, useToast, type MenuItem,
} from "@/components/ui";
import DnsInstructions from "@/components/workspace/DnsInstructions";
import DomainStepper from "@/components/workspace/DomainStepper";
import { downloadDnsCsv } from "@/lib/dnsCsv";
import {
  addDomain, attachDomain, detachDomain, errorStatus, removeDomain, setPrimaryDomain, verifyDomain,
  type Domain, type DomainKind,
} from "@/lib/workspaces";
import { shortDate } from "../../../settings-shared";
import { Locked, SectionHead, lockProps, type WsTabProps } from "../ws-shared";

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
 * Domains (P5): a stepper per domain — Added → DNS records → Verified → Live. Both records stay on
 * show (collapsed once verified, because they must stay in place). "Check DNS" verifies and, when
 * that succeeds, attaches the domain and makes the first verified app domain primary, so "verified"
 * is never a dead end waiting for a second button. Detach (stop serving, keep the verification) and
 * Remove (discard it) stay in the menu behind a confirm.
 */
export default function DomainsTab({ id, ws, isAdmin, domains, refresh }: WsTabProps) {
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

  function menuFor(d: Domain): MenuItem[] {
    const items: MenuItem[] = [];
    if (d.status === "verified") {
      items.push({ label: "Check DNS again", icon: "refresh", onClick: () => run(`v${d.id}`, () => verifyDomain(id, d.id), `Checked ${d.host}.`) });
    }
    if (d.status === "verified" && d.kind === "app" && !d.is_primary) {
      // With several domains the oldest one was silently chosen, so a newer one could never become
      // the address the product hands out.
      items.push({ label: "Make primary", icon: "flag", description: "Use it for shared links and preview cards", onClick: () => run(`p${d.id}`, () => setPrimaryDomain(id, d.id), `${d.host} is now the primary domain.`) });
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

  const addButton = (
    <Locked locked={!isAdmin}>
      <Button variant="primary" iconLeft="plus" {...lockProps(!isAdmin)} onClick={isAdmin ? () => { setAddOpen(true); setAddError(""); } : lockProps(true).onClick}>
        Add domain
      </Button>
    </Locked>
  );

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <SectionHead
        title="Domains"
        description="Serve this workspace's documents from hostnames you own."
        actions={
          <>
            {isAdmin && domains && domains.length > 0 && (
              <Button variant="ghost" size="sm" iconLeft="download" onClick={() => downloadDnsCsv(domains)} title="Download every DNS record for this workspace as CSV">
                Download all as CSV
              </Button>
            )}
            {addButton}
          </>
        }
      />

      {domains === null ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading domains">
          {[0, 1].map((i) => <Skeleton key={i} variant="rect" height={72} />)}
        </div>
      ) : domains.length === 0 ? (
        <EmptyState
          icon="globe"
          title="No domains yet"
          description="Add a hostname you control, like docs.yourcompany.com, to serve this workspace's documents from it."
          actions={isAdmin ? addButton : undefined}
        />
      ) : (
        <ul className="flex min-w-0 flex-col gap-4">
          {domains.map((d) => (
            <li key={d.id} className="min-w-0">
              <Card compact className="min-w-0">
                <div className="flex min-w-0 flex-col gap-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                      <h3 className="min-w-0 font-mono text-body-strong text-text [overflow-wrap:anywhere]">{d.host}</h3>
                      {statusBadge(d)}
                      <Badge size="sm" variant="outline">{d.kind === "app" ? "Documents and files" : "Files only"}</Badge>
                      {d.kind === "app" && d.is_primary && d.status === "verified" && (
                        <Badge size="sm" tone="info" icon="flag" title="Used for shared links and preview cards">Primary</Badge>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {primaryAction(d)}
                      {isAdmin && <RowMenu portal align="right" label={`More actions for ${d.host}`} items={menuFor(d)} />}
                    </div>
                  </div>
                  <DomainStepper domain={d} className="rounded-lg border border-border bg-surface-inset p-3" />
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
                    <Disclosure
                      summary="DNS records"
                      open={recordsOpen.has(d.id)}
                      onOpenChange={(o) => setRecordsOpen((s) => { const n = new Set(s); if (o) n.add(d.id); else n.delete(d.id); return n; })}
                    >
                      {recordsOpen.has(d.id) && <DnsInstructions workspaceId={id} domain={d} siteName={siteName} settled />}
                    </Disclosure>
                  ) : (
                    <DnsInstructions workspaceId={id} domain={d} siteName={siteName} />
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <p className="max-w-[72ch] text-caption text-text-muted">
        Uploaded files always stream from an isolated file origin, whichever kind you pick. That is what stops a published HTML
        page from reaching anyone&apos;s session. A Documents and files host renders them in a page on your domain; a Files only
        host serves the raw bytes and runs no app, which is why it can&apos;t also show document pages.
      </p>

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
    </div>
  );
}
