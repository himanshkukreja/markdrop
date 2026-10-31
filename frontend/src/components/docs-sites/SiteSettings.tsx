"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert, Badge, Button, ConfirmDialog, CopyButton, Field, Icon, IconButton, Input, Meter, RadioGroup, Switch, Tag, useToast,
} from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { getWorkspace } from "@/lib/workspaces";
import {
  DOCS_HOST_SUFFIX, deleteSite, docsErrorMessage, roleLabel, roleSourceLabel, siteHost, slugAvailable, slugProblem, unpublishSite, updateSite,
  type AccessLevel, type SettingsPatch,
} from "@/lib/docsSites";
import { num, plural, timeAgo } from "./format";
import { aRole, RoleBadge } from "./people/roles";
import SitePeople from "./people/SitePeople";
import RedirectsEditor from "./RedirectsEditor";
import SiteBar, { STUDIO_CHROME_H } from "./SiteBar";
import { useStudio } from "./studio/StudioContext";
import { useSite } from "./SiteContext";

const MAX_SUGGESTIONS = 5;

/** Cards are anchors (/settings#people): land them below the sticky studio header and site bar. */
const CARD_SCROLL_MARGIN = STUDIO_CHROME_H + 16;

function Card({ id, title, aside, children, tone }: { id: string; title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; tone?: "danger" }) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-h`}
      style={{ scrollMarginTop: CARD_SCROLL_MARGIN }}
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

/**
 * /docs-studio/<site>/settings (Settings board): the free address (and changing it), your own
 * domain (coming soon), Ask AI (on/off, usage, name, suggested questions), who can read it,
 * search indexing, reviews, GitHub sync status, redirects, and unpublish/delete. Admin-only to
 * change; everyone else sees the values.
 */
export default function SiteSettings() {
  const { site, setSite, isAdmin, canManagePeople, role, listHref, base } = useSite();
  const { reloadAll } = useStudio();
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
  // Danger
  const [confirm, setConfirm] = useState<"unpublish" | "delete" | null>(null);

  useEffect(() => {
    if (site.workspace_id) getWorkspace(site.workspace_id).then((w) => setWsName(w.name)).catch(() => {});
  }, [site.workspace_id]);
  useEffect(() => { setAiName(s.ai.name ?? ""); }, [s.ai.name]);

  // Arriving at /settings#<card> (from Publishes, Members, a shared link): the cards render after the
  // site loads, so the browser's own jump to the anchor found nothing. Go there once they're here, and
  // stay with the card while People (above Redirects) fills in, until you scroll yourself.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    const main = document.getElementById("main");
    if (!id || !main) return;
    let on = true;
    const go = () => { if (on) document.getElementById(id)?.scrollIntoView({ block: "start" }); };
    const stop = () => { on = false; };
    const first = window.setTimeout(go, 60);
    const ro = new ResizeObserver(go);
    ro.observe(main);
    const end = window.setTimeout(stop, 2000);
    const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const ev of events) window.addEventListener(ev, stop, { passive: true });
    return () => {
      stop();
      ro.disconnect();
      window.clearTimeout(first);
      window.clearTimeout(end);
      for (const ev of events) window.removeEventListener(ev, stop);
    };
  }, []);

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
      const r = await slugAvailable(slug, site.id);
      if (!r.available) { setSlugMsg(r.message || "That address is taken."); return; }
    } catch { /* the PATCH checks too */ }
    if (await patch("slug", { slug }, `The address is now ${slug}${DOCS_HOST_SUFFIX}. The old one stops working.`)) setEditSlug(false);
  }

  const suggestions = s.ai.suggestions ?? [];
  const addSuggestion = () => {
    const q = suggestion.trim();
    if (!q || suggestions.length >= MAX_SUGGESTIONS || suggestions.includes(q)) return;
    void patch("ai", { settings: { ai: { suggestions: [...suggestions, q] } } }, "Suggested question added.").then((ok) => ok && setSuggestion(""));
  };

  const aiUsed = site.counts?.ai_answers_this_month ?? site.ai_used ?? 0;
  const aiLimit = site.limits?.ai_answers_per_month ?? 1000;
  const redirects = s.redirects ?? [];
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
    if (password.length < 8) { setError("Use at least 8 characters for the password."); return; }
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
        {locked && <Alert tone="neutral" title="Only Docs Studio admins change these settings">You can see how this site is set up. Ask a Docs Studio admin of {wsName ?? "this workspace"} to change it.</Alert>}
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
            Soon: one CNAME record pointing to <code className="font-mono">sites.markdrop.in</code>, with the certificate handled for you. Want it at a path like <code className="font-mono">acme.com/docs</code>? We&apos;ll show you the one rewrite rule to add.{" "}
            <ReadMore topic="studioDomain" />
          </p>
        </Card>

        <Card id="ai" title="Ask AI" aside={<Switch label={s.ai.enabled ? "On" : "Off"} checked={s.ai.enabled} disabled={locked || saving === "ai"} onChange={(e) => void patch("ai", { settings: { ai: { enabled: e.target.checked } } }, e.target.checked ? "Ask AI is on." : "Ask AI is off.")} />}>
          <p className="text-body text-text-secondary">Readers ask questions and get answers from these docs, with a link to the exact section each part came from. <ReadMore topic="studioAskAi" /></p>
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
          {site.access_enforced === false && s.access.level !== "public" && (
            <p className="pl-7 text-[13px] text-text-muted" role="status">Not enforced yet — retrying. Readers may still see the previous setting for a few minutes.</p>
          )}
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
            label="Editors and reviewers submit changes for approval before they're published"
            checked={s.review.required}
            disabled={locked || saving === "review"}
            onChange={(e) => void patch("review", { settings: { review: { required: e.target.checked } } }, e.target.checked ? "Editors' changes now need an approval." : "Editors publish directly now.")}
          />
          <p className="text-[13px] text-text-muted">Admins can always publish. Reviewers approve other people&apos;s changes, never their own. <ReadMore topic="studioReviews" /></p>
        </Card>

        {canManagePeople ? (
          <Card id="people" title="People" aside={<RoleBadge role={role} title={`Your role: ${roleSourceLabel(site.your_role_source) || roleLabel(role)}`} />}>
            <SitePeople />
          </Card>
        ) : (
          <Card id="people" title="Your role" aside={<RoleBadge role={role} size="md" />}>
            <p className="text-body text-text-secondary">
              {site.your_role_source === "site"
                ? `You're ${aRole(role)} on this site only.`
                : `You're ${aRole(role)} in ${wsName ?? "this workspace"}'s Docs Studio.`}{" "}
              A Docs Studio admin gives people their roles.
            </p>
          </Card>
        )}

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
                <p className="text-[13px] text-text-muted">Keep the Markdown in a repo: pushes publish, pull requests get a preview link, and browser edits come back as commits. <ReadMore topic="studioGithub" /></p>
              </>
            )}
          </Card>

          {site.source.kind === "gitbook" ? (
            <Card id="import" title="Imported from GitBook" aside={site.last_import_job_id ? <Badge size="sm" icon="download">Import</Badge> : null}>
              <p className="text-body text-text-secondary">
                {site.source.url ? <>From <code className="font-mono [overflow-wrap:anywhere]">{site.source.url}</code>. </> : null}
                The import&apos;s report lists what needs a look: image descriptions, broken links, hidden pages.
              </p>
              {site.last_import_job_id && <Button variant="secondary" size="sm" iconLeft="listTree" href={`${base}/import`} className="self-start">Open the import report</Button>}
            </Card>
          ) : (
            <Card id="source" title="Started from" aside={<Badge size="sm">{site.source.kind === "template" ? "Template" : "Blank"}</Badge>}>
              <p className="text-body text-text-secondary">{site.source.kind === "template" ? "A template's pages, now yours to edit." : "A blank site."} Every page&apos;s history is in the editor.</p>
            </Card>
          )}
        </div>

        <Card id="redirects" title="Redirects" aside={redirects.length ? <Badge size="sm">{num(redirects.length)}</Badge> : null}>
          <p className="text-body text-text-secondary">
            Moved or renamed a page? Send its old address to the new one, so links people saved keep working.
            {site.source.kind === "gitbook" ? " The old GitBook addresses the import found keep working on their own." : ""} Changes go live at the next publish.{" "}
            <ReadMore topic="studioRedirects" />
          </p>
          <RedirectsEditor
            siteId={site.id}
            value={redirects}
            locked={locked}
            saving={saving === "redirects"}
            onSave={(rows) => patch("redirects", { settings: { redirects: rows } }, rows.length ? `${plural(rows.length, "redirect")} saved. They go live at the next publish.` : "Redirects removed.")}
          />
        </Card>

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
          void reloadAll();
          router.replace(listHref);
        }}
      />
    </>
  );
}
