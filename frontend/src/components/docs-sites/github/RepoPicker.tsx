"use client";

/**
 * Choosing a GitHub repository's docs to import (New guide › Import from GitHub, and Settings ›
 * GitHub › Connect): the repository (one the Markdrop Guides app can read, or a public one by its
 * address), the branch, the folder (suggested from what's in the repo, or typed), the format
 * (detected, with an override), a preview of what the import will bring (pages, groups, warnings,
 * an OpenAPI file), then "Keep in sync" and what a push does.
 *
 * Every GitHub read is debounced and the one before is aborted, so typing a path or searching
 * repositories never shows an older answer. Repository and owner names are the customer's: masked
 * in session replays (ph-sensitive ph-mask).
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Alert, Avatar, Badge, Field, Icon, Input, SegmentedControl, Select, Skeleton, Spinner, cx } from "@/components/ui";
import {
  FORMAT_CHOICES, FORMAT_LABELS, folderLabel, formatLabel, getGithubRepo, getGithubStatus, githubError, inspectGithubRepo, listGithubRepos,
  parseGithubUrl, type GithubFolder, type GithubFormatChoice, type GithubInspect, type GithubInstallation, type GithubRepo,
  type GithubRepoChoice, type GithubRepoDetail, type GithubSyncMode,
} from "@/lib/docsGithub";
import { num, plural, timeAgo } from "../format";
import { ConnectGithubButton, GithubErrorNote, NOT_SET_UP_BODY } from "./GithubNotes";
import { SyncControls } from "./SyncControls";
import { useGithubQuery } from "./useGithubQuery";

/** What the picker has settled on, reported on every change. */
export interface RepoPickerState {
  /** Complete and worth importing (a branch, a folder with pages, nothing loading); else null. */
  choice: GithubRepoChoice | null;
  /** The repository, once it's read. */
  repo: (GithubRepo & { public?: boolean }) | null;
  /** The folder's preview, once it's read. */
  inspect: GithubInspect | null;
  /** Something is loading. */
  busy: boolean;
}

export interface RepoPickerProps {
  /** A workspace id or "personal": whose GitHub installations to use. */
  workspace: string;
  /** Where github.com sends the browser back to after "Connect GitHub" (a /guides address). */
  returnTo: string;
  onChange: (state: RepoPickerState) => void;
  disabled?: boolean;
}

type Source = "installed" | "public";
const OTHER = "\u0000other";

/** "docs/" or "/docs" → "docs"; "." and ".." segments dropped. */
const normPath = (p: string) => p.trim().replace(/\\/g, "/").split("/").filter((x) => x && x !== "." && x !== "..").join("/");

/** The default branch first, the rest as GitHub listed them. */
function orderBranches(branches: string[], main: string): string[] {
  const rest = branches.filter((b) => b !== main);
  return [main, ...rest];
}

function RepoListSkeleton() {
  return (
    <div className="flex flex-col" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className={cx("flex items-center gap-3 px-3.5 py-3", i && "border-t border-border")}>
          <Skeleton variant="circle" height={16} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5"><Skeleton width={`${46 - i * 6}%`} height={12} /><Skeleton width={`${70 - i * 8}%`} height={10} /></div>
        </div>
      ))}
    </div>
  );
}

/** One repository in the list: a radio row. */
function RepoRow({ repo, checked, name, onSelect, first, disabled }: { repo: GithubRepo; checked: boolean; name: string; onSelect: () => void; first: boolean; disabled?: boolean }) {
  return (
    <label
      className={cx(
        "flex min-w-0 cursor-pointer items-start gap-3 px-3.5 py-2.5 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-border-focus",
        !first && "border-t border-border",
        checked ? "bg-accent-soft" : "hover:bg-surface-hover",
        disabled && "cursor-not-allowed opacity-70",
      )}
    >
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onSelect} className="md-visually-hidden" />
      <Icon name={repo.private ? "lock" : "globe"} size={15} className={cx("mt-0.5 shrink-0", checked ? "text-accent-text" : "text-text-muted")} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2">
          <span className={cx("ph-sensitive ph-mask min-w-0 text-[14px] text-text [overflow-wrap:anywhere]", checked ? "font-semibold" : "font-medium")}>{repo.full_name}</span>
          <span className="md-visually-hidden">{repo.private ? ", private" : ", public"}</span>
        </span>
        {repo.description && <span className="ph-sensitive ph-mask line-clamp-1 text-caption text-text-muted">{repo.description}</span>}
      </span>
      {repo.pushed_at && <span className="hidden shrink-0 pt-0.5 text-caption text-text-muted sm:inline">Pushed {timeAgo(repo.pushed_at)}</span>}
      {checked && <Icon name="check" size={15} className="mt-0.5 shrink-0 text-accent-text" />}
    </label>
  );
}

/** The app's installations, the search and the repository list. */
function InstalledRepos({ workspace, returnTo, installs, canManage, picked, onPick, disabled }: {
  workspace: string;
  returnTo: string;
  installs: GithubInstallation[];
  canManage: boolean;
  picked: { owner: string; name: string; installation_id: number | null } | null;
  onPick: (repo: GithubRepo) => void;
  disabled?: boolean;
}) {
  const uid = useId();
  const [instChoice, setInstChoice] = useState<number | null>(picked?.installation_id ?? null);
  const inst = installs.find((i) => i.installation_id === instChoice) ?? installs.find((i) => !i.suspended) ?? installs[0]!;
  const [search, setSearch] = useState("");
  const [connectError, setConnectError] = useState("");
  const term = search.trim();
  const repos = useGithubQuery(
    inst && !inst.suspended ? `r|${workspace}|${inst.installation_id}|${term}` : null,
    (signal) => listGithubRepos(workspace, inst.installation_id, term, signal),
    { delay: term ? 300 : 0, keep: true },
  );
  const list = repos.data?.repos ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-end gap-2.5">
        {installs.length > 1 ? (
          <Field label="Account" htmlFor={`${uid}-acct`} className="min-w-0 flex-[1_1_220px]">
            <Select
              id={`${uid}-acct`}
              className="ph-sensitive ph-mask"
              value={String(inst.installation_id)}
              disabled={disabled}
              onChange={(e) => { setInstChoice(Number(e.target.value)); setSearch(""); }}
              options={installs.map((i) => ({ value: String(i.installation_id), label: `${i.account.login}${i.account.type === "Organization" ? " (organization)" : ""}${i.suspended ? " (suspended)" : ""}` }))}
            />
          </Field>
        ) : (
          <div className="flex min-w-0 flex-[1_1_220px] items-center gap-2.5">
            <Avatar name={inst.account.login} src={inst.account.avatar_url ?? undefined} size="sm" className="ph-sensitive ph-mask" />
            <span className="flex min-w-0 flex-col">
              <span className="ph-sensitive ph-mask truncate text-body-strong text-text">{inst.account.login}</span>
              <span className="text-caption text-text-muted">{inst.account.type === "Organization" ? "Organization" : "Personal account"} · {inst.repository_selection === "all" ? "all repositories" : "selected repositories"}</span>
            </span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {inst.manage_url && (
            <a href={inst.manage_url} target="_blank" rel="noopener noreferrer" className="md-btn md-btn--ghost md-btn--sm">
              Choose repositories<Icon name="external" /><span className="md-visually-hidden"> on GitHub (opens in a new tab)</span>
            </a>
          )}
          {canManage && <ConnectGithubButton workspace={workspace} returnTo={returnTo} variant="ghost" size="sm" iconLeft="plus" onError={setConnectError} disabled={disabled}>Add an account</ConnectGithubButton>}
        </div>
      </div>
      {connectError && <Alert tone="info" onDismiss={() => setConnectError("")}>{connectError}</Alert>}

      {inst.suspended ? (
        <Alert tone="warning" title="The app is suspended on this account">
          Unsuspend Markdrop Guides in the account&apos;s GitHub settings to read its repositories.
        </Alert>
      ) : (
        <>
          <Input
            type="search"
            aria-label="Search repositories"
            aria-controls={`${uid}-list`}
            placeholder="Search repositories"
            iconPrefix="search"
            suffix={repos.loading && repos.data ? <Spinner size={14} label="Searching" /> : undefined}
            className="ph-no-capture"
            value={search}
            disabled={disabled}
            onChange={(e) => setSearch(e.target.value)}
          />
          {repos.error ? (
            <GithubErrorNote error={repos.error} onRetry={repos.retry} what="repositories" />
          ) : (
            <div
              id={`${uid}-list`}
              role="radiogroup"
              aria-label="Repositories"
              aria-busy={repos.loading || undefined}
              className="max-h-[300px] min-w-0 overflow-y-auto rounded-lg border border-border bg-surface"
            >
              {!repos.data ? (
                <RepoListSkeleton />
              ) : list.length === 0 ? (
                <div className="flex flex-col items-start gap-1 px-4 py-5">
                  <span className="text-body-strong text-text">{term ? <>No repositories match “<span className="ph-sensitive ph-mask">{term}</span>”</> : "No repositories yet"}</span>
                  <span className="text-caption text-text-muted">
                    {term ? "Check the spelling, or choose which repositories the app can read on GitHub." : "The app can't read any repositories on this account. Choose some on GitHub, then come back."}
                  </span>
                </div>
              ) : (
                list.map((r, i) => (
                  <RepoRow
                    key={r.id}
                    repo={r}
                    first={i === 0}
                    name={`${uid}-repo`}
                    disabled={disabled}
                    checked={!!picked && picked.owner.toLowerCase() === r.owner.toLowerCase() && picked.name.toLowerCase() === r.name.toLowerCase()}
                    onSelect={() => onPick({ ...r, installation_id: r.installation_id ?? inst.installation_id })}
                  />
                ))
              )}
            </div>
          )}
          {repos.data?.truncated && <p className="text-caption text-text-muted">Showing the first {num(list.length)}. Search to find the others.</p>}
        </>
      )}
    </div>
  );
}

/** "Connect GitHub" when the app is set up but no account is linked yet. */
function ConnectPanel({ workspace, returnTo, canManage, disabled }: { workspace: string; returnTo: string; canManage: boolean; disabled?: boolean }) {
  const [error, setError] = useState("");
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border-[1.5px] border-dashed border-border-strong p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text" aria-hidden><Icon name="github" size={18} /></span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-body-strong text-text">Connect GitHub to pick from your repositories</span>
          <span className="text-caption text-text-muted">
            Install the Markdrop Guides app on your account or organization and choose the repositories it can read. It only reads: it never changes your repository. You come back here afterwards.
          </span>
        </div>
      </div>
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <ConnectGithubButton workspace={workspace} returnTo={returnTo} variant="primary" onError={setError} disabled={disabled} />
          <ConnectGithubButton workspace={workspace} returnTo={returnTo} link variant="ghost" iconLeft={undefined} onError={setError} disabled={disabled}>Already installed? Link it</ConnectGithubButton>
        </div>
      ) : (
        <p className="text-caption text-text-muted">Ask a Guides admin of this workspace to connect GitHub. Public repositories import without it.</p>
      )}
      {error && <Alert tone="info">{error}</Alert>}
    </div>
  );
}

/** What the folder holds: pages, groups with their first titles, warnings, an OpenAPI file. */
function Preview({ data, loading, error, onRetry }: { data: GithubInspect | null; loading: boolean; error: unknown; onRetry: () => void }) {
  const uid = useId();
  const sel = data?.selected;
  const said = loading ? "Reading the folder…" : error ? "We couldn't read that folder." : sel ? (sel.pages ? `${plural(sel.pages, "page")} found.` : "No pages found in this folder.") : "";
  const groups = sel?.groups ?? [];
  return (
    <section aria-labelledby={`${uid}-h`} aria-busy={loading || undefined} className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface-inset p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Icon name="listTree" size={16} className="shrink-0 text-text-secondary" />
        <h3 id={`${uid}-h`} className="text-body-strong text-text">What the import brings</h3>
        <span role="status" aria-live="polite" className="ml-auto text-caption text-text-muted">{loading ? <span className="inline-flex items-center gap-1.5"><Spinner size={12} />{said}</span> : <span className="md-visually-hidden">{said}</span>}</span>
      </div>
      {loading && !data ? (
        <div className="flex flex-col gap-2" aria-hidden>
          <Skeleton width="30%" height={22} />
          <Skeleton width="80%" height={12} />
          <Skeleton width="65%" height={12} />
          <Skeleton width="72%" height={12} />
        </div>
      ) : error ? (
        <GithubErrorNote error={error} onRetry={onRetry} what="folder" />
      ) : sel ? (
        <div className={cx("flex min-w-0 flex-col gap-3", loading && "opacity-60")}>
          {sel.pages === 0 ? (
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-body-strong text-text">No pages in this folder</span>
              <span className="text-caption text-text-muted">We import .md and .mdx files. Pick another folder, or tell us the format.</span>
            </div>
          ) : (
            <>
              <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="text-[22px] font-bold leading-7 tabular-nums text-text">{num(sel.pages)}{data?.truncated ? "+" : ""}</span>
                <span className="text-body text-text-secondary">
                  {sel.pages === 1 ? "page" : "pages"}
                  {groups.length ? ` in ${plural(groups.length, "group")}` : ""} · {formatLabel(sel.format)}
                </span>
              </p>
              {groups.length > 0 && (
                <ul className="ph-sensitive ph-mask flex min-w-0 flex-col gap-1.5 text-[13px]">
                  {groups.slice(0, 6).map((g, i) => (
                    <li key={`${g.group}-${i}`} className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
                      <span className="flex shrink-0 items-baseline gap-1.5">
                        <strong className="font-semibold text-text">{g.group || "Pages"}</strong>
                        <span className="tabular-nums text-text-muted">{num(g.count)}</span>
                      </span>
                      <span className="min-w-0 truncate text-text-muted" title={g.pages.join(", ")}>{g.pages.join(", ")}{g.count > g.pages.length ? ", …" : ""}</span>
                    </li>
                  ))}
                  {groups.length > 6 && <li className="text-text-muted">…and {plural(groups.length - 6, "more group")}</li>}
                </ul>
              )}
            </>
          )}
          {sel.openapi.length > 0 && (
            <Alert tone="info" icon="code" title="We found an OpenAPI file">
              <code className="ph-sensitive ph-mask font-mono [overflow-wrap:anywhere]">{sel.openapi[0]}</code>
              {sel.openapi.length > 1 ? ` and ${plural(sel.openapi.length - 1, "more")}` : ""}. You can use it as the API reference after the import.
            </Alert>
          )}
          {sel.warnings.length > 0 && (
            <Alert tone="warning" title={sel.warnings.length === 1 ? "Worth knowing" : `${sel.warnings.length} things worth knowing`}>
              <ul className="ph-sensitive ph-mask flex list-disc flex-col gap-1 pl-4">{sel.warnings.slice(0, 8).map((w, i) => <li key={i} className="[overflow-wrap:anywhere]">{w}</li>)}</ul>
            </Alert>
          )}
          {data?.truncated && <p className="text-caption text-text-muted">A large repository: the preview counts what it read first. The import takes everything.</p>}
        </div>
      ) : null}
    </section>
  );
}

export default function RepoPicker({ workspace, returnTo, onChange, disabled }: RepoPickerProps) {
  const uid = useId();
  const status = useGithubQuery(workspace ? `s|${workspace}` : null, (signal) => getGithubStatus(workspace, signal));
  const st = status.data;
  const configured = !!st?.app.configured;
  const installs = useMemo(() => st?.installations ?? [], [st]);
  const [tab, setTab] = useState<Source | null>(null);
  const source: Source | null = tab ?? (st ? (configured && installs.length ? "installed" : "public") : status.error ? "public" : null);

  // The repository: picked from the list, or pasted.
  const [picked, setPicked] = useState<{ owner: string; name: string; installation_id: number | null } | null>(null);
  const [url, setUrl] = useState("");
  const [urlTouched, setUrlTouched] = useState(false);
  const parsed = useMemo(() => parseGithubUrl(url), [url]);
  const ownInstall = (owner: string) => installs.find((i) => !i.suspended && i.account.login.toLowerCase() === owner.toLowerCase())?.installation_id ?? null;
  const target = source === "installed"
    ? picked
    : parsed ? { owner: parsed.owner, name: parsed.name, installation_id: configured ? ownInstall(parsed.owner) : null } : null;
  const repoKey = target ? `${target.owner}/${target.name}`.toLowerCase() : "";

  // A pasted repository on an account the app is installed on is read through the app (it can then
  // sync); when the app can't see it, as a public repository.
  const detail = useGithubQuery<GithubRepoDetail>(
    target ? `d|${workspace}|${repoKey}|${target.installation_id ?? ""}` : null,
    async (signal) => {
      if (target!.installation_id) {
        try {
          return await getGithubRepo(workspace, target!.owner, target!.name, target!.installation_id, signal);
        } catch (e) {
          if (signal.aborted || githubError(e).kind !== "not_found") throw e;
        }
      }
      return getGithubRepo(workspace, target!.owner, target!.name, null, signal);
    },
    { delay: source === "public" ? 400 : 0 },
  );
  const repo = detail.data?.repo ?? null;
  const installationId = detail.data ? (detail.data.via === "app" ? target?.installation_id ?? repo?.installation_id ?? null : null) : null;

  // Branch, folder and format: each remembered for the repository (and branch) it was chosen for,
  // so choosing another repository starts fresh without an effect to reset them.
  const [branchSel, setBranchSel] = useState<{ key: string; value: string } | null>(null);
  const branches = detail.data ? orderBranches(detail.data.branches, detail.data.repo.default_branch) : [];
  const urlBranch = source === "public" && parsed?.branch && branches.includes(parsed.branch) ? parsed.branch : null;
  const branch = detail.data
    ? (branchSel?.key === repoKey && branches.includes(branchSel.value) ? branchSel.value : urlBranch ?? detail.data.repo.default_branch)
    : null;
  const fKey = `${repoKey}@${branch ?? ""}`;
  const [folderSel, setFolderSel] = useState<{ key: string; path: string; other: boolean; text: string } | null>(null);
  const fs = folderSel?.key === fKey ? folderSel : null;
  const urlPath = source === "public" && parsed?.path ? normPath(parsed.path) : null;
  // The folder asked for: chosen or typed, else from the pasted address, else null (the API opens
  // its best suggestion: docs.json, SUMMARY.md, docs/…, rather than the root).
  const asked: string | null = fs ? (fs.other ? normPath(fs.text) : fs.path) : urlPath;
  const [fmtSel, setFmtSel] = useState<{ key: string; value: GithubFormatChoice } | null>(null);
  const format: GithubFormatChoice = fmtSel?.key === repoKey ? fmtSel.value : "auto";

  const inspectKey = target && detail.data && branch ? `i|${workspace}|${repoKey}|${branch}|${asked ?? "\u0000"}|${installationId ?? ""}|${format}` : null;
  const inspect = useGithubQuery<GithubInspect>(
    inspectKey,
    (signal) => inspectGithubRepo({ workspace, owner: target!.owner, name: target!.name, branch: branch!, path: asked, installationId, format }, signal),
    { delay: fs?.other ? 500 : 150 },
  );
  // The folder the preview is for (what the import gets).
  const path = asked ?? (inspect.dataKey === inspectKey ? inspect.data?.selected.path ?? "" : "");

  // The folder list is the repository's (the same for every folder): kept while another folder loads.
  const [folders, setFolders] = useState<{ key: string; list: GithubFolder[] } | null>(null);
  useEffect(() => {
    if (inspect.data) setFolders({ key: fKey, list: inspect.data.folders });
  }, [inspect.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const folderList = folders?.key === fKey ? folders.list : [];
  const folderOptions = folderList.some((f) => f.path === path) || (fs?.other ?? false) ? folderList : [...folderList, { path, format: inspect.data?.selected.format ?? "markdown", pages: inspect.data?.selected.pages ?? 0 }];

  // Sync: needs the app (an installation that can read the repository) and a server with it set up.
  const [syncSel, setSyncSel] = useState<boolean | null>(null);
  const [mode, setMode] = useState<GithubSyncMode>("drafts");
  const canSync = configured && installationId != null;
  const sync = canSync && (syncSel ?? true);
  const [syncConnectError, setSyncConnectError] = useState("");

  const sel = inspect.data?.selected ?? null;
  // Only an answer for exactly what's chosen now counts (not the folder before, still on screen).
  const ready = !!(target && repo && branch && sel && inspect.dataKey === inspectKey && !inspect.loading && !detail.loading && sel.pages > 0);
  const choice: GithubRepoChoice | null = ready
    ? { installation_id: installationId, owner: repo!.owner, name: repo!.name, branch: branch!, path, format, mode, sync }
    : null;
  const busy = status.loading || detail.loading || inspect.loading;
  const reportKey = JSON.stringify([choice, repo?.full_name ?? null, repo?.description ?? null, inspect.data?.sha ?? null, path, busy]);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });
  useEffect(() => {
    onChangeRef.current({ choice, repo, inspect: inspect.data, busy });
  }, [reportKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const urlInvalid = source === "public" && urlTouched && url.trim().length > 0 && !parsed;
  const syncUnavailable = !st && !status.error ? "Checking whether GitHub is connected…"
    : !configured ? NOT_SET_UP_BODY
      : installationId == null ? (
        <>
          Syncing needs the Markdrop Guides app on <span className="ph-sensitive ph-mask">{target?.owner ?? "the repository's account"}</span>. This repository imports once without it.{" "}
          {st?.can_manage && <ConnectGithubButton workspace={workspace} returnTo={returnTo} variant="link" size="sm" iconLeft={undefined} onError={setSyncConnectError}>Connect GitHub</ConnectGithubButton>}
        </>
      ) : null;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <fieldset className="flex min-w-0 flex-col gap-3" disabled={disabled}>
        <legend className="mb-2 text-body-strong text-text">Repository</legend>
        {source === null ? (
          <div className="flex flex-col gap-3" aria-busy="true"><Skeleton width={300} height={32} className="max-w-full" /><Skeleton height={40} /></div>
        ) : (
          <>
            <SegmentedControl
              aria-label="Where the repository is"
              value={source}
              onChange={(v) => setTab(v)}
              className="w-full max-w-[420px]"
              block
              options={[
                { value: "installed", label: "Your repositories", icon: "github" },
                { value: "public", label: "Public repository", icon: "globe" },
              ]}
            />
            {status.error && !st ? <GithubErrorNote error={status.error} onRetry={status.retry} what="GitHub" /> : null}
            {source === "installed" ? (
              !st ? (
                status.error ? null : <RepoListSkeleton />
              ) : !configured ? (
                <Alert tone="info" title="Not set up yet">{NOT_SET_UP_BODY} Choose <strong>Public repository</strong> to paste its address.</Alert>
              ) : installs.length === 0 ? (
                <ConnectPanel workspace={workspace} returnTo={returnTo} canManage={st.can_manage} disabled={disabled} />
              ) : (
                <InstalledRepos
                  workspace={workspace}
                  returnTo={returnTo}
                  installs={installs}
                  canManage={st.can_manage}
                  picked={picked}
                  disabled={disabled}
                  onPick={(r) => setPicked({ owner: r.owner, name: r.name, installation_id: r.installation_id })}
                />
              )
            ) : (
              <Field
                label="Repository address"
                htmlFor={`${uid}-url`}
                hint="A public repository, like https://github.com/acme/docs or acme/docs. A link to a folder opens that folder."
                error={urlInvalid ? "Paste a GitHub repository address, like https://github.com/acme/docs." : undefined}
              >
                <Input
                  id={`${uid}-url`}
                  className="ph-sensitive ph-mask"
                  mono
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="https://github.com/acme/docs"
                  value={url}
                  invalid={urlInvalid}
                  onChange={(e) => setUrl(e.target.value)}
                  onBlur={() => setUrlTouched(true)}
                />
              </Field>
            )}
          </>
        )}
      </fieldset>

      {target && detail.error ? (
        <GithubErrorNote error={detail.error} onRetry={detail.retry} />
      ) : target && !detail.data ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <span role="status" className="flex items-center gap-2 text-body text-text-muted"><Spinner size={14} /> Reading the repository…</span>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><Skeleton height={40} /><Skeleton height={40} /></div>
        </div>
      ) : repo && branch ? (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-border bg-surface px-3.5 py-2.5">
            <Icon name={repo.private ? "lock" : "github"} size={16} className="shrink-0 text-text-secondary" />
            <a
              href={`https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="ph-sensitive ph-mask md-focus min-w-0 rounded font-semibold text-text no-underline [overflow-wrap:anywhere] hover:underline"
            >
              {repo.full_name}<span className="md-visually-hidden"> on GitHub (opens in a new tab)</span>
            </a>
            <Badge size="sm" tone={repo.private ? "neutral" : "info"}>{repo.private ? "Private" : "Public"}</Badge>
            <span className="text-caption text-text-muted sm:ml-auto">{detail.data?.via === "app" ? "Read through the Markdrop Guides app" : "Read as a public repository"}</span>
            {repo.description && <span className="ph-sensitive ph-mask w-full text-caption text-text-muted [overflow-wrap:anywhere]">{repo.description}</span>}
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Branch" htmlFor={`${uid}-branch`} hint={branch === repo.default_branch ? "The default branch." : undefined}>
              <Select
                id={`${uid}-branch`}
                className="ph-sensitive ph-mask"
                value={branch}
                disabled={disabled}
                onChange={(e) => setBranchSel({ key: repoKey, value: e.target.value })}
                options={branches.map((b) => ({ value: b, label: b === repo.default_branch ? `${b} (default)` : b }))}
              />
            </Field>
            <div className="flex min-w-0 flex-col gap-2">
              <Field label="Folder" htmlFor={`${uid}-folder`} hint={fs?.other ? undefined : folderList.length ? "Where the docs are. Suggested from what's in the repository." : undefined}>
                <Select
                  id={`${uid}-folder`}
                  className="ph-sensitive ph-mask"
                  value={fs?.other ? OTHER : path}
                  disabled={disabled}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === OTHER) setFolderSel({ key: fKey, path, other: true, text: path });
                    else setFolderSel({ key: fKey, path: v, other: false, text: "" });
                  }}
                  options={[
                    ...folderOptions.map((f) => ({ value: f.path, label: `${folderLabel(f.path)}${f.pages ? ` · ${FORMAT_LABELS[f.format] ?? f.format} · ${plural(f.pages, "page")}` : ""}` })),
                    { value: OTHER, label: "Other folder…" },
                  ]}
                />
              </Field>
              {fs?.other && (
                <Field label="Folder path" htmlFor={`${uid}-other`} hint="From the repository root, like docs or website/docs. Leave empty for the root.">
                  <Input
                    id={`${uid}-other`}
                    className="ph-sensitive ph-mask"
                    mono
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="docs"
                    value={fs.text}
                    disabled={disabled}
                    autoFocus
                    onChange={(e) => setFolderSel({ ...fs, text: e.target.value })}
                  />
                </Field>
              )}
            </div>
            <Field
              label={<span className="inline-flex flex-wrap items-center gap-1.5">Format {sel && <Badge size="sm" tone="info">Detected: {formatLabel(sel.detected_format)}</Badge>}</span>}
              htmlFor={`${uid}-format`}
              hint={format === "auto" ? "Worked out from the folder's files." : "Imported as this format, whatever the files suggest."}
            >
              <Select
                id={`${uid}-format`}
                value={format}
                disabled={disabled}
                onChange={(e) => setFmtSel({ key: repoKey, value: e.target.value as GithubFormatChoice })}
                options={FORMAT_CHOICES.map((f) => ({ value: f, label: f === "auto" ? (sel ? `Auto (${formatLabel(sel.detected_format)})` : "Auto") : FORMAT_LABELS[f] }))}
              />
            </Field>
          </div>

          <Preview data={inspect.data} loading={inspect.loading} error={inspect.error} onRetry={inspect.retry} />

          <div className="rounded-lg border border-border bg-surface p-4">
            <SyncControls
              sync={sync}
              mode={mode}
              onSync={setSyncSel}
              onMode={setMode}
              branch={branch}
              unavailable={syncUnavailable}
              disabled={disabled}
            />
            {syncConnectError && <Alert tone="info" className="mt-3" onDismiss={() => setSyncConnectError("")}>{syncConnectError}</Alert>}
          </div>
        </>
      ) : null}
    </div>
  );
}
