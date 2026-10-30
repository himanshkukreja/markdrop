"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Field, Icon, IconButton, Input, Spinner, cx } from "@/components/ui";
import { getWorkspace, type Workspace } from "@/lib/workspaces";
import {
  DOCS_HOST_SUFFIX, createSite, docsErrorMessage, slugAvailable, slugFrom, slugProblem,
  type SourceKind, type TemplateId,
} from "@/lib/docsSites";
import { StudioLoader, docsListHref, siteBase, useStudioSession } from "./SiteContext";

const SOURCES: Array<{ id: SourceKind; icon: string; title: string; body: string }> = [
  { id: "blank", icon: "doc", title: "Blank site", body: "Start with a home page and write in the editor." },
  { id: "template", icon: "layers", title: "From a template", body: "Product docs, API reference or a help center, ready to fill in." },
  { id: "gitbook", icon: "download", title: "Import from GitBook", body: "Paste your docs address. Pages, images, navigation and old links come across." },
  { id: "github", icon: "github", title: "Connect a GitHub repo", body: "Your Markdown stays in Git. Push to publish; edit in the browser too." },
];

const TEMPLATES: Array<{ id: TemplateId; title: string; body: string }> = [
  { id: "product", title: "Product docs", body: "Get started, guides, FAQ and a changelog." },
  { id: "api", title: "API reference", body: "From your OpenAPI file, with Try it." },
  { id: "helpcenter", title: "Help center", body: "Search first, categories and articles." },
];

type SlugState = { state: "idle" | "checking" | "ok" | "taken" | "invalid"; message?: string; suggestion?: string | null };

function validUrl(v: string): boolean {
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" || u.protocol === "http:";
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
 * /w/<ws>/docs/new (New site board): how to start (blank, template, GitBook import, GitHub repo),
 * then the name and the free address `<slug>.docs.markdrop.in` (checked as you type). Imports and
 * templates start a job and land on the import screen; a blank site opens Design ("You'll pick a
 * theme next").
 */
export default function NewSite({ wsId }: { wsId: string }) {
  const listHref = docsListHref(wsId);
  const { ready } = useStudioSession(`${listHref}/new`);
  const router = useRouter();
  const uid = useId();
  const [ws, setWs] = useState<Workspace | null>(null);
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

  useEffect(() => {
    if (ready) getWorkspace(wsId).then(setWs).catch(() => setWs(null));
  }, [ready, wsId]);

  // Suggest a name and address from the GitBook address (docs.acme.com → "Acme Docs", "acme").
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
        .then((r) => live && setSlugState(r.available ? { state: "ok" } : { state: "taken", message: r.reason || "That address is taken.", suggestion: r.suggestion }))
        .catch(() => live && setSlugState({ state: "idle" }));
    }, 350);
    return () => { live = false; window.clearTimeout(t); };
  }, [slug]);

  if (!ready) return <StudioLoader />;

  const urlInvalid = source === "gitbook" && urlTouched && !validUrl(url);
  const canSubmit =
    !busy && name.trim().length > 0 && slugState.state !== "invalid" && slugState.state !== "taken" && !!slug &&
    (source !== "gitbook" || validUrl(url)) && source !== "github";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setUrlTouched(true);
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      const site = await createSite({
        workspace_id: wsId,
        name: name.trim(),
        slug,
        source: source === "gitbook" ? { kind: "gitbook", url: url.trim() } : source === "template" ? { kind: "template", template } : { kind: source },
      });
      const job = site.job_id ?? site.import_job_id;
      const base = siteBase(wsId, site.id);
      router.push(job ? `${base}/import?job=${encodeURIComponent(job)}` : `${base}/design?new=1`);
    } catch (err) {
      setError(docsErrorMessage(err, "We couldn't create the site. Try again."));
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
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-surface px-3 py-2.5 sm:px-6">
        <IconButton icon="x" label="Close" href={listHref} />
        <span className="text-body-strong text-text">New docs site</span>
        {ws && <span className="truncate text-body text-text-muted">in {ws.name}</span>}
      </header>

      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[880px] px-4 pb-16 pt-8 outline-none sm:px-6 sm:pt-10">
        <form onSubmit={submit} className="flex flex-col gap-8" noValidate>
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
                Private GitBook spaces: export with Git Sync and choose <strong>Connect a GitHub repo</strong> instead.
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
              <p className="text-[13px] text-text-muted">Until then, start blank or import from GitBook; you can connect the repo to this site later in Settings.</p>
            </section>
          )}

          <section aria-labelledby={`${uid}-name`} className="flex flex-col gap-3.5">
            <h2 id={`${uid}-name`} className="text-[16px] font-semibold text-text">Name and address</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Site name" htmlFor={`${uid}-n`} hint="Shown in the header and in link previews.">
                <Input
                  id={`${uid}-n`}
                  value={name}
                  maxLength={80}
                  placeholder="Acme Docs"
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

          {error && <Alert tone="danger" title="We couldn't create the site">{error}</Alert>}

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <p className="min-w-0 flex-[1_1_300px] text-[13px] text-text-muted">Nothing is public until you publish. You&apos;ll pick a theme next.</p>
            <Button variant="ghost" href={listHref}>Cancel</Button>
            <Button variant="primary" type="submit" iconRight="arrowRight" loading={busy} disabled={!canSubmit && !busy}>
              {source === "gitbook" ? "Import" : "Create site"}
            </Button>
          </div>
        </form>
      </main>
    </>
  );
}
