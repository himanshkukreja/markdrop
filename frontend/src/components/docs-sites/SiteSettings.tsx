"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert, Badge, Button, ConfirmDialog, CopyButton, Dialog, Field, Icon, IconButton, Input, Meter, RadioGroup, Switch, Tag, Textarea, useToast,
} from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { getWorkspace } from "@/lib/workspaces";
import {
  DOCS_HOST_SUFFIX, deleteSite, docsErrorMessage, siteHost, slugAvailable, slugProblem, unpublishSite, updateSite,
  type AccessLevel, type Redirect, type SettingsPatch,
} from "@/lib/docsSites";
import { num, plural, timeAgo } from "./format";
import SiteBar from "./SiteBar";
import { useSite } from "./SiteContext";

const MAX_SUGGESTIONS = 5;

function Card({ id, title, aside, children, tone }: { id: string; title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; tone?: "danger" }) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-h`}
      className={`flex min-w-0 flex-col gap-3 rounded-xl border p-5 ${tone === "danger" ? "border-danger bg-danger-soft" : "border-border bg-surface"}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        <h2 id={`${id}-h`} className="min-w-0 flex-1 text-[16px] font-semibold text-text">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** "/old": "/new" lines → [{from, to}] with problems; accepts JSON (map or list) or "from,to"/"from -> to" lines. */
export function parseRedirects(text: string): { redirects: Redirect[]; problem: string } {
  const t = text.trim();
  if (!t) return { redirects: [], problem: "" };
  let pairs: Array<[string, string]> = [];
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const j = JSON.parse(t);
      pairs = Array.isArray(j) ? j.map((r: Redirect) => [String(r.from), String(r.to)]) : Object.entries(j).map(([a, b]) => [a, String(b)]);
    } catch {
      return { redirects: [], problem: "That file isn't valid JSON." };
    }
  } else {
    pairs = t.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#")).map((l) => {
      const [a, b] = l.split(/\s*(?:,|->|→|\s)\s*/).filter(Boolean);
      return [a ?? "", b ?? ""];
    });
  }
  for (const [from, to] of pairs) {
    if (!from.startsWith("/") || from.startsWith("//")) return { redirects: [], problem: `"${from}" must be a path starting with /.` };
    if (!(to.startsWith("/") && !to.startsWith("//")) && !/^https:\/\//i.test(to)) return { redirects: [], problem: `"${to}" must be a path or an https:// address.` };
  }
  return { redirects: pairs.map(([from, to]) => ({ from, to })), problem: "" };
}

/**
 * /w/<ws>/docs/<site>/settings (Settings board): the free address (and changing it), your own
 * domain (coming soon), Ask AI (on/off, usage, name, suggested questions), who can read it,
 * search indexing, reviews, GitHub sync status, redirects, and unpublish/delete. Admin-only to
 * change; everyone else sees the values.
 */
export default function SiteSettings() {
  const { site, setSite, isAdmin, listHref } = useSite();
  const toast = useToast();
  const router = useRouter();
  const uid = useId();
  const locked = !isAdmin;
  const s = site.settings;
  const [wsName, setWsName] = useState<string | null>(null);
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");

  // Address
  const [editSlug, setEditSlug] = useState(false);
  const [slug, setSlug] = useState(site.slug);
  const [slugMsg, setSlugMsg] = useState("");
  // Ask AI
  const [aiName, setAiName] = useState(s.ai.name ?? "");
  const [suggestion, setSuggestion] = useState("");
  // Access
  const [password, setPassword] = useState("");
  const [pendingLevel, setPendingLevel] = useState<AccessLevel | null>(null);
  // Redirects
  const [redirectsOpen, setRedirectsOpen] = useState(false);
  const [redirectsText, setRedirectsText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  // Danger
  const [confirm, setConfirm] = useState<"unpublish" | "delete" | null>(null);

  useEffect(() => {
    if (site.workspace_id) getWorkspace(site.workspace_id).then((w) => setWsName(w.name)).catch(() => {});
  }, [site.workspace_id]);
  useEffect(() => { setAiName(s.ai.name ?? ""); }, [s.ai.name]);

  async function patch(key: string, body: { slug?: string; settings?: SettingsPatch }, done: string) {
    if (locked) return false;
    setSaving(key);
    setError("");
    try {
      setSite(await updateSite(site.id, body));
      toast.success(done);
      return true;
    } catch (e) {
      setError(docsErrorMessage(e, "That didn't save. Try again."));
      return false;
    } finally {
      setSaving("");
    }
  }

  async function saveSlug() {
    const problem = slugProblem(slug);
    if (problem) { setSlugMsg(problem); return; }
    if (slug === site.slug) { setEditSlug(false); return; }
    try {
      const r = await slugAvailable(slug);
      if (!r.available) { setSlugMsg(r.reason || "That address is taken."); return; }
    } catch { /* the PATCH checks too */ }
    if (await patch("slug", { slug }, `The address is now ${slug}${DOCS_HOST_SUFFIX}. The old one stops working.`)) setEditSlug(false);
  }

  const suggestions = s.ai.suggestions ?? [];
  const addSuggestion = () => {
    const q = suggestion.trim();
    if (!q || suggestions.length >= MAX_SUGGESTIONS || suggestions.includes(q)) return;
    void patch("ai", { settings: { ai: { suggestions: [...suggestions, q] } } }, "Suggested question added.").then((ok) => ok && setSuggestion(""));
  };

  const usage = site.usage;
  const aiUsed = usage?.ai_used ?? 0;
  const aiLimit = usage?.ai_limit ?? 1000;
  const redirects = s.redirects ?? [];
  const parsed = parseRedirects(redirectsText);
  const host = siteHost(site);
  const repo = site.source.kind === "github" ? site.source.repo : null;

  const accessOptions = [
    { value: "public", label: "Anyone", description: "A public docs site." },
    { value: "password", label: "Anyone with the password", description: "For a beta or a partner preview." },
    { value: "members", label: `${wsName ?? "Workspace"} members only`, description: "Readers sign in with Markdrop. Good for internal handbooks." },
  ].map((o) => ({ ...o, disabled: locked }));

  function chooseAccess(v: string) {
    const level = v as AccessLevel;
    if (level === "password" && !s.access.has_password) { setPendingLevel("password"); return; }
    setPendingLevel(null);
    void patch("access", { settings: { access: { level } } }, level === "public" ? "Anyone can read the site now." : level === "members" ? "Only members can read the site now." : "Readers need the password now.");
  }

  async function savePassword() {
    if (password.length < 6) { setError("Use at least 6 characters for the password."); return; }
    if (await patch("access", { settings: { access: { level: "password", password } } }, "Password set. Readers need it from now on.")) {
      setPassword("");
      setPendingLevel(null);
    }
  }

  const level = pendingLevel ?? s.access.level;

  return (
    <>
      <SiteBar section="settings" />
      <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-[880px] flex-col gap-5 px-4 pb-16 pt-6 outline-none sm:px-6 sm:pt-8">
        <h1 className="text-[24px] font-bold leading-8 text-text">Settings</h1>
        {locked && <Alert tone="neutral" title="Only admins change these settings">You can see how this site is set up. Ask an admin of {wsName ?? "this workspace"} to change it.</Alert>}
        {error && <Alert tone="danger" onDismiss={() => setError("")}>{error}</Alert>}

        <Card id="address" title="Address" aside={isAdmin && !editSlug ? <Button variant="ghost" size="sm" onClick={() => { setSlug(site.slug); setSlugMsg(""); setEditSlug(true); }}>Change</Button> : null}>
          {editSlug ? (
            <div className="flex flex-col gap-3">
              <Field label="Address" htmlFor={`${uid}-slug`} error={slugMsg || undefined} hint="Links to the old address stop working, so change it before you share it.">
                <Input mono value={slug} textSuffix={DOCS_HOST_SUFFIX} maxLength={40} autoCapitalize="none" spellCheck={false} onChange={(e) => { setSlugMsg(""); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")); }} />
              </Field>
              <div className="flex gap-2">
                <Button variant="primary" size="sm" loading={saving === "slug"} onClick={() => void saveSlug()}>Save address</Button>
                <Button variant="ghost" size="sm" onClick={() => setEditSlug(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2.5">
                <code className="min-w-0 flex-[1_1_260px] rounded-lg bg-surface-inset px-3 py-2 font-mono text-[14px] text-text [overflow-wrap:anywhere]">{host}</code>
                <CopyButton text={`https://${host}`} label="Copy link" size="sm" />
              </div>
              <p className="text-[13px] text-text-muted">Always works, even after you add your own domain.</p>
            </>
          )}
        </Card>

        <Card id="domain" title="Your own domain" aside={<><Badge tone="info" size="sm">Coming soon</Badge><Button variant="secondary" size="sm" iconLeft="plus" disabled>Add a domain</Button></>}>
          {(site.domains ?? []).map((d) => (
            <div key={d.host} className="flex items-center gap-2.5 rounded-lg border border-border px-3.5 py-3">
              <Icon name="globe" size={16} />
              <code className="min-w-0 flex-1 truncate font-mono text-text">{d.host}</code>
              <Badge tone={d.status === "live" || d.status === "verified" ? "success" : d.status === "failed" ? "danger" : "warning"} size="sm" dot>
                {d.status === "live" || d.status === "verified" ? "Live" : d.status === "failed" ? "Failed" : "Pending"}
              </Badge>
              {(d.status === "live" || d.status === "verified") && <Badge tone="info" size="sm" icon="lock">HTTPS</Badge>}
            </div>
          ))}
          <p className="text-[13px] text-text-muted">
            Soon: one CNAME record pointing to <code className="font-mono">sites.markdrop.in</code>, with the certificate handled for you. Want it at a path like <code className="font-mono">acme.com/docs</code>? We&apos;ll show you the one rewrite rule to add.
          </p>
        </Card>

        <Card id="ai" title="Ask AI" aside={<Switch label={s.ai.enabled ? "On" : "Off"} checked={s.ai.enabled} disabled={locked || saving === "ai"} onChange={(e) => void patch("ai", { settings: { ai: { enabled: e.target.checked } } }, e.target.checked ? "Ask AI is on." : "Ask AI is off.")} />}>
          <p className="text-body text-text-secondary">Readers ask questions and get answers from these docs, with a link to the exact section each part came from.</p>
          <Meter size="sm" value={aiUsed} max={aiLimit} threshold={0.9} label={`This month: ${num(aiUsed)} of ${num(aiLimit)} answers`} valueText={`${aiUsed} of ${aiLimit} answers`} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name readers see" htmlFor={`${uid}-ainame`}>
              <Input
                value={aiName}
                maxLength={40}
                disabled={locked}
                placeholder="Ask AI"
                onChange={(e) => setAiName(e.target.value)}
                onBlur={() => { if (aiName.trim() !== (s.ai.name ?? "")) void patch("ai", { settings: { ai: { name: aiName.trim() || null } } }, "Name saved."); }}
              />
            </Field>
            <Field label="Suggested questions" htmlFor={`${uid}-sugg`} hint={suggestions.length >= MAX_SUGGESTIONS ? "Up to 5. Remove one to add another." : "Shown before someone types. Up to 5."}>
              <Input
                value={suggestion}
                maxLength={120}
                disabled={locked || suggestions.length >= MAX_SUGGESTIONS}
                placeholder="How do I connect Postgres?"
                onChange={(e) => setSuggestion(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSuggestion(); } }}
                suffix={suggestion.trim() ? <IconButton icon="plus" label="Add question" size="sm" onClick={addSuggestion} /> : undefined}
              />
            </Field>
          </div>
          {suggestions.length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label="Suggested questions">
              {suggestions.map((q) => (
                <li key={q}>
                  <Tag removeLabel={`Remove "${q}"`} onRemove={locked ? undefined : () => void patch("ai", { settings: { ai: { suggestions: suggestions.filter((x) => x !== q) } } }, "Suggested question removed.")}>{q}</Tag>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[13px] text-text-muted">At the limit, readers get links to ask Claude or ChatGPT with the page attached instead.</p>
        </Card>

        <Card id="access" title="Who can read it">
          <RadioGroup name={`${uid}-access`} value={level} onChange={chooseAccess} options={accessOptions} aria-label="Who can read it" />
          {level === "password" && isAdmin && (
            <div className="flex flex-wrap items-end gap-2 pl-7">
              <Field label={s.access.has_password ? "Change the password" : "Password"} htmlFor={`${uid}-pw`} className="min-w-0 flex-[1_1_240px]" hint={s.access.has_password ? "Readers who already opened the site stay signed in." : "Share it with the people who should read the site."}>
                <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <Button variant={s.access.has_password ? "secondary" : "primary"} size="md" loading={saving === "access"} disabled={!password} onClick={() => void savePassword()}>
                {s.access.has_password ? "Change" : "Set password"}
              </Button>
              {pendingLevel && <Button variant="ghost" onClick={() => setPendingLevel(null)}>Cancel</Button>}
            </div>
          )}
          {level === "members" && <p className="pl-7 text-[13px] text-text-muted">Who&apos;s a member is managed in the workspace. <ReadMore topic="members" /></p>}
          <Switch
            label="Let search engines index the site"
            checked={s.seo.index && s.access.level === "public"}
            disabled={locked || s.access.level !== "public" || saving === "seo"}
            onChange={(e) => void patch("seo", { settings: { seo: { index: e.target.checked } } }, e.target.checked ? "Search engines can index the site." : "Search engines are asked not to index the site.")}
          />
          {s.access.level !== "public" && <p className="text-[13px] text-text-muted">Private sites are never indexed.</p>}
        </Card>

        <Card id="review" title="Reviews">
          <Switch
            label="Editors submit changes for an admin to approve before they're published"
            checked={s.review.required}
            disabled={locked || saving === "review"}
            onChange={(e) => void patch("review", { settings: { review: { required: e.target.checked } } }, e.target.checked ? "Editors' changes now need an approval." : "Editors publish directly now.")}
          />
          <p className="text-[13px] text-text-muted">Admins can always publish. <ReadMore topic="members">Roles in a workspace</ReadMore></p>
        </Card>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <Card id="github" title="GitHub sync" aside={repo ? <Badge tone="success" size="sm" dot>Connected</Badge> : <Badge tone="info" size="sm">Coming soon</Badge>}>
            {repo ? (
              <>
                <div className="flex items-center gap-2"><Icon name="github" size={16} /><code className="font-mono text-text">{repo.owner}/{repo.name} · {repo.branch} · {repo.path || "/"}</code></div>
                <p className="text-[13px] text-text-muted">Pushes publish automatically. Browser edits are committed as you.{site.last_published_at ? ` Last sync ${timeAgo(site.last_published_at)}.` : ""}</p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 text-text-secondary"><Icon name="github" size={16} /> Not connected</div>
                <p className="text-[13px] text-text-muted">Keep the Markdown in a repo: pushes publish, pull requests get a preview link, and browser edits come back as commits.</p>
              </>
            )}
          </Card>

          <Card id="redirects" title="Redirects">
            <p className="text-body text-text-secondary">
              {redirects.length
                ? `${plural(redirects.length, "old address", "old addresses")} send${redirects.length === 1 ? "s" : ""} readers to ${redirects.length === 1 ? "its new page" : "their new pages"}${site.source.kind === "gitbook" ? ", including the ones kept from GitBook" : ""}.`
                : "Moved a page? Send its old address to the new one so links keep working."}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" disabled={locked} onClick={() => { setRedirectsText(redirects.map((r) => `${r.from} -> ${r.to}`).join("\n")); setRedirectsOpen(true); }}>Edit redirects</Button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,.csv,.txt,application/json,text/csv,text/plain"
                className="md-visually-hidden"
                tabIndex={-1}
                aria-hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setRedirectsText(await f.text());
                  setRedirectsOpen(true);
                  e.target.value = "";
                }}
              />
              <Button variant="ghost" size="sm" iconLeft="upload" disabled={locked} onClick={() => fileRef.current?.click()}>Upload a file</Button>
            </div>
          </Card>
        </div>

        {isAdmin && (
          <Card id="danger" title="Take the site down" tone="danger" aside={
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={site.status !== "live"} onClick={() => setConfirm("unpublish")}>Unpublish</Button>
              <Button variant="danger" size="sm" onClick={() => setConfirm("delete")}>Delete site</Button>
            </div>
          }>
            <p className="text-body text-text-secondary">Unpublish keeps your pages and history; delete removes everything.</p>
          </Card>
        )}
      </main>

      <Dialog
        open={redirectsOpen}
        onClose={() => setRedirectsOpen(false)}
        title="Redirects"
        description="One per line: the old path, then where it goes now. A JSON file like { &quot;/old&quot;: &quot;/new&quot; } works too."
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRedirectsOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={saving === "redirects"}
              disabled={!!parsed.problem}
              onClick={async () => {
                if (await patch("redirects", { settings: { redirects: parsed.redirects } }, `${plural(parsed.redirects.length, "redirect")} saved. They work after the next publish.`)) setRedirectsOpen(false);
              }}
            >
              Save {plural(parsed.redirects.length, "redirect")}
            </Button>
          </>
        }
      >
        <Field label="Redirects" htmlFor={`${uid}-redir`} error={parsed.problem || undefined} hint="Example: /getting-started/install -> /getting-started/quickstart">
          <Textarea
            mono
            className="min-h-[220px] w-full"
            value={redirectsText}
            spellCheck={false}
            onChange={(e) => setRedirectsText(e.target.value)}
          />
        </Field>
      </Dialog>

      <ConfirmDialog
        open={confirm === "unpublish"}
        onClose={() => setConfirm(null)}
        title={`Unpublish ${site.name}?`}
        body={<>{host} stops showing the docs. Your pages, drafts and publish history stay, and publishing again puts it back.</>}
        confirmLabel="Unpublish"
        onConfirm={async () => {
          setSite(await unpublishSite(site.id));
          setConfirm(null);
          toast.success("The site is unpublished.");
        }}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onClose={() => setConfirm(null)}
        title={`Delete ${site.name}?`}
        body={<>Every page, version and publish goes, and {host} stops working. This can&apos;t be undone.</>}
        typeToConfirm={site.name}
        confirmLabel="Delete site"
        onConfirm={async () => {
          await deleteSite(site.id);
          toast.success(`${site.name} was deleted.`);
          router.replace(listHref);
        }}
      />
    </>
  );
}
