"use client";

import { useState } from "react";
import {
  Alert, Badge, Button, Card, ConfirmDialog, Dialog, EmptyState, Field, Input, RadioGroup, RowMenu,
  Skeleton, useToast, type MenuItem,
} from "@/components/ui";
import DnsInstructions from "@/components/workspace/DnsInstructions";
import { downloadDnsCsv } from "@/lib/dnsCsv";
import {
  addDomain, attachDomain, detachDomain, removeDomain, setPrimaryDomain, verifyDomain,
  type Domain, type DomainKind,
} from "@/lib/workspaces";
import { shortDate } from "../../../settings-shared";
import { Locked, SectionHead, lockProps, type WsTabProps } from "../ws-shared";

function statusBadge(d: Domain) {
  if (d.status === "verified") {
    return d.attached
      ? <Badge size="sm" tone="success" dot>Live</Badge>
      : <Badge size="sm" tone="info" icon="checkCircle">Verified, not serving</Badge>;
  }
  if (d.status === "failed") return <Badge size="sm" tone="danger" icon="alertCircle">Verification failed</Badge>;
  return <Badge size="sm" tone="warning" icon="clock">Awaiting DNS</Badge>;
}

/**
 * Domains, v1 (REVAMP_PLAN 7.12): today's record list restyled — a card per domain with its status,
 * one in-card action for its state (Check DNS for an unverified domain, Attach for a verified one
 * that isn't serving), everything else in a RowMenu. Detach (stop serving, keep the verification)
 * and Remove (discard the verification) stay separate, both behind a confirm. Stepper, StatusPath
 * and the provider strip are v2.
 */
export default function DomainsTab({ id, ws, isAdmin, domains, refresh }: WsTabProps) {
  const toast = useToast();
  const [busy, setBusy] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [host, setHost] = useState("");
  const [kind, setKind] = useState<DomainKind>("app");
  const [addError, setAddError] = useState("");
  const [confirm, setConfirm] = useState<{ domain: Domain; action: "detach" | "remove" } | null>(null);
  const siteName = ws.branding.site_name || undefined;

  async function run(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    try {
      await fn();
      await refresh("domains");
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong. Try again.");
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
      toast.success(`${h} added. Add the DNS records below to verify it.`);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Couldn't add that domain. Try again.");
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
          <Button size="sm" variant="secondary" iconLeft="search" loading={busy === `v${d.id}`}
            {...lockProps(!isAdmin)}
            onClick={isAdmin ? () => run(`v${d.id}`, () => verifyDomain(id, d.id)) : lockProps(true).onClick}>
            Check DNS
          </Button>
        </Locked>
      );
    }
    if (!d.attached) {
      return (
        <Locked locked={!isAdmin}>
          <Button size="sm" variant="secondary" loading={busy === `a${d.id}`}
            {...lockProps(!isAdmin)}
            onClick={isAdmin ? () => run(`a${d.id}`, () => attachDomain(id, d.id), `${d.host} is live.`) : lockProps(true).onClick}>
            Attach
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
            {domains && domains.length > 0 && (
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
                      {d.is_primary && <Badge size="sm" variant="outline" icon="flag">Primary</Badge>}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {primaryAction(d)}
                      {isAdmin && <RowMenu portal align="right" label={`More actions for ${d.host}`} items={menuFor(d)} />}
                    </div>
                  </div>
                  <p className="text-caption text-text-muted">
                    {d.status === "verified"
                      ? `${d.attached ? "Serving" : "Verified"} since ${shortDate(d.verified_at)}`
                      : d.last_checked_at ? `Last checked ${shortDate(d.last_checked_at)}` : `Added ${shortDate(d.created_at)}, not checked yet`}
                  </p>
                  {d.last_error && <Alert tone="warning">{d.last_error}</Alert>}
                  {d.warning && <p className="text-caption text-text-secondary">{d.warning}</p>}
                  {d.status !== "verified" && <DnsInstructions workspaceId={id} domain={d} siteName={siteName} />}
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
