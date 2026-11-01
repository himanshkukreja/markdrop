"use client";

/**
 * Settings › GitHub: the repository this guide is imported from and kept in sync with.
 *
 * Not connected: admins pick a repository (RepoPicker: repository, branch, folder, format, preview,
 * Keep in sync, mode) and connect it, which starts the first sync. Connected: the repository ›
 * branch › folder, its format, the last synced commit and the link's status; what a push does
 * (Update drafts / Publish automatically) and Keep in sync, saved as they change; Sync now with the
 * running sync's progress; an OpenAPI file found in the repository offered as the API reference;
 * the sync history; Disconnect (the pages stay, as studio pages).
 *
 * Viewers see it; editors can Sync now; admins change everything. Repository, owner, branch and
 * folder names are the customer's: masked in session replays (ph-sensitive ph-mask).
 */
import { useCallback, useEffect, useId, useState } from "react";
import {
  Alert, Anchor, Badge, Button, ConfirmDialog, Field, Icon, Progress, Select, Skeleton, Table, type Column, useToast,
} from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import {
  FORMAT_CHOICES, FORMAT_LABELS, adoptGithubOpenapi, connectSiteGithub, disconnectSiteGithub, folderLabel, formatLabel, getGithubRepo,
  getSiteGithub, githubError, repoUrl, syncSiteGithub, updateSiteGithub, type GithubFormatChoice, type GithubLink, type GithubRepoChoice,
  type GithubSync, type GithubSyncMode, type SiteGithubState,
} from "@/lib/docsGithub";
import { docsErrorMessage } from "@/lib/docsSites";
import { timeAgo } from "../format";
import { useSite } from "../SiteContext";
import { useJob } from "../useJob";
import { NOT_SET_UP_BODY } from "../github/GithubNotes";
import RepoPicker, { type RepoPickerState } from "../github/RepoPicker";
import { SyncControls } from "../github/SyncControls";
import { LinkStatusBadge, SyncStatusBadge, pagesWords, stepWords, triggerWords } from "../github/syncCopy";
import { useGithubQuery } from "../github/useGithubQuery";
import { LockedNote, SectionHeader, SettingsCard } from "./SettingsShell";
import { SECTIONS, settingsHref } from "./sections";

const BLURB = SECTIONS.find((s) => s.id === "github")?.blurb;

const fullDate = (iso: string | null | undefined) => {
  if (!iso) return undefined;
  try { return new Date(iso).toLocaleString(); } catch { return undefined; }
};

function CommitLink({ sha, short, url }: { sha: string | null; short?: string | null; url?: string | null }) {
  if (!sha) return <span className="text-text-muted">—</span>;
  const text = short || sha.slice(0, 7);
  return url && /^https:\/\//.test(url) ? (
    <a href={url} target="_blank" rel="noopener noreferrer" className="ph-sensitive ph-mask md-focus rounded font-mono text-[13px] text-accent-text underline-offset-2 hover:underline">
      {text}<span className="md-visually-hidden"> (commit on GitHub, opens in a new tab)</span>
    </a>
  ) : (
    <code className="ph-sensitive ph-mask font-mono text-[13px] text-text">{text}</code>
  );
}

/** The sync history: a table on wide screens, cards on phones. */
function History({ syncs, link }: { syncs: GithubSync[]; link: GithubLink }) {
  const commitUrl = (s: GithubSync) => s.commit_url || (s.sha ? `${repoUrl(link).replace(/\/+$/, "")}/commit/${s.sha}` : null);
  const columns: Column<GithubSync>[] = [
    { key: "when", header: "When", render: (s) => <span title={fullDate(s.created_at)} className="whitespace-nowrap">{timeAgo(s.created_at)}</span> },
    { key: "trigger", header: "Started by", render: (s) => <span className="ph-sensitive ph-mask">{triggerWords(s)}</span> },
    { key: "commit", header: "Commit", render: (s) => <CommitLink sha={s.sha} short={s.short_sha} url={commitUrl(s)} /> },
    { key: "pages", header: "Pages", render: (s) => <span className="text-text-secondary">{pagesWords(s.pages)}</span> },
    {
      key: "status",
      header: "Status",
      render: (s) => (
        <span className="flex min-w-0 flex-col items-start gap-1">
          <SyncStatusBadge s={s} />
          {s.published_build ? <span className="text-caption text-text-muted">Published #{s.published_build}</span> : null}
          {s.error && <span className="ph-sensitive ph-mask max-w-[280px] text-caption text-danger [overflow-wrap:anywhere]">{s.error}</span>}
        </span>
      ),
    },
  ];
  if (!syncs.length) return <p className="text-body text-text-muted">No syncs yet.</p>;
  return (
    <>
      <div className="hidden md:block">
        <Table columns={columns} rows={syncs} rowKey={(s) => s.id} hover={false} compact caption="Sync history" />
      </div>
      <ul className="m-0 flex list-none flex-col gap-2 p-0 md:hidden" aria-label="Sync history">
        {syncs.map((s) => (
          <li key={s.id} className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-surface-inset px-3.5 py-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <SyncStatusBadge s={s} />
              <span className="ph-sensitive ph-mask min-w-0 flex-1 text-body-strong text-text">{triggerWords(s)}</span>
              <span className="text-caption text-text-muted" title={fullDate(s.created_at)}>{timeAgo(s.created_at)}</span>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
              <CommitLink sha={s.sha} short={s.short_sha} url={commitUrl(s)} />
              <span className="text-text-secondary">{pagesWords(s.pages)}</span>
              {s.published_build ? <span className="text-text-muted">Published #{s.published_build}</span> : null}
            </div>
            {s.error && <p className="ph-sensitive ph-mask text-caption text-danger [overflow-wrap:anywhere]">{s.error}</p>}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Branch and format of a connected guide (admins change them; they apply from the next sync). */
function SourceOptions({ link, workspace, locked, saving, onSave }: {
  link: GithubLink;
  workspace: string;
  locked: boolean;
  saving: string;
  onSave: (patch: { branch?: string; format?: GithubFormatChoice }, done: string) => void;
}) {
  const uid = useId();
  const repo = useGithubQuery(
    locked ? null : `b|${workspace}|${link.owner}/${link.name}|${link.installation_id ?? ""}`,
    (signal) => getGithubRepo(workspace, link.owner, link.name, link.installation_id, signal),
  );
  const branches = repo.data ? [link.branch, ...repo.data.branches.filter((b) => b !== link.branch)] : [link.branch];
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="Branch" htmlFor={`${uid}-b`} hint={repo.error ? "We couldn't list the branches right now." : "Pushes to this branch update the guide."}>
        <Select
          id={`${uid}-b`}
          className="ph-sensitive ph-mask"
          value={link.branch}
          disabled={locked || saving === "branch"}
          onChange={(e) => onSave({ branch: e.target.value }, `Syncing from ${e.target.value} from now on.`)}
          options={branches.map((b) => ({ value: b, label: repo.data && b === repo.data.repo.default_branch ? `${b} (default)` : b }))}
        />
      </Field>
      <Field label="Format" htmlFor={`${uid}-f`} hint="Auto works it out from the folder's files.">
        <Select
          id={`${uid}-f`}
          value={link.format}
          disabled={locked || saving === "format"}
          onChange={(e) => onSave({ format: e.target.value as GithubFormatChoice }, "Format saved. It applies from the next sync.")}
          options={FORMAT_CHOICES.map((f) => ({ value: f, label: f === "auto" ? "Auto" : FORMAT_LABELS[f] }))}
        />
      </Field>
    </div>
  );
}

export default function GithubSection() {
  const { site, setSite, reload: reloadSite, isAdmin, canEdit, base } = useSite();
  const toast = useToast();
  const workspace = site.workspace_id ?? "personal";
  const [st, setSt] = useState<SiteGithubState | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<"" | "sync" | "mode" | "branch" | "format" | "connect" | "now" | "openapi">("");
  const [pick, setPick] = useState<RepoPickerState>({ choice: null, repo: null, inspect: null, busy: false });
  const [jobId, setJobId] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [openapiPath, setOpenapiPath] = useState("");
  const [openapiDone, setOpenapiDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await getSiteGithub(site.id);
      setSt(s);
      setLoadError(null);
      return s;
    } catch (e) {
      setLoadError(e);
      return null;
    }
  }, [site.id]);
  useEffect(() => { void load(); }, [load]);

  const link = st?.link ?? null;
  // A sync already running when the page opens: follow it too.
  const runningId = jobId ?? (link && (link.status === "queued" || link.status === "syncing") ? link.last_job_id : null);
  const { job } = useJob(site.id, runningId);
  const jobOver = job?.status === "done" || job?.status === "failed";
  useEffect(() => {
    if (!job || !jobOver) return;
    void load();
    void reloadSite();
    if (jobId) {
      if (job.status === "done") toast.success("Synced with GitHub.");
      else toast.error(job.error ? `The sync failed: ${job.error}` : "The sync failed.");
      setJobId(null);
    }
  }, [job?.id, jobOver]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A new link: the section's, and the site's (the editor's banner and General read `site.github`). */
  const took = (l: GithubLink | null) => {
    setSt((s) => (s ? { ...s, link: l } : s));
    setSite({ ...site, github: l });
  };

  async function patch(body: { mode?: GithubSyncMode; sync?: boolean; branch?: string; format?: GithubFormatChoice }, key: typeof saving, done: string) {
    if (!isAdmin) return;
    setSaving(key);
    setError("");
    try {
      took((await updateSiteGithub(site.id, body)).link);
      toast.success(done);
    } catch (e) {
      setError(docsErrorMessage(e, "That didn't save. Try again."));
    } finally {
      setSaving("");
    }
  }

  async function connect(choice: GithubRepoChoice) {
    setSaving("connect");
    setError("");
    try {
      const r = await connectSiteGithub(site.id, choice);
      took(r.link);
      if (r.job?.id) setJobId(r.job.id);
      toast.success(<>Connected to <span className="ph-sensitive ph-mask">{choice.owner}/{choice.name}</span>. The first sync is running.</>);
      void load();
    } catch (e) {
      setError(docsErrorMessage(e, "We couldn't connect the repository. Try again."));
    } finally {
      setSaving("");
    }
  }

  async function syncNow() {
    setSaving("now");
    setError("");
    try {
      const r = await syncSiteGithub(site.id);
      took(r.link);
      if (r.job?.id) setJobId(r.job.id);
      toast.info("Syncing with GitHub…");
    } catch (e) {
      setError(docsErrorMessage(e, "We couldn't start the sync. Try again."));
    } finally {
      setSaving("");
    }
  }

  async function adoptOpenapi(path: string) {
    setSaving("openapi");
    setError("");
    try {
      await adoptGithubOpenapi(site.id, path);
      setOpenapiDone(path);
      void reloadSite();
      toast.success(<>The API reference now comes from <span className="ph-sensitive ph-mask">{path}</span>. It goes live when you publish.</>);
    } catch (e) {
      setError(docsErrorMessage(e, "We couldn't use that file. Try again."));
    } finally {
      setSaving("");
    }
  }

  const header = <SectionHeader title="GitHub" description={<>{BLURB} <ReadMore topic="studioGithubImport" /></>} />;

  if (!st) {
    return (
      <>
        {header}
        {loadError ? (
          <Alert tone="danger" title="GitHub settings didn't load" actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={() => { setLoadError(null); void load(); }}>Try again</Button>}>
            {githubError(loadError).message}
          </Alert>
        ) : (
          <div className="flex flex-col gap-5" aria-busy="true">
            {[0, 1].map((i) => (
              <div key={i} className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 sm:p-[22px]">
                <Skeleton width="30%" height={16} />
                <Skeleton width="70%" height={12} />
                <Skeleton height={40} />
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  // ── Not connected ──
  if (!link) {
    return (
      <>
        {header}
        <LockedNote />
        {error && <Alert tone="danger" onDismiss={() => setError("")}>{error}</Alert>}
        {isAdmin ? (
          <SettingsCard
            id="github-connect"
            title="Connect a repository"
            description="Bring a repository's docs into this guide, then keep them in sync on every push. Pages from the repository are replaced at each sync; pages you add here are never touched."
          >
            {!st.app.configured && <Alert tone="info" title="Not set up yet">{NOT_SET_UP_BODY}</Alert>}
            <RepoPicker workspace={workspace} returnTo={settingsHref(base, "github")} onChange={setPick} disabled={saving === "connect"} />
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <p className="min-w-0 flex-[1_1_260px] text-[13px] text-text-muted">
                {pick.choice ? "The first sync adds the repository's pages as drafts. Nothing is public until you publish." : "Choose a repository and a folder with pages."}
              </p>
              <Button variant="primary" iconLeft="github" loading={saving === "connect"} disabled={!pick.choice} onClick={() => pick.choice && void connect(pick.choice)}>
                Connect and sync
              </Button>
            </div>
          </SettingsCard>
        ) : (
          <SettingsCard id="github-off" title="Not connected" aside={<Badge size="sm">Not connected</Badge>}>
            <p className="text-body text-text-secondary">A Guides admin can connect a GitHub repository: its pages come into this guide and stay in sync on every push.</p>
          </SettingsCard>
        )}
      </>
    );
  }

  // ── Connected ──
  const running = !!runningId && !jobOver && (job?.status === "queued" || job?.status === "running" || !job);
  const p = job?.progress;
  const pct = p && typeof p.done === "number" && typeof p.total === "number" && p.total > 0 ? Math.min(1, p.done / p.total) : 0;
  const lastSync = st.syncs.find((s) => s.status === "done") ?? null;
  const syncUnavailable = !st.app.configured
    ? NOT_SET_UP_BODY
    : link.installation_id == null
      ? "This repository is read without the Markdrop Guides app, so pushes can't reach Markdrop. Sync now brings in the latest commit."
      : null;
  const openapi = link.openapi_paths.filter((x) => x !== openapiDone);
  const chosenApi = openapi.includes(openapiPath) ? openapiPath : openapi[0] ?? "";

  return (
    <>
      {header}
      <LockedNote />
      {error && <Alert tone="danger" onDismiss={() => setError("")}>{error}</Alert>}

      <SettingsCard
        id="github-repo"
        title="Repository"
        aside={
          <>
            <LinkStatusBadge link={link} />
            {canEdit && <Button variant="secondary" size="sm" iconLeft="refresh" loading={saving === "now"} disabled={running} onClick={() => void syncNow()}>Sync now</Button>}
          </>
        }
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-surface-inset px-3.5 py-2.5">
          <Icon name="github" size={16} className="shrink-0 text-text-secondary" />
          <a href={repoUrl(link)} target="_blank" rel="noopener noreferrer" className="ph-sensitive ph-mask md-focus min-w-0 rounded font-mono text-[14px] font-semibold text-text no-underline [overflow-wrap:anywhere] hover:underline">
            {link.owner}/{link.name}<span className="md-visually-hidden"> on GitHub (opens in a new tab)</span>
          </a>
          <Icon name="chevronRight" size={13} className="shrink-0 text-text-muted" />
          <span className="ph-sensitive ph-mask font-mono text-[13px] text-text-secondary [overflow-wrap:anywhere]" title="Branch">{link.branch}</span>
          <Icon name="chevronRight" size={13} className="shrink-0 text-text-muted" />
          <span className="ph-sensitive ph-mask font-mono text-[13px] text-text-secondary [overflow-wrap:anywhere]" title="Folder">{folderLabel(link.path)}</span>
        </div>
        <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-text-muted">Format</dt>
          <dd className="text-text">{formatLabel(link.format)}{link.public ? <span className="text-text-muted"> · read as a public repository</span> : null}</dd>
          <dt className="text-text-muted">Last sync</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-x-2 text-text">
            {link.last_synced_sha ? (
              <>
                <CommitLink sha={link.last_synced_sha} short={lastSync?.sha === link.last_synced_sha ? lastSync.short_sha : null} url={lastSync?.sha === link.last_synced_sha && lastSync.commit_url ? lastSync.commit_url : `${repoUrl(link).replace(/\/+$/, "")}/commit/${link.last_synced_sha}`} />
                {link.last_synced_at && <span className="text-text-muted" title={fullDate(link.last_synced_at)}>{timeAgo(link.last_synced_at)}</span>}
              </>
            ) : (
              <span className="text-text-muted">Not synced yet</span>
            )}
          </dd>
        </dl>

        {running && (
          <div aria-live="polite" className="flex flex-col gap-1.5">
            <Progress
              value={pct}
              max={1}
              indeterminate={!p || !pct}
              label={job?.status === "queued" || !job ? "Waiting for a builder to pick it up…" : `${stepWords(p?.step)}${p?.total ? ` · ${p.done} of ${p.total}` : ""}`}
              valueText={p?.total ? `${p.done} of ${p.total}` : undefined}
            />
          </div>
        )}
        {link.status === "error" && link.last_error && !running && (
          <Alert tone="danger" title="The last sync failed">
            <span className="ph-sensitive ph-mask [overflow-wrap:anywhere]">{link.last_error}</span>
          </Alert>
        )}
      </SettingsCard>

      <SettingsCard id="github-sync" title="Syncing" description="What happens when someone pushes to the branch.">
        <SyncControls
          sync={link.sync}
          mode={link.mode}
          branch={link.branch}
          unavailable={syncUnavailable}
          disabled={!isAdmin || !!saving}
          saving={saving === "sync" || saving === "mode" ? saving : ""}
          onSync={(on) => void patch({ sync: on }, "sync", on ? "Pushes update the guide again." : "Syncing is off. Pushes don't change the guide.")}
          onMode={(m) => void patch({ mode: m }, "mode", m === "publish" ? "Each push is published after it syncs." : "Each push updates the drafts.")}
        />
        {isAdmin && (
          <div className="border-t border-border pt-3.5">
            <SourceOptions link={link} workspace={workspace} locked={!isAdmin} saving={saving} onSave={(body, done) => void patch(body, body.branch ? "branch" : "format", done)} />
          </div>
        )}
      </SettingsCard>

      {isAdmin && openapi.length > 0 && (
        <SettingsCard id="github-openapi" title="API reference" tone="accent">
          <p className="text-body text-text-secondary">
            We found <code className="ph-sensitive ph-mask font-mono [overflow-wrap:anywhere]">{chosenApi}</code> in the repository. Use it as the API reference?
            {site.settings.api?.spec_id ? " It replaces the current description." : ""}
          </p>
          <div className="flex flex-wrap items-end gap-2.5">
            {openapi.length > 1 && (
              <Field label="OpenAPI file" className="min-w-0 flex-[1_1_240px]">
                <Select className="ph-sensitive ph-mask" value={chosenApi} onChange={(e) => setOpenapiPath(e.target.value)} options={openapi.map((x) => ({ value: x, label: x }))} />
              </Field>
            )}
            <Button variant="primary" size="sm" iconLeft="code" loading={saving === "openapi"} onClick={() => void adoptOpenapi(chosenApi)}>Use as API reference</Button>
            <Button variant="ghost" size="sm" href={settingsHref(base, "api-reference")}>API reference settings</Button>
          </div>
        </SettingsCard>
      )}

      <SettingsCard id="github-history" title="Sync history" description="The latest syncs, newest first.">
        <History syncs={st.syncs} link={link} />
      </SettingsCard>

      {isAdmin && (
        <SettingsCard id="github-disconnect" title="Disconnect" aside={<Button variant="danger" size="sm" iconLeft="x" onClick={() => setConfirmOff(true)}>Disconnect</Button>}>
          <p className="text-body text-text-secondary">Stop syncing with this repository. The pages stay in the guide and become editable here.</p>
        </SettingsCard>
      )}

      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        title={<>Disconnect <span className="ph-sensitive ph-mask">{link.owner}/{link.name}</span>?</>}
        body="Pages stay in the guide and become editable here. Pushes stop updating them."
        confirmLabel="Disconnect"
        onConfirm={async () => {
          try {
            await disconnectSiteGithub(site.id);
          } catch (e) {
            throw new Error(docsErrorMessage(e, "We couldn't disconnect it. Try again."));
          }
          setConfirmOff(false);
          setJobId(null);
          took(null);
          void reloadSite();
          toast.success("Disconnected. The pages are studio pages now.");
        }}
      />
      {!canEdit && <p className="text-[13px] text-text-muted">Editors and admins can sync now. <Anchor href={settingsHref(base, "people")} className="text-accent-text underline-offset-2 hover:underline">Who has which role</Anchor></p>}
    </>
  );
}
