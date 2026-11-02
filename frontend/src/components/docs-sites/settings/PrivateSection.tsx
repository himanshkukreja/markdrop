"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Alert, Badge, Button, Dialog, EmptyState, Field, Icon, Input, SegmentedControl, Select, Switch, Textarea, cx, useToast } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { docsErrorMessage } from "@/lib/docsSites";
import {
  ACTIONS, createRule, decideRequest, deleteRule, getAudit, getPrivate, previewAs, putGroups, ruleLabel, ruleWho, signOutReaders, splitPeople, updateRule,
  type AccessRule, type AuditEntry, type Preview, type PrivateState,
} from "@/lib/guidePrivate";
import { useSite } from "../SiteContext";
import { SectionHeader, SettingsCard } from "./SettingsShell";
import { SECTIONS } from "./sections";

const KIND_ICON: Record<string, string> = { members: "users", people: "mail", password: "key" };

function fmtDate(s: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Create or edit a rule: a name readers see, who it lets in, whether its pages show in the nav. */
function RuleDialog({ open, kind, rule, onClose, onSaved }: {
  open: boolean; kind: "people" | "password"; rule: AccessRule | null; onClose: () => void; onSaved: (s: PrivateState, msg: string) => void;
}) {
  const { site } = useSite();
  const uid = useId();
  const [name, setName] = useState("");
  const [people, setPeople] = useState("");
  const [password, setPassword] = useState("");
  const [nav, setNav] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(rule?.name ?? "");
    setPeople([...(rule?.domains ?? []).map((d) => `@${d}`), ...(rule?.emails ?? [])].join("\n"));
    setPassword("");
    setNav(rule ? rule.nav === "show" : kind === "people");
    setError("");
  }, [open, rule, kind]);
  const parsed = useMemo(() => splitPeople(people), [people]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      if (rule) {
        const body: Parameters<typeof updateRule>[2] = { nav: nav ? "show" : "hide" };
        if (!rule.builtin) body.name = name.trim();
        if (kind === "people") Object.assign(body, parsed);
        if (kind === "password" && password) body.password = password;
        const r = await updateRule(site.id, rule.id, body);
        onSaved(r.private, kind === "password" && password ? "Password changed. Readers with the old one are locked out." : "Rule saved. Readers see the change within a minute.");
      } else {
        const r = await createRule(site.id, { kind, name: name.trim(), nav: nav ? "show" : "hide", ...(kind === "people" ? parsed : { password }) });
        onSaved(r.private, `${r.rule.name} added. Choose it in a page's Page tab, or for a section.`);
      }
    } catch (e) {
      setError(docsErrorMessage(e, "That didn't save."));
    } finally {
      setBusy(false);
    }
  }

  const builtin = !!rule?.builtin;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title={rule ? `Edit ${ruleLabel(rule)}` : kind === "people" ? "Specific people or email domains" : "Password"}
      description={kind === "people" ? "They sign in with their email: we send a one-time link. No Markdrop account needed." : "Anyone with the password opens these pages. Share it yourself."}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()} disabled={!builtin && !name.trim()}>{rule ? "Save" : "Add rule"}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {!builtin && (
          <Field label="Name readers see" htmlFor={`${uid}-name`} hint={kind === "people" ? "Usually the customer: “Only people at Northwind can open it.”" : "Shown on the lock: “Partners”."}>
            <Input id={`${uid}-name`} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={kind === "people" ? "Northwind" : "Partners"} />
          </Field>
        )}
        {kind === "people" && (
          <Field label="People and email domains" htmlFor={`${uid}-people`} hint={`One per line or comma separated. @northwind.com lets in everyone with an address there. ${parsed.emails.length} ${parsed.emails.length === 1 ? "person" : "people"}, ${parsed.domains.length} ${parsed.domains.length === 1 ? "domain" : "domains"}.`}>
            <Textarea id={`${uid}-people`} className="ph-no-capture" rows={5} mono value={people} onChange={(e) => setPeople(e.target.value)} placeholder={"@northwind.com\njane@partner.io"} />
          </Field>
        )}
        {kind === "password" && (
          <Field label={rule?.has_password ? "New password (leave empty to keep it)" : "Password"} htmlFor={`${uid}-pw`} hint="At least 6 characters. Changing it locks out everyone who used the old one.">
            <Input id={`${uid}-pw`} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        )}
        <Switch label="List its pages in the navigation, with a lock" checked={nav} onChange={(e) => setNav(e.target.checked)} />
        <p className="-mt-2 text-[13px] text-text-muted">{nav ? "Everyone sees the page titles; only allowed readers can open them." : "Hidden from the navigation, search and llms.txt. Share the link with the people it's for."}</p>
      </div>
    </Dialog>
  );
}

function RuleRow({ rule, admin, onEdit, onDelete }: { rule: AccessRule; admin: boolean; onEdit: () => void; onDelete: () => void }) {
  return (
    <li className="flex flex-wrap items-start gap-3 border-t border-border py-3.5 first:border-t-0 first:pt-0">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface-inset text-text-secondary" aria-hidden>
        <Icon name={KIND_ICON[rule.kind] ?? "lock"} size={15} />
      </span>
      <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <strong className="text-body-strong text-text">{ruleLabel(rule)}</strong>
          {rule.builtin && <Badge size="sm">Built in</Badge>}
          <Badge size="sm" tone={rule.nav === "show" ? "info" : "neutral"} icon={rule.nav === "show" ? "eye" : "eyeOff"}>{rule.nav === "show" ? "In the navigation" : "Hidden"}</Badge>
        </span>
        <span className="text-[13px] text-text-muted">{ruleWho(rule)}</span>
        <span className="text-[12px] text-text-muted">{rule.pages ? `Used by ${rule.pages} ${rule.pages === 1 ? "page" : "pages"}` : "Not used yet"}</span>
      </div>
      {admin && (
        <span className="flex shrink-0 gap-1.5">
          <Button size="sm" variant="secondary" onClick={onEdit}>Edit</Button>
          {!rule.builtin && <Button size="sm" variant="ghost" onClick={onDelete} aria-label={`Delete ${rule.name}`}><Icon name="trash" size={14} /></Button>}
        </span>
      )}
    </li>
  );
}

/** Preview as: who can open each page, after the next publish. */
function PreviewCard({ state }: { state: PrivateState }) {
  const { site } = useSite();
  const uid = useId();
  const [mode, setMode] = useState<Preview["as"]>("public");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState<string[]>([]);
  const [data, setData] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const pwRules = state.rules.filter((r) => r.kind === "password");
  const label = (id: string | null) => {
    const r = state.rules.find((x) => x.id === id);
    return r ? ruleLabel(r) : id ?? "";
  };
  const run = useCallback(async () => {
    setError("");
    if (mode === "email" && !email.includes("@")) return;
    try {
      setData(await previewAs(site.id, mode, { email: mode === "email" ? email.trim() : undefined, rules: mode === "password" ? pw : undefined }));
    } catch (e) {
      setError(docsErrorMessage(e, "Couldn't preview."));
    }
  }, [site.id, mode, email, pw]);
  useEffect(() => {
    if (mode !== "email") void run();
  }, [mode, pw]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = (data?.pages ?? []).filter((r) => r.rule || r.sections.length);
  return (
    <SettingsCard id="preview" title="Preview as" description="Check who can open what, as of your drafts (it reaches readers when you publish).">
      <div className="flex flex-wrap items-center gap-2.5">
        <SegmentedControl
          aria-label="Preview as"
          value={mode}
          onChange={(v) => setMode(v as Preview["as"])}
          options={[
            { value: "public", label: "Public reader" },
            { value: "member", label: "Team member" },
            { value: "email", label: "An email" },
            ...(pwRules.length ? [{ value: "password", label: "Password" }] : []),
          ]}
        />
        {mode === "email" && (
          <form className="flex min-w-0 flex-[1_1_260px] gap-2" onSubmit={(e) => { e.preventDefault(); void run(); }}>
            <Input aria-label="Email to preview as" className="ph-no-capture min-w-0 flex-1" type="email" size="sm" placeholder="ana@northwind.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Button size="sm" variant="secondary" type="submit">Check</Button>
          </form>
        )}
        {mode === "password" && (
          <span className="flex flex-wrap gap-3">
            {pwRules.map((r) => (
              <label key={r.id} className="flex items-center gap-1.5 text-[13px] text-text-secondary">
                <input type="checkbox" checked={pw.includes(r.id)} onChange={(e) => setPw((cur) => (e.target.checked ? [...cur, r.id] : cur.filter((x) => x !== r.id)))} />
                Knows the {r.name} password
              </label>
            ))}
          </span>
        )}
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {data && (
        <>
          <p className="text-[13px] text-text-muted" role="status">
            {data.as === "member" ? "Team members open every page." : `${data.open} of ${data.pages.length} pages open; ${data.locked} locked.`}
          </p>
          {rows.length === 0 ? (
            <p className="text-[13px] text-text-muted">No private pages or sections yet. Choose who can open a page in its Page tab, or add a Private section from the editor&apos;s / menu.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border" aria-labelledby={`${uid}-t`}>
              {rows.map((r) => (
                <li key={r.path} className="flex flex-wrap items-center gap-2.5 px-3 py-2.5">
                  <Icon name={r.open ? "checkCircle" : "lock"} size={15} className={r.open ? "text-success" : "text-text-muted"} />
                  <span className="flex min-w-0 flex-[1_1_200px] flex-col">
                    <span className="truncate text-body-strong text-text">{r.title}</span>
                    <span className="truncate font-mono text-[12px] text-text-muted">{r.path}</span>
                  </span>
                  {r.rule && <Badge size="sm" tone={r.unknown_rule ? "danger" : "neutral"} icon="lock">{r.unknown_rule ? `${r.rule}: no such rule` : label(r.rule)}</Badge>}
                  {r.sections.length > 0 && (
                    <Badge size="sm" tone="neutral">
                      {r.sections.filter((s) => s.open).length}/{r.sections.length} private {r.sections.length === 1 ? "section" : "sections"} shown
                    </Badge>
                  )}
                  <span className={cx("text-[13px] font-semibold", r.open ? "text-success" : "text-text-secondary")}>{r.open ? "Opens" : "Locked"}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </SettingsCard>
  );
}

/**
 * Settings › Private pages: the rules (who), each group's rule, the access-requests inbox, preview
 * as, warnings, the audit log and "Sign out every reader". Free on every guide.
 */
export default function PrivateSection() {
  const { site, isAdmin, canEdit } = useSite();
  const toast = useToast();
  const [state, setState] = useState<PrivateState | null>(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<{ kind: "people" | "password"; rule: AccessRule | null } | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [busy, setBusy] = useState("");
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await getPrivate(site.id));
    } catch (e) {
      setError(docsErrorMessage(e, "Couldn't load private pages."));
    }
  }, [site.id]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!isAdmin) return;
    getAudit(site.id).then((r) => setAudit(r.entries)).catch(() => setAudit([]));
  }, [site.id, isAdmin, state?.version]);
  // While the edge catches up with a change, check again.
  useEffect(() => {
    if (!state || state.enforced) return;
    const t = setTimeout(() => void load(), 4000);
    return () => clearTimeout(t);
  }, [state, load]);

  const saved = (s: PrivateState, msg: string) => {
    setState(s);
    setDialog(null);
    toast.success(msg);
  };

  async function remove(rule: AccessRule) {
    setBusy(`del-${rule.id}`);
    try {
      setState((await deleteRule(site.id, rule.id)).private);
      toast.success(`${rule.name} deleted.`);
    } catch (e) {
      setError(docsErrorMessage(e, "Couldn't delete the rule."));
    } finally {
      setBusy("");
    }
  }

  async function decide(id: string, d: "approve" | "decline") {
    setBusy(`req-${id}`);
    try {
      const r = await decideRequest(site.id, id, d);
      setState(r.private);
      toast.success(r.note || (d === "approve" ? "Approved. They can sign in with their email now, and we emailed them." : "Declined. We let them know."));
    } catch (e) {
      setError(docsErrorMessage(e, "That didn't save."));
    } finally {
      setBusy("");
    }
  }

  async function setGroup(group: string, value: string) {
    setBusy(`grp-${group}`);
    try {
      setState((await putGroups(site.id, { [group]: value || null })).private);
      toast.success("Saved. Publish to apply it to the group's pages.");
    } catch (e) {
      setError(docsErrorMessage(e, "That didn't save."));
    } finally {
      setBusy("");
    }
  }

  async function signOut() {
    setBusy("signout");
    try {
      setState((await signOutReaders(site.id)).private);
      setConfirmSignOut(false);
      toast.success("Every reader of private pages is signed out. They sign in again to read.");
    } catch (e) {
      setError(docsErrorMessage(e, "That didn't work."));
    } finally {
      setBusy("");
    }
  }

  const section = SECTIONS.find((s) => s.id === "private");
  if (!state) {
    return (
      <>
        <SectionHeader title="Private pages" description={section?.blurb} />
        {error ? <Alert tone="danger">{error}</Alert> : <p className="text-[13px] text-text-muted">Loading…</p>}
      </>
    );
  }
  const pending = (state.requests ?? []).filter((q) => q.status === "pending");
  const decided = (state.requests ?? []).filter((q) => q.status !== "pending").slice(0, 10);
  const groups = site.settings.nav.map((g) => g.group);
  const options = [{ value: "", label: "Inherit (the guide's setting)" }, { value: "public", label: "Public" }, ...state.rules.map((r) => ({ value: r.id, label: ruleLabel(r) }))];

  return (
    <>
      <SectionHeader title="Private pages" description={<>{section?.blurb} <ReadMore topic="privatePages" /></>} />
      {error && <Alert tone="danger" onDismiss={() => setError("")}>{error}</Alert>}

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4" role="list" aria-label="Summary">
        {[
          ["Private pages", state.protected_pages],
          ["Private sections", state.private_sections],
          ["Rules", state.rules.length],
          ["Pending requests", state.requests_pending],
        ].map(([k, v]) => (
          <div key={k as string} role="listitem" className="rounded-lg border border-border bg-surface px-3.5 py-3">
            <div className="text-[22px] font-semibold leading-7 text-text">{v as number}</div>
            <div className="text-[13px] text-text-muted">{k as string}</div>
          </div>
        ))}
      </div>
      {!state.enforced && (
        <Alert tone="info" title="Updating the guide">Your last change reaches readers in a few seconds. Until then the previous list applies.</Alert>
      )}
      {state.unknown_rules.length > 0 && (
        <Alert tone="warning" title="A page names a rule that doesn't exist">
          {state.unknown_rules.join(", ")}: those pages and sections stay locked for everyone. Pick another rule in their Page tab.
        </Alert>
      )}

      <SettingsCard
        id="rules"
        title="Who can open private pages"
        description="Pick one of these for a page (its Page tab), a group, or a section. Team members open everything."
        aside={isAdmin ? (
          <span className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" iconLeft="mail" onClick={() => setDialog({ kind: "people", rule: null })}>People or domains</Button>
            <Button size="sm" variant="secondary" iconLeft="key" onClick={() => setDialog({ kind: "password", rule: null })}>Password</Button>
          </span>
        ) : undefined}
      >
        <ul className="flex flex-col">
          {state.rules.map((r) => (
            <RuleRow key={r.id} rule={r} admin={isAdmin} onEdit={() => setDialog({ kind: r.kind === "password" ? "password" : "people", rule: r })} onDelete={() => void remove(r)} />
          ))}
        </ul>
        {!isAdmin && <p className="text-[13px] text-text-muted">Only the guide&apos;s admins can change who a rule lets in.</p>}
      </SettingsCard>

      {isAdmin && (
        <SettingsCard id="requests" title="Access requests" description="Readers ask from a locked page. Approving adds their email to the rule; we email them either way.">
          {pending.length === 0 ? (
            <EmptyState icon="inbox" title="No requests waiting" description="When someone asks for access from a lock page, it shows up here and in your email." />
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {pending.map((q) => {
                const r = state.rules.find((x) => x.id === q.rule);
                return (
                  <li key={q.id} className="flex flex-wrap items-start gap-3 py-3 first:pt-0">
                    <span className="flex min-w-0 flex-[1_1_240px] flex-col gap-0.5">
                      <strong className="ph-no-capture break-all text-body-strong text-text">{q.email}</strong>
                      <span className="text-[13px] text-text-muted">
                        Wants {r ? ruleLabel(r) : "access"} · from <span className="font-mono">{q.path}</span> · {fmtDate(q.created_at)}
                      </span>
                      {q.note && <span className="ph-no-capture text-[13px] text-text-secondary">&ldquo;{q.note}&rdquo;</span>}
                    </span>
                    <span className="flex shrink-0 gap-1.5">
                      <Button size="sm" variant="primary" loading={busy === `req-${q.id}`} onClick={() => void decide(q.id, "approve")}>Approve</Button>
                      <Button size="sm" variant="ghost" disabled={busy === `req-${q.id}`} onClick={() => void decide(q.id, "decline")}>Decline</Button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {decided.length > 0 && (
            <details className="text-[13px] text-text-muted">
              <summary className="cursor-pointer font-semibold">Answered ({decided.length})</summary>
              <ul className="mt-2 flex flex-col gap-1">
                {decided.map((q) => <li key={q.id} className="ph-no-capture">{q.email}: {q.status} {fmtDate(q.decided_at)}</li>)}
              </ul>
            </details>
          )}
        </SettingsCard>
      )}

      <PreviewCard state={state} />

      {state.warnings.length > 0 && (
        <SettingsCard id="warnings" title="Links to private pages" description="These public pages link to a private one: readers who can't open it meet a lock.">
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {state.warnings.map((w) => (
              <li key={`${w.from}>${w.to}`} className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-text">{w.from}</span>
                <Icon name="arrowRight" size={13} className="text-text-muted" />
                <span className="font-mono text-text">{w.to}</span>
                <Badge size="sm" icon="lock">{ruleLabel(state.rules.find((r) => r.id === w.rule) ?? { kind: "people", name: w.rule })}</Badge>
              </li>
            ))}
          </ul>
        </SettingsCard>
      )}

      {groups.length > 0 && (
        <SettingsCard id="groups" title="Groups" description="A rule for every page in a sidebar group (a page's own choice wins). Applies at the next publish.">
          <ul className="flex flex-col divide-y divide-border">
            {groups.map((g) => (
              <li key={g} className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0">
                <span className="min-w-0 flex-[1_1_180px] truncate text-body-strong text-text">{g}</span>
                <Select
                  aria-label={`Who can open the pages in ${g}`}
                  className="w-full sm:w-64"
                  value={state.groups[g] ?? ""}
                  disabled={!canEdit || busy === `grp-${g}`}
                  onChange={(e) => void setGroup(g, e.target.value)}
                  options={options}
                />
              </li>
            ))}
          </ul>
        </SettingsCard>
      )}

      {isAdmin && (
        <SettingsCard id="audit" title="Access history" description="Every change to who can read private pages.">
          {!audit?.length ? (
            <p className="text-[13px] text-text-muted">Nothing yet.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {audit.slice(0, 30).map((e, i) => {
                const added = Array.isArray(e.detail.added) ? (e.detail.added as string[]) : [];
                const removed = Array.isArray(e.detail.removed) ? (e.detail.removed as string[]) : [];
                const who = typeof e.detail.email === "string" ? e.detail.email : "";
                return (
                  <li key={i} className="flex flex-wrap gap-1.5 text-text-secondary">
                    <span className="text-text-muted">{fmtDate(e.at)}</span>
                    <strong className="text-text">{e.actor_name ?? (e.action === "members_signed_out" ? "Markdrop" : "Someone")}</strong>
                    <span>{ACTIONS[e.action] ?? e.action}</span>
                    {e.rule && <Badge size="sm">{ruleLabel(state.rules.find((r) => r.id === e.rule) ?? { kind: "people", name: e.rule })}</Badge>}
                    {who && <span className="ph-no-capture">{who}</span>}
                    {added.length > 0 && <span className="ph-no-capture">added {added.join(", ")}</span>}
                    {removed.length > 0 && <span className="ph-no-capture">removed {removed.join(", ")}</span>}
                    {e.detail.password === "changed" && <span>new password</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </SettingsCard>
      )}

      {isAdmin && (
        <SettingsCard id="sign-out" title="Sign out every reader" description="Everyone signed in to private pages (emails, team, passwords) signs in again. Use it when a link or a password was shared too widely.">
          <div>
            <Button variant="secondary" iconLeft="logOut" onClick={() => setConfirmSignOut(true)}>Sign out every reader</Button>
          </div>
        </SettingsCard>
      )}

      <RuleDialog open={!!dialog} kind={dialog?.kind ?? "people"} rule={dialog?.rule ?? null} onClose={() => setDialog(null)} onSaved={saved} />
      <Dialog
        open={confirmSignOut}
        onClose={() => setConfirmSignOut(false)}
        title="Sign out every reader?"
        description="Readers of private pages sign in again. Public pages aren't affected."
        tone="danger"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmSignOut(false)}>Cancel</Button>
            <Button variant="danger" loading={busy === "signout"} onClick={() => void signOut()}>Sign everyone out</Button>
          </>
        }
      />
    </>
  );
}
