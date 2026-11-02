"use client";

import { useEffect, useId, useState } from "react";
import { Alert, Anchor, Badge, Button, CopyButton, Field, Icon, Input } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { DOCS_HOST_SUFFIX, addressSecuring, assetPreviewUrl, siteHost, slugAvailable, slugProblem } from "@/lib/docsSites";
import { SECURING_TEXT, SecuringBadge, SecuringNote } from "../AddressSecuring";
import { folderLabel } from "@/lib/docsGithub";
import { timeAgo } from "../format";
import { LinkStatusBadge } from "../github/syncCopy";
import { SiteTile } from "../SiteBar";
import { useSite } from "../SiteContext";
import useLeaveGuard from "../useLeaveGuard";
import { LockedNote, SectionHeader, SettingsCard } from "./SettingsShell";
import { SECTIONS, settingsHref } from "./sections";
import usePatch from "./usePatch";

/**
 * Settings › General: the guide's name, its free address (and changing it), its logo and favicon
 * (set in Design), where it started (a template, blank, or a GitBook or GitHub import and its
 * report), and a summary of the GitHub link (Settings › GitHub has the rest).
 */
export default function GeneralSection() {
  const { site, isAdmin, base } = useSite();
  const { patch, saving, error, setError, locked } = usePatch();
  const uid = useId();
  const [name, setName] = useState(site.name);
  const [editSlug, setEditSlug] = useState(false);
  const [slug, setSlug] = useState(site.slug);
  const [slugMsg, setSlugMsg] = useState("");
  useEffect(() => { setName(site.name); }, [site.name]);

  const nameDirty = name.trim() !== site.name && !locked;
  const slugDirty = editSlug && slug !== site.slug;
  const guard = useLeaveGuard(nameDirty || slugDirty, nameDirty ? "the name" : "the address");

  const host = siteHost(site);
  const securing = site.status === "live" && addressSecuring(site, false);
  const gh = site.github ?? null;
  const brand = site.settings.theme.brand;
  const logo = brand?.enabled ? assetPreviewUrl(site.id, brand.logo_url) : null;

  async function saveName() {
    const n = name.trim();
    if (!n) { setError("Give the guide a name."); return; }
    if (n === site.name) return;
    await patch("name", { name: n }, <>Renamed to <span className="ph-sensitive ph-mask">{n}</span>.</>);
  }

  async function saveSlug() {
    const problem = slugProblem(slug);
    if (problem) { setSlugMsg(problem); return; }
    if (slug === site.slug) { setEditSlug(false); return; }
    try {
      const r = await slugAvailable(slug, site.id);
      if (!r.available) { setSlugMsg(r.message || "That address is taken."); return; }
    } catch { /* the PATCH checks too */ }
    if (await patch("slug", { slug }, <>The address is now <span className="ph-sensitive ph-mask">{slug}{DOCS_HOST_SUFFIX}</span>. The old one stops working.</>)) setEditSlug(false);
  }

  return (
    <>
      <SectionHeader title="General" description={SECTIONS[0].blurb} />
      <LockedNote />
      {error && <Alert tone="danger" onDismiss={() => setError("")}>{error}</Alert>}

      <SettingsCard id="name" title="Name" description="Shown in the guide's header, its browser tab and search results.">
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void saveName(); }}>
          <Field label="Guide name" htmlFor={`${uid}-name`} className="min-w-0 flex-[1_1_280px]">
            <Input className="ph-sensitive ph-mask" value={name} maxLength={80} disabled={locked} onChange={(e) => setName(e.target.value)} />
          </Field>
          {nameDirty && (
            <>
              <Button type="submit" variant="primary" loading={saving === "name"}>Save name</Button>
              <Button variant="ghost" onClick={() => setName(site.name)}>Cancel</Button>
            </>
          )}
        </form>
      </SettingsCard>

      <SettingsCard
        id="address"
        title="Free address"
        description="Always works, even after you add your own domain."
        aside={isAdmin && !editSlug ? <Button variant="ghost" size="sm" onClick={() => { setSlug(site.slug); setSlugMsg(""); setEditSlug(true); }}>Change</Button> : null}
      >
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
          <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-border bg-surface-inset py-2.5 pl-3.5 pr-2.5">
            <Icon name="globe" size={16} className="shrink-0 text-text-secondary" />
            <code className="ph-sensitive ph-mask min-w-0 flex-[1_1_220px] font-mono text-[14px] font-semibold text-text [overflow-wrap:anywhere]">{host}</code>
            {securing && <SecuringBadge />}
            <CopyButton text={`https://${host}`} label="Copy" size="sm" variant="ghost" />
            {site.status === "live" && (securing
              ? <Button size="sm" variant="secondary" iconRight="external" href={`https://${host}`} disabled title={SECURING_TEXT} aria-label={`Open ${host}: available once the address is secured`}>Open</Button>
              : <Button size="sm" variant="secondary" iconRight="external" href={`https://${host}`} target="_blank" rel="noopener noreferrer">Open</Button>)}
          </div>
        )}
        {securing && !editSlug && <SecuringNote />}
        <p className="text-[13px] text-text-muted">
          Want help.yourcompany.com instead? <Anchor className="text-accent-text underline-offset-2 hover:underline" href={settingsHref(base, "domains")}>Add your own domain</Anchor>. <ReadMore topic="studioAddress" />
        </p>
      </SettingsCard>

      <SettingsCard id="logo" title="Logo and favicon" aside={<Button variant="secondary" size="sm" href={`${base}/design`} iconRight="arrowRight">Change in Design</Button>}>
        <div className="flex min-w-0 items-center gap-3">
          <SiteTile site={site} size={40} />
          <p className="min-w-0 flex-1 text-body text-text-secondary">
            {logo
              ? "Your logo, in the guide's header and as its favicon."
              : "No logo yet: the header and the favicon show the guide's initial on its accent colour. Add a logo under Design › Match my brand."}
          </p>
        </div>
      </SettingsCard>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <SettingsCard id="github" title="GitHub" aside={gh ? <LinkStatusBadge link={gh} /> : <Badge size="sm">Not connected</Badge>}>
          {gh ? (
            <>
              <div className="flex min-w-0 items-center gap-2">
                <Icon name="github" size={16} className="shrink-0" />
                <code className="ph-sensitive ph-mask min-w-0 font-mono text-text [overflow-wrap:anywhere]">{gh.owner}/{gh.name} › {gh.branch} › {folderLabel(gh.path)}</code>
              </div>
              <p className="text-[13px] text-text-muted">
                {!gh.sync ? "Syncing is off: pushes don't change the guide." : gh.mode === "publish" ? "Each push is published after it syncs." : "Each push updates the drafts. You publish when ready."}
                {gh.last_synced_at ? ` Last sync ${timeAgo(gh.last_synced_at)}.` : ""}
              </p>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 text-text-secondary"><Icon name="github" size={16} /> Not connected</div>
              <p className="text-[13px] text-text-muted">Import a repository&apos;s docs and keep them in sync on every push. <ReadMore topic="studioGithubImport" /></p>
            </>
          )}
          <Button variant="secondary" size="sm" iconRight="arrowRight" href={settingsHref(base, "github")} className="self-start">Open GitHub settings</Button>
        </SettingsCard>

        {site.source.kind === "gitbook" ? (
          <SettingsCard id="import" title="Imported from GitBook" aside={site.last_import_job_id ? <Badge size="sm" icon="download">Import</Badge> : null}>
            <p className="text-body text-text-secondary">
              {site.source.url ? <>From <code className="ph-sensitive ph-mask font-mono [overflow-wrap:anywhere]">{site.source.url}</code>. </> : null}
              The import&apos;s report lists what needs a look: image descriptions, broken links, hidden pages.
            </p>
            {site.last_import_job_id && <Button variant="secondary" size="sm" iconLeft="listTree" href={`${base}/import`} className="self-start">Open the import report</Button>}
          </SettingsCard>
        ) : site.source.kind === "github" ? (
          <SettingsCard id="import" title="Imported from GitHub" aside={site.last_import_job_id ? <Badge size="sm" icon="download">Import</Badge> : null}>
            <p className="text-body text-text-secondary">
              {site.source.repo ? <>From <code className="ph-sensitive ph-mask font-mono [overflow-wrap:anywhere]">{site.source.repo.owner}/{site.source.repo.name}</code>. </> : null}
              The import&apos;s report lists what needs a look: broken links, missing images, blocks converted approximately.
            </p>
            {site.last_import_job_id && <Button variant="secondary" size="sm" iconLeft="listTree" href={`${base}/import`} className="self-start">Open the import report</Button>}
          </SettingsCard>
        ) : (
          <SettingsCard id="source" title="Started from" aside={<Badge size="sm">{site.source.kind === "template" ? "Template" : "Blank"}</Badge>}>
            <p className="text-body text-text-secondary">{site.source.kind === "template" ? "A template's pages, now yours to edit." : "A blank guide."} Every page&apos;s history is in the editor.</p>
          </SettingsCard>
        )}
      </div>
      {guard}
    </>
  );
}
