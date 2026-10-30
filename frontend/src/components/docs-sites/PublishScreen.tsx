"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Alert, Anchor, Avatar, Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, Icon, Skeleton, Spinner, Textarea, useToast, type Tone } from "@/components/ui";
import {
  approveReview, createReview, docsErrorMessage, docsErrorStatus, getChanges, listBuilds, listReviews, primaryAddress,
  getJob, publishSite, requestChanges, restoreBuild, withdrawReview,
  type Build, type ChangesResponse, type PageChange, type Review,
} from "@/lib/docsSites";
import { useAuth } from "@/contexts/AuthContext";
import { firstName, plural, timeAgo, whenShort } from "./format";
import SiteBar from "./SiteBar";
import { useSite } from "./SiteContext";

const RUNNING = new Set(["queued", "building", "publishing"]);
const KIND: Record<PageChange["change"], { label: string; tone: Tone }> = {
  modified: { label: "Edited", tone: "info" },
  added: { label: "New", tone: "success" },
  deleted: { label: "Deleted", tone: "danger" },
};

/** Site settings the changes list names (GET /changes `settings_changed`), with where to change them. */
const SETTING: Record<string, { label: string; badge: string; href: string }> = {
  theme: { label: "Theme and brand", badge: "Design", href: "/design" },
  nav: { label: "Sidebar order", badge: "Pages", href: "" },
  ai: { label: "Ask AI", badge: "Settings", href: "/settings#ai" },
  access: { label: "Who can read it", badge: "Settings", href: "/settings#access" },
  seo: { label: "Search indexing", badge: "Settings", href: "/settings#access" },
  name: { label: "Site name", badge: "Settings", href: "/settings" },
  address: { label: "Address", badge: "Settings", href: "/settings#address" },
  redirects: { label: "Redirects", badge: "Settings", href: "/settings#redirects" },
};

function changeMeta(c: PageChange): string {
  const who = c.updated_by_name ? firstName(c.updated_by_name) : null;
  const what = c.change === "added" ? "new page" : c.change === "deleted" ? "removed" : [
    c.lines_changed ? `${plural(c.lines_changed, "line")} changed` : "edited",
    c.moved_from ? `moved from ${c.moved_from}` : null,
  ].filter(Boolean).join(", ");
  return [who, what].filter(Boolean).join(" · ");
}

function buildTitle(b: Build): string {
  return b.note?.trim() || `Publish #${b.number}`;
}

function buildMeta(b: Build, first: boolean): string {
  const parts = [whenShort(b.finished_at ?? b.created_at)];
  if (b.status === "failed") parts.push("failed");
  else if (b.status === "superseded" && !b.stats) parts.push(b.error || "replaced by a newer publish before it was built");
  else if (b.stats) {
    parts.push(`built in ${Math.max(1, Math.round(b.stats.ms / 1000))} s`);
    parts.push(first ? "first publish" : `${plural(b.stats.uploaded, "file")} updated`);
  }
  return parts.join(" · ");
}

const STAGE: Record<string, string> = { queued: "Waiting to build", building: "Building the site", publishing: "Putting it live" };
/** The build job's steps (docs-platform/runner: prepare → assets → build → publish → done). */
const STEP: Record<string, string> = {
  prepare: "Writing the pages",
  assets: "Fetching images and files",
  build: "Rendering the site",
  publish: "Uploading",
  done: "Going live",
};

/**
 * /docs-studio/<site>/publish (Publish board): what changed since the last publish, then Publish —
 * or "Submit for review" when the site requires one and you aren't an admin. Reviewers and admins
 * see other people's open reviews (Approve and publish · Request changes). Every publish is numbered; an admin can put an
 * earlier one live again (Restore) without a rebuild.
 */
export default function PublishScreen() {
  const { site, base, isAdmin, canReview, canEdit, reload: reloadSite } = useSite();
  const { user } = useAuth();
  const toast = useToast();
  const uid = useId();
  const [changes, setChanges] = useState<ChangesResponse | null>(null);
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [builds, setBuilds] = useState<Build[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string>("");
  const [actionError, setActionError] = useState("");
  const [rejectFor, setRejectFor] = useState<Review | null>(null);
  const [comment, setComment] = useState("");
  const [restoreFor, setRestoreFor] = useState<Build | null>(null);
  /** The running builds' job progress: build id → "Fetching images and files · 12 of 40 files". */
  const [stage, setStage] = useState<Record<string, string>>({});
  const watching = useRef<Set<string>>(new Set());

  const reviewRequired = !!site.settings.review.required;
  const mustReview = reviewRequired && !isAdmin;

  const load = useCallback(async () => {
    try {
      const [c, r, b] = await Promise.all([getChanges(site.id), listReviews(site.id, "open"), listBuilds(site.id)]);
      setChanges(c);
      setReviews(r);
      setBuilds(b);
      setLoadError("");
    } catch (e) {
      setLoadError(docsErrorMessage(e, "Couldn't load what's waiting to publish."));
    }
  }, [site.id]);

  useEffect(() => { void load(); }, [load]);

  // While a build runs, poll the list; when one we started goes live (or fails), say so.
  const running = builds?.filter((b) => RUNNING.has(b.status)) ?? [];
  useEffect(() => {
    if (!running.length) return;
    const t = window.setTimeout(async () => {
      try {
        const next = await listBuilds(site.id);
        setBuilds(next);
        const jobs = await Promise.all(next.filter((b) => RUNNING.has(b.status) && b.job_id).map((b) => getJob(site.id, b.job_id!).then((j) => [b.id, j] as const).catch(() => null)));
        setStage(Object.fromEntries(jobs.filter((x) => !!x).map(([id, j]) => {
          const step = typeof j.progress?.step === "string" ? STEP[j.progress.step] : undefined;
          return [id, [step, j.progress?.message && j.progress.message !== step ? j.progress.message : null].filter(Boolean).join(" · ")];
        })));
        for (const b of next) {
          if (!watching.current.has(b.id) || RUNNING.has(b.status)) continue;
          watching.current.delete(b.id);
          if (b.status === "live") {
            toast.success(`Published. Live at ${primaryAddress(site)}.`);
            void reloadSite();
            void getChanges(site.id).then(setChanges).catch(() => {});
          } else if (b.status === "failed") toast.error(b.error || "The publish failed. Nothing changed for readers.");
        }
      } catch { /* keep the last list; the next render retries */ }
    }, 2000);
    return () => window.clearTimeout(t);
  }, [builds]); // eslint-disable-line react-hooks/exhaustive-deps

  const track = (b: Build) => {
    watching.current.add(b.id);
    setBuilds((list) => [b, ...(list ?? []).filter((x) => x.id !== b.id)]);
  };

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setActionError("");
    try {
      await fn();
    } catch (e) {
      if (key === "publish" && docsErrorStatus(e) === 409) {
        setActionError("This site needs a review before it's published. Submit it for review instead.");
        void reloadSite();
      } else setActionError(docsErrorMessage(e));
    } finally {
      setBusy("");
    }
  }

  const publish = () => run("publish", async () => {
    const b = await publishSite(site.id, note.trim() || undefined);
    track(b);
    setNote("");
    toast.info("Publishing… readers see the new version in a few seconds.");
  });

  const submitReview = () => run("review", async () => {
    const r = await createReview(site.id, note.trim());
    setReviews((list) => [r, ...(list ?? [])]);
    setNote("");
    toast.success("Sent for review. We'll let you know when it's approved.");
  });

  const approve = (r: Review) => run(`approve:${r.id}`, async () => {
    const out = await approveReview(site.id, r.id);
    setReviews((list) => (list ?? []).filter((x) => x.id !== r.id));
    if (out?.build?.id) track(out.build);
    else void load();
    toast.info(`Approved. Publishing ${firstName(r.requested_by_name)}'s changes…`);
  });

  const sendBack = async () => {
    if (!rejectFor) return;
    const r = rejectFor;
    await requestChanges(site.id, r.id, comment.trim());
    setReviews((list) => (list ?? []).filter((x) => x.id !== r.id));
    setRejectFor(null);
    setComment("");
    toast.success(`Sent back to ${firstName(r.requested_by_name)} with your note.`);
  };

  const withdraw = (r: Review) => run(`withdraw:${r.id}`, async () => {
    await withdrawReview(site.id, r.id);
    setReviews((list) => (list ?? []).filter((x) => x.id !== r.id));
    toast.success("Review withdrawn. Your drafts are unchanged.");
  });

  // Restore runs as a job (the site is re-pointed, no rebuild): wait for it, then refresh.
  const [restoring, setRestoring] = useState<string | null>(null);
  const restore = async () => {
    if (!restoreFor) return;
    const b = restoreFor;
    const { job } = await restoreBuild(site.id, b.id);
    setRestoreFor(null);
    setRestoring(b.id);
    try {
      let status = job?.status ?? "done";
      let error: string | null | undefined = null;
      for (let i = 0; job && i < 60 && (status === "queued" || status === "running"); i++) {
        await new Promise((r) => window.setTimeout(r, 1500));
        const j = await getJob(site.id, job.id);
        status = j.status;
        error = j.error;
      }
      if (status === "failed") toast.error(error || `Publish #${b.number} couldn't be put back. Nothing changed for readers.`);
      else if (status === "done") toast.success(`Publish #${b.number} is live again.`);
      else toast.info(`Putting publish #${b.number} back is taking a while. Check again in a minute.`);
    } finally {
      setRestoring(null);
      setBuilds(await listBuilds(site.id).catch(() => builds ?? []));
      void reloadSite();
    }
  };

  const pageChanges = changes?.pages ?? [];
  const settingKeys = changes?.settings_changed ?? [];
  const count = changes?.count ?? pageChanges.length + settingKeys.length;
  const mine = reviews?.filter((r) => r.requested_by === user?.id) ?? [];
  const othersOpen = reviews?.filter((r) => r.requested_by !== user?.id) ?? [];
  const live = builds?.find((b) => b.live) ?? builds?.find((b) => b.status === "live") ?? null;
  const address = primaryAddress(site);
  const reviewers = reviews?.[0]?.reviewers ?? null;
  const oldest = builds && builds.length ? builds[builds.length - 1]!.id : null;

  const statusBadge =
    site.status === "live" ? <Badge tone="success" size="sm" dot className="max-sm:hidden">Live at {address}</Badge>
      : site.status === "unpublished" ? <Badge size="sm" className="max-sm:hidden">Unpublished</Badge>
        : <Badge size="sm" className="max-sm:hidden">Not published yet</Badge>;

  return (
    <>
      <SiteBar section="publish" status={statusBadge} />
      <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-[1180px] flex-wrap gap-7 px-4 pb-16 pt-6 outline-none sm:px-6 sm:pt-8">
        {loadError && (
          <Alert tone="danger" className="w-full" title="We couldn't load this" actions={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>{loadError}</Alert>
        )}

        <section aria-labelledby={`${uid}-ready`} className="flex min-w-0 flex-[1_1_460px] flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h1 id={`${uid}-ready`} className="text-[24px] font-bold leading-8 text-text">
              {!changes ? "Changes since the last publish" : count === 0 ? "Everything is published" : `${plural(count, "change")} since the last publish`}
            </h1>
            <p className="text-body text-text-secondary">
              {site.status === "live"
                ? count === 0 ? "Readers see exactly what's in the editor." : mustReview ? "Readers keep seeing the live site until this is approved and published." : "Readers keep seeing the live site until you publish."
                : "Nothing is public until the first publish."}
            </p>
          </div>

          {!changes && !loadError && (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4" aria-busy="true" aria-label="Loading changes">
              <Skeleton width="70%" /><Skeleton width="55%" /><Skeleton width="62%" />
            </div>
          )}

          {count > 0 && (
            <ul className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface">
              {pageChanges.map((c, i) => (
                <li key={c.id} className={`flex items-center gap-3 px-4 py-3 ${i ? "border-t border-border" : ""}`}>
                  <Badge tone={KIND[c.change]?.tone ?? "neutral"} size="sm">{KIND[c.change]?.label ?? "Changed"}</Badge>
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate font-semibold text-text" dir="auto">{c.title}</strong>
                    <span className="block text-[12px] text-text-muted">{changeMeta(c)}</span>
                  </span>
                  {c.change !== "deleted" && (
                    <Anchor href={`${base}?page=${encodeURIComponent(c.id)}`} className="shrink-0 text-[13px] text-accent-text underline-offset-2 hover:underline">View changes</Anchor>
                  )}
                </li>
              ))}
              {settingKeys.map((k, i) => {
                const s = SETTING[k] ?? { label: k, badge: "Settings", href: "/settings" };
                return (
                  <li key={`setting-${k}`} className={`flex items-center gap-3 px-4 py-3 ${i || pageChanges.length ? "border-t border-border" : ""}`}>
                    <Badge size="sm">{s.badge}</Badge>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate font-semibold text-text">{s.label}</strong>
                      <span className="block text-[12px] text-text-muted">site settings</span>
                    </span>
                    <Anchor href={`${base}${s.href}`} className="shrink-0 text-[13px] text-accent-text underline-offset-2 hover:underline">Open</Anchor>
                  </li>
                );
              })}
            </ul>
          )}

          {actionError && <Alert tone="danger" onDismiss={() => setActionError("")}>{actionError}</Alert>}

          {changes && count > 0 && canEdit && mine.length === 0 && (
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-[18px]">
              {mustReview ? (
                <div className="flex items-center gap-2">
                  <Icon name="shield" size={18} />
                  <strong className="flex-1 text-text">This site requires a review</strong>
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Icon name="send" size={18} />
                    <strong className="flex-1 text-text">Publish {plural(count, "change")}</strong>
                    {isAdmin && <Anchor href={`${base}/settings#review`} className="text-[13px] text-accent-text underline-offset-2 hover:underline">{reviewRequired ? "Change in settings" : "Require reviews"}</Anchor>}
                  </div>
                  {reviewRequired && isAdmin && <p className="text-[13px] text-text-muted">This site requires a review. You&apos;re an admin, so your publish goes straight out.</p>}
                </div>
              )}
              <Field label={mustReview ? "Note for the reviewer" : "What changed (optional)"} htmlFor={`${uid}-note`} hint={mustReview ? undefined : "Shown in the publish history."}>
                <Textarea rows={3} value={note} maxLength={500} placeholder={mustReview ? "What changed and why" : "Rewrote Quickstart for the new onboarding"} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <div className="flex flex-wrap items-center gap-2.5">
                {mustReview ? (
                  <span className="flex min-w-0 flex-[1_1_200px] items-center gap-2 text-text-secondary">
                    {reviewers?.length ? <Avatar name={reviewers[0]!.name} size="sm" /> : <Icon name="users" size={16} />}
                    {reviewers?.length
                      ? `${reviewers[0]!.name}${reviewers.length > 1 ? ` and ${plural(reviewers.length - 1, "other admin")}` : ""} will be asked`
                      : "The site's reviewers and admins will be asked"}
                  </span>
                ) : <span className="flex-1" />}
                {mustReview ? (
                  <Button variant="primary" iconLeft="send" loading={busy === "review"} disabled={!note.trim()} onClick={() => void submitReview()}>Submit for review</Button>
                ) : (
                  <Button variant="primary" iconLeft="send" loading={busy === "publish"} disabled={running.length > 0} onClick={() => void publish()}>
                    {running.length ? "Publishing…" : "Publish"}
                  </Button>
                )}
              </div>
            </div>
          )}

          {mine.map((r) => (
            <div key={r.id} className="flex flex-col gap-2.5 rounded-xl border border-border bg-surface p-[18px]">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="warning" size="sm" dot>Waiting for review</Badge>
                <span className="text-[12px] text-text-muted">sent {timeAgo(r.created_at)}</span>
              </div>
              {r.note && <p className="text-body text-text-secondary">&ldquo;{r.note}&rdquo;</p>}
              <div><Button variant="secondary" size="sm" loading={busy === `withdraw:${r.id}`} onClick={() => void withdraw(r)}>Withdraw</Button></div>
            </div>
          ))}

          {changes && count > 0 && !canEdit && (
            <p className="text-[13px] text-text-muted">You can view this site. Editors and admins publish it.</p>
          )}
        </section>

        <section aria-labelledby={`${uid}-hist`} className="flex min-w-0 flex-[1_1_520px] flex-col gap-4">
          {othersOpen.map((r) => (
            <div key={r.id} className="flex flex-col gap-2.5 rounded-xl border border-warning bg-warning-soft p-[18px]">
              <div className="flex flex-wrap items-center gap-2.5">
                <Avatar name={r.requested_by_name || "Someone"} size="sm" />
                <strong className="min-w-0 flex-1 text-text">{firstName(r.requested_by_name)} wants to publish {plural(r.page_ids.length, "change")}</strong>
                <span className="text-[12px] text-text-secondary">{timeAgo(r.created_at)}</span>
              </div>
              {r.note && <p className="text-body text-text-secondary">&ldquo;{r.note}&rdquo;</p>}
              {canReview ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" size="sm" iconLeft="check" loading={busy === `approve:${r.id}`} disabled={running.length > 0} onClick={() => void approve(r)}>Approve and publish</Button>
                  <Button variant="secondary" size="sm" onClick={() => { setRejectFor(r); setComment(""); }}>Request changes</Button>
                </div>
              ) : (
                <p className="text-[13px] text-text-muted">Waiting for a reviewer or an admin.</p>
              )}
            </div>
          ))}

          <h2 id={`${uid}-hist`} className="mt-2 text-[16px] font-semibold text-text">Publishes</h2>
          {!builds && !loadError && (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4" aria-busy="true"><Skeleton width="60%" /><Skeleton width="50%" /></div>
          )}
          {builds && builds.length === 0 && (
            <EmptyState icon="send" title="Not published yet" description="Your first publish shows up here. Every publish is kept, so you can go back to it." />
          )}
          {builds && builds.length > 0 && (
            <ol className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface">
              {builds.map((b, i) => {
                const isRunning = RUNNING.has(b.status);
                const isLive = b.live ?? b.status === "live";
                // Only a build that went live once can be put back (the API also wants its manifest).
                const canRestore = isAdmin && !isRunning && !isLive && (b.status === "live" || b.status === "superseded") && !!b.manifest_hash;
                return (
                  <li key={b.id} className={`flex flex-wrap items-center gap-3 px-4 py-3 ${i ? "border-t border-border" : ""}`}>
                    <Avatar name={b.requested_by_name || "Someone"} size="sm" />
                    <span className="min-w-0 flex-[1_1_220px]">
                      <strong className="block truncate font-semibold text-text" dir="auto">{buildTitle(b)}</strong>
                      <span className="block text-[12px] text-text-muted">
                        {isRunning ? <span className="inline-flex items-center gap-1.5"><Spinner size={12} /> {stage[b.id] || `${STAGE[b.status]}…`}</span> : buildMeta(b, b.id === oldest)}
                      </span>
                      {b.status === "failed" && b.error && <span className="block text-[12px] text-danger">{b.error}</span>}
                    </span>
                    {isLive && <Badge tone="success" size="sm" dot>Live</Badge>}
                    {b.status === "failed" && <Badge tone="danger" size="sm">Failed</Badge>}
                    {restoring === b.id
                      ? <Badge size="sm"><Spinner size={11} /> Restoring…</Badge>
                      : canRestore && <Button variant="ghost" size="sm" iconLeft="rotate" disabled={!!restoring} onClick={() => setRestoreFor(b)}>Restore</Button>}
                  </li>
                );
              })}
            </ol>
          )}
          <p className="text-[13px] text-text-muted">
            Restoring puts an earlier version live in a few seconds. Nothing is deleted; you can switch back.
            {live && site.last_published_at ? ` Live since ${timeAgo(site.last_published_at)}.` : ""}
          </p>
        </section>
      </main>

      <Dialog
        open={!!rejectFor}
        onClose={() => setRejectFor(null)}
        title={`Send back to ${firstName(rejectFor?.requested_by_name)}`}
        description="Their drafts stay as they are. Say what to change; they'll see your note."
        footer={
          <>
            <Button variant="secondary" onClick={() => setRejectFor(null)}>Cancel</Button>
            <Button variant="primary" disabled={!comment.trim()} onClick={() => void sendBack().catch((e) => setActionError(docsErrorMessage(e)))}>Request changes</Button>
          </>
        }
      >
        <Field label="What should change" htmlFor={`${uid}-comment`}>
          <Textarea rows={4} value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} />
        </Field>
      </Dialog>

      <ConfirmDialog
        open={!!restoreFor}
        onClose={() => setRestoreFor(null)}
        onConfirm={restore}
        tone="default"
        title={`Put publish #${restoreFor?.number ?? ""} live?`}
        body={<>Readers see &ldquo;{restoreFor ? buildTitle(restoreFor) : ""}&rdquo; in a few seconds. Your drafts don&apos;t change, and you can switch back any time.</>}
        confirmLabel="Restore"
      />
    </>
  );
}
