"use client";

import { ReadMore } from "@/components/ReadMore";
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Anchor, Badge, Button, Field, Icon, Input, Select, Spinner, cx } from "@/components/ui";
import { useLocationSearch } from "@/components/shell/useLocation";
import {
  DOCS_HOST_SUFFIX, createSite, docsErrorMessage, slugAvailable, slugFrom, slugProblem,
  type SourceKind, type TemplateId,
} from "@/lib/docsSites";
import { StudioLoader, useStudioSession } from "./SiteContext";
import { PERSONAL, siteBase, studioHome, studioNew } from "./routes";
import { useStudio } from "./studio/StudioContext";

const SOURCES: Array<{ id: SourceKind; icon: string; title: string; body: string }> = [
  { id: "blank", icon: "doc", title: "Blank guide", body: "Start with a home page and write in the editor." },
  { id: "template", icon: "layers", title: "From a template", body: "A product guide, API reference or help center, ready to fill in." },
  { id: "gitbook", icon: "download", title: "Import from GitBook", body: "Paste your GitBook address. Pages, images, navigation and old links come across." },
  { id: "github", icon: "github", title: "Connect a GitHub repo", body: "Your Markdown stays in Git. Push to publish; edit in the browser too." },
];

const TEMPLATES: Array<{ id: TemplateId; title: string; body: string }> = [
  { id: "product", title: "Product guide", body: "Get started, how-tos, FAQ and release notes." },
  { id: "api", title: "API reference", body: "Endpoint pages generated from your OpenAPI file, with code samples and Try it. Starts with a sample API to replace." },
  { id: "helpcenter", title: "Help center", body: "Search first, categories and articles." },
];

type SlugState = { state: "idle" | "checking" | "ok" | "taken" | "invalid"; message?: string; suggestion?: string | null };

/** Another address to offer when one is taken or reserved ("acme" → "acme-help", "acme-help" → "acme-help-2"). */
function altSlug(slug: string): string {
  const base = slug.endsWith("-help") ? `${slug}-2` : `${slug}-help`;
  return base.slice(0, 40).replace(/-+$/, "");
}

/** The API takes public https:// addresses only. */
function validUrl(v: string): boolean {
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" && u.hostname.includes(".");
  } catch {
    return false;
  }
}

/** A choice card in the "How do you want to start?" radio group (and the template picker). */
function ChoiceCard({ checked, onSelect, icon, title, body, name, value }: {
  checked: boolean; onSelect: () => void; icon?: string; title: string; body: string; name: string; value: string;
}) {
  return (
    <label
      className={cx(
        "flex cursor-pointer gap-3.5 rounded-xl p-4 text-text transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-border-focus",
        checked ? "border-[1.5px] border-accent bg-accent-soft" : "border border-border bg-surface hover:bg-surface-hover",
      )}
    >
      <input type="radio" name={name} value={value} checked={checked} onChange={onSelect} className="md-visually-hidden" />
      {icon && (
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text" aria-hidden>
          <Icon name={icon} size={20} />
        </span>
      )}
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-[15px] font-semibold leading-5">{title}</span>
        <span className="text-[13px] leading-[19px] text-text-secondary">{body}</span>
      </span>
    </label>
  );
}

/**
 * /guides/new (New site board): where the site lives (a workspace you're a Guides admin of, or
 * personal; ?ws= preselects), how to start (blank, template, GitBook import, GitHub repo), then the
 * name and the free address `<slug>.guides.markdrop.in` (checked as you type). Imports start a job
 * and land on the import screen; blank and template guides open Design ("You'll pick a theme next").
 */
export default function NewSite() {
  const search = useLocationSearch();
  const wanted = new URLSearchParams(search).get("ws");
  const start = new URLSearchParams(search).get("start");
  const { ready } = useStudioSession(studioNew(wanted));
  const { all, reloadAll } = useStudio();
  const router = useRouter();
  const uid = useId();
  const [scopeChoice, setScopeChoice] = useState<string | null>(null);
  const [source, setSource] = useState<SourceKind>("gitbook");
  const [template, setTemplate] = useState<TemplateId>("product");
  const [url, setUrl] = useState("");
  const [urlTouched, setUrlTouched] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const slugEdited = useRef(false);
  const [slugState, setSlugState] = useState<SlugState>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Where it can live: workspaces you're an admin of (with room on the free plan), or personal.
  const options = all
    ? [
        ...all.workspaces.map((w) => ({ id: w.id, name: w.name, ok: w.can_create, usage: w.usage, why: w.can_create ? "" : "Guides admins only" })),
        { id: PERSONAL, name: "Personal (only you)", ok: all.personal.can_create, usage: all.personal.usage, why: "" },
      ]
    : [];
  const roomy = (o: (typeof options)[number]) => o.ok && o.usage.sites < o.usage.limit;
  const fallback = options.find((o) => o.id === wanted && o.ok)?.id ?? options.find(roomy)?.id ?? options.find((o) => o.ok)?.id ?? null;
  const scope = scopeChoice ?? fallback;
  const chosen = options.find((o) => o.id === scope) ?? null;

  // ?start= (the Guides home's ways to start): preselect it once.
  const startApplied = useRef(false);
  useEffect(() => {
    if (startApplied.current || !start) return;
    startApplied.current = true;
    if (start === "blank" || start === "template" || start === "gitbook") setSource(start);
    else if (start === "openapi") { setSource("template"); setTemplate("api"); }
  }, [start]);

  // Suggest a name and address from the GitBook address (docs.acme.com → "acme").
  useEffect(() => {
    if (source !== "gitbook" || !validUrl(url) || name) return;
    try {
      const host = new URL(url.trim()).hostname.replace(/^www\./, "");
      const parts = host.split(".");
      const brand = parts.length > 2 && ["docs", "help", "support"].includes(parts[0]!) ? parts[1]! : parts[0]!;
      if (!slugEdited.current) setSlug(slugFrom(brand));
    } catch { /* ignore */ }
  }, [source, url, name]);

  // Check the address as it's typed (shape first, then the API).
  useEffect(() => {
    const problem = slugProblem(slug);
    if (!slug) { setSlugState({ state: "idle" }); return; }
    if (problem) { setSlugState({ state: "invalid", message: problem }); return; }
    setSlugState({ state: "checking" });
    let live = true;
    const t = window.setTimeout(() => {
      slugAvailable(slug)
        .then((r) => live && setSlugState(r.available ? { state: "ok" } : { state: r.reason === "invalid" ? "invalid" : "taken", message: r.message || "That address is taken.", suggestion: r.reason === "invalid" ? null : altSlug(slug) }))
        .catch(() => live && setSlugState({ state: "idle" }));
    }, 350);
    return () => { live = false; window.clearTimeout(t); };
  }, [slug]);

  if (!ready) return <StudioLoader />;

  const urlInvalid = source === "gitbook" && urlTouched && !validUrl(url);
  const notAdmin = !!chosen && !chosen.ok;
  const full = !!chosen && chosen.usage.sites >= chosen.usage.limit;
  const listHref = studioHome(wanted);
  const canSubmit =
    !busy && !!chosen && !notAdmin && !full && name.trim().length > 0 && slugState.state !== "invalid" && slugState.state !== "taken" && !!slug &&
    (source !== "gitbook" || validUrl(url)) && source !== "github";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setUrlTouched(true);
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      const site = await createSite({
        workspace_id: scope === PERSONAL ? null : scope,
        name: name.trim(),
        slug,
        source: source === "gitbook" ? { kind: "gitbook", url: url.trim() } : source === "template" ? { kind: "template", template } : { kind: source },
      });
      const job = site.job?.id;
      const base = siteBase(site.id);
      void reloadAll();
      router.push(job ? `${base}/import?job=${encodeURIComponent(job)}` : `${base}/design?new=1`);
    } catch (err) {
      setError(docsErrorMessage(err, "We couldn't create the guide. Try again."));
      setBusy(false);
    }
  }

  const slugHint =
    slugState.state === "checking" ? <span className="inline-flex items-center gap-1.5"><Spinner size={12} /> Checking…</span>
      : slugState.state === "ok" ? <span className="inline-flex items-center gap-1 text-success"><Icon name="check" size={13} /> Available. Add your own domain after it&apos;s published.</span>
        : "Add your own domain after it's published.";
  const slugError = slugState.state === "invalid" || slugState.state === "taken" ? (
    <>
      {slugState.message}
      {slugState.suggestion && (
        <> <button type="button" className="font-semibold text-accent-text underline" onClick={() => { slugEdited.current = true; setSlug(slugState.suggestion!); }}>Use {slugState.suggestion}</button></>
      )}
    </>
  ) : undefined;

  return (
    <>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[880px] px-4 pb-16 pt-6 outline-none sm:px-6 sm:pt-8">
        <Anchor href={listHref} className="md-focus mb-3 inline-flex items-center gap-1.5 rounded text-[13px] text-text-secondary no-underline hover:text-text">
          <Icon name="arrowLeft" size={14} /> All guides
        </Anchor>
        <h1 className="mb-6 text-[28px] font-extrabold leading-9 tracking-[-0.02em] text-text">New guide</h1>
        <form onSubmit={submit} className="flex flex-col gap-8" noValidate>
          <section aria-labelledby={`${uid}-where`} className="flex flex-col gap-2">
            <h2 id={`${uid}-where`} className="text-[16px] font-semibold text-text">Where it lives</h2>
            {all ? (
              <Field
                label="Workspace"
                htmlFor={`${uid}-ws`}
                hint={scope === PERSONAL
                  ? "A personal guide: only you can open and edit it."
                  : "Who can open it follows Guides roles: admins of the workspace, and the people they give a role in Members."}
              >
                <Select
                  id={`${uid}-ws`}
                  value={scope ?? ""}
                  onChange={(e) => setScopeChoice(e.target.value)}
                  options={options.map((o) => ({
                    value: o.id,
                    label: `${o.name}${o.why ? ` (${o.why})` : o.usage.sites >= o.usage.limit ? ` (${o.usage.sites} of ${o.usage.limit} guides used)` : ""}`,
                    disabled: !o.ok,
                  }))}
                />
              </Field>
            ) : (
              <p className="flex items-center gap-2 text-body text-text-muted"><Spinner size={14} /> Loading your workspaces…</p>
            )}
          </section>

          <fieldset className="flex flex-col gap-3.5">
            <legend className="mb-3.5 text-[24px] font-bold leading-8 text-text">How do you want to start?</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {SOURCES.map((o) => (
                <ChoiceCard key={o.id} name={`${uid}-src`} value={o.id} checked={source === o.id} onSelect={() => setSource(o.id)} icon={o.icon} title={o.title} body={o.body} />
              ))}
            </div>
          </fieldset>

          {source === "gitbook" && (
            <section aria-labelledby={`${uid}-imp`} className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
              <h2 id={`${uid}-imp`} className="text-[16px] font-semibold text-text">Your GitBook site</h2>
              <Field
                label="Public address"
                htmlFor={`${uid}-url`}
                hint="We copy pages, images, navigation, icons and old links. Your GitBook site isn't changed."
                error={urlInvalid ? "Paste the address readers use, like https://docs.acme.com." : undefined}
              >
                <Input
                  id={`${uid}-url`}
                  className="ph-no-capture"
                  mono
                  type="url"
                  inputMode="url"
                  placeholder="https://docs.acme.com"
                  value={url}
                  invalid={urlInvalid}
                  onChange={(e) => setUrl(e.target.value)}
                  onBlur={() => setUrlTouched(true)}
                />
              </Field>
              <p className="text-[13px] text-text-muted">
                Private GitBook spaces: export with Git Sync and choose <strong>Connect a GitHub repo</strong> instead.{" "}
                <ReadMore topic="studioImport" />
              </p>
            </section>
          )}

          {source === "template" && (
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-3 text-[16px] font-semibold text-text">Template</legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {TEMPLATES.map((t) => (
                  <ChoiceCard key={t.id} name={`${uid}-tpl`} value={t.id} checked={template === t.id} onSelect={() => setTemplate(t.id)} title={t.title} body={t.body} />
                ))}
              </div>
            </fieldset>
          )}

          {source === "github" && (
            <section aria-labelledby={`${uid}-repo`} className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
              <div className="flex items-center gap-2">
                <h2 id={`${uid}-repo`} className="text-[16px] font-semibold text-text">GitHub repository</h2>
                <Badge tone="info" size="sm">Coming soon</Badge>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="secondary" iconLeft="github" disabled>Connect GitHub</Button>
                <span className="min-w-0 flex-[1_1_280px] text-[13px] text-text-muted">
                  Pick a repo and folder. Every push to the main branch publishes; pull requests get a preview link. Edits in the browser come back as commits.
                </span>
              </div>
              <p className="text-[13px] text-text-muted">Until then, start blank or import from GitBook; you can connect the repo to this guide later in Settings. <ReadMore topic="studioGithub" /></p>
            </section>
          )}

          <section aria-labelledby={`${uid}-name`} className="flex flex-col gap-3.5">
            <h2 id={`${uid}-name`} className="text-[16px] font-semibold text-text">Name and address</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Guide name" htmlFor={`${uid}-n`} hint="Shown in the header and in link previews.">
                <Input
                  id={`${uid}-n`}
                  value={name}
                  maxLength={80}
                  placeholder="Acme Help Center"
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!slugEdited.current) setSlug(slugFrom(e.target.value));
                  }}
                />
              </Field>
              <Field label="Address" htmlFor={`${uid}-s`} hint={slugError ? undefined : slugHint} error={slugError}>
                <Input
                  id={`${uid}-s`}
                  mono
                  value={slug}
                  placeholder="acme"
                  textSuffix={DOCS_HOST_SUFFIX}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={40}
                  invalid={!!slugError}
                  onChange={(e) => { slugEdited.current = true; setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")); }}
                />
              </Field>
            </div>
          </section>

          {notAdmin && <Alert tone="warning" title="Only Guides admins create guides">Ask a Guides admin of {chosen?.name ?? "this workspace"} to create it, and to give you a role on it.</Alert>}
          {!notAdmin && full && chosen && (
            <Alert tone="warning" title={`${chosen.id === PERSONAL ? "You have" : `${chosen.name} has`} ${chosen.usage.sites} of ${chosen.usage.limit} guides`}>
              That&apos;s the most on the free plan. Delete one in its Settings to make room, or choose another workspace.
            </Alert>
          )}
          {error && <Alert tone="danger" title="We couldn't create the guide">{error}</Alert>}

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <p className="min-w-0 flex-[1_1_300px] text-[13px] text-text-muted">Nothing is public until you publish. You&apos;ll pick a theme next. <ReadMore topic="studioCreate" /></p>
            <Button variant="ghost" href={listHref}>Cancel</Button>
            <Button variant="primary" type="submit" iconRight="arrowRight" loading={busy} disabled={!canSubmit && !busy}>
              {source === "gitbook" ? "Import" : "Create guide"}
            </Button>
          </div>
        </form>
      </main>
    </>
  );
}
