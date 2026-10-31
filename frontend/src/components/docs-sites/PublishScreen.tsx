"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Alert, Button, ConfirmDialog, Dialog, Field, Textarea, useToast } from "@/components/ui";
import {
  approveReview, createReview, docsErrorMessage, docsErrorStatus, getChanges, getJob, getSetup, listBuilds, listReviews,
  requestChanges, restoreBuild, withdrawReview,
  type Build, type ChangesResponse, type Review, type SetupStatus,
} from "@/lib/docsSites";
import { useAuth } from "@/contexts/AuthContext";
import { firstName } from "./format";
import { compareHref } from "./publish/CompareScreen";
import { previousLive } from "./publish/History";
import { LiveView } from "./publish/LiveView";
import { ProgressView } from "./publish/ProgressView";
import { ReadyView } from "./publish/ReadyView";
import { usePublishState } from "./PublishState";
import SiteBar from "./SiteBar";
import { useSite } from "./SiteContext";

/**
 * /guides/<site>/publish, three states:
 *   changes ready   what changed since the live publish, Publish (or "Send for review" when the guide
 *                   requires one and you aren't an admin), reviews waiting, what readers see now
 *   publishing      the running publish's progress (PublishState polls it)
 *   live            the live guide, its addresses, "Finish setting up", the publish history
 * An admin can put an earlier publish live again (Restore) without a rebuild.
 */
export default function PublishScreen() {
  const { site, base, reload: reloadSite } = useSite();
  const { status, running, publish, starting, mustReview, refresh } = usePublishState();
  const { user } = useAuth();
  const toast = useToast();
  const uid = useId();
  const [changes, setChanges] = useState<ChangesResponse | null>(null);
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [builds, setBuilds] = useState<Build[] | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [rejectFor, setRejectFor] = useState<Review | null>(null);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [restoreFor, setRestoreFor] = useState<Build | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

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
    getSetup(site.id).then(setSetup).catch(() => setSetup(null));
  }, [site.id]);

  // Again whenever the publish state moves on (a publish started or went live, a save elsewhere).
  const liveId = status?.live?.id ?? null;
  const runningId = running?.id ?? null;
  const pending = status?.count ?? null;
  useEffect(() => { void load(); }, [load, liveId, runningId, pending, site.status]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setActionError("");
    try {
      await fn();
    } catch (e) {
      if (docsErrorStatus(e) === 409 && /review/i.test(docsErrorMessage(e))) {
        setActionError("This guide needs a review before it's published. Send it for review instead.");
        void reloadSite();
      } else setActionError(docsErrorMessage(e));
    } finally {
      setBusy("");
    }
  }

  const onPublish = async () => {
    const b = await publish({ note, from: "publish_screen" });
    if (b) setNote("");
  };

  const submitReview = () => run("review", async () => {
    const r = await createReview(site.id, note.trim());
    setReviews((list) => [r, ...(list ?? [])]);
    setNote("");
    toast.success("Sent for review. Admins and reviewers see it on the Publish tab.");
  });

  const approve = (r: Review) => run(`approve:${r.id}`, async () => {
    await approveReview(site.id, r.id);
    setReviews((list) => (list ?? []).filter((x) => x.id !== r.id));
    toast.info(`Approved. Publishing ${firstName(r.requested_by_name)}'s changes…`);
    void refresh();
  });

  const sendBack = async () => {
    if (!rejectFor || sending) return;
    const r = rejectFor;
    setSending(true);
    setSendError("");
    try {
      await requestChanges(site.id, r.id, comment.trim());
      setReviews((list) => (list ?? []).filter((x) => x.id !== r.id));
      setRejectFor(null);
      setComment("");
      toast.success(`Sent back to ${firstName(r.requested_by_name)} with your note.`);
    } catch (e) {
      setSendError(docsErrorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const withdraw = (r: Review) => run(`withdraw:${r.id}`, async () => {
    await withdrawReview(site.id, r.id);
    setReviews((list) => (list ?? []).filter((x) => x.id !== r.id));
    toast.success("Review withdrawn. Your drafts are unchanged.");
  });

  // Restore runs as a job (the site is re-pointed, no rebuild): wait for it, then refresh.
  const restore = async () => {
    if (!restoreFor) return;
    const b = restoreFor;
    const { job } = await restoreBuild(site.id, b.id);
    setRestoreFor(null);
    setRestoring(b.id);
    try {
      let st = job?.status ?? "done";
      let error: string | null | undefined = null;
      for (let i = 0; job && i < 60 && (st === "queued" || st === "running"); i++) {
        await new Promise((r) => window.setTimeout(r, 1500));
        const j = await getJob(site.id, job.id);
        st = j.status;
        error = j.error;
      }
      if (st === "failed") toast.error(error || `Publish #${b.number} couldn't be put back. Nothing changed for readers.`);
      else if (st === "done") toast.success(`Publish #${b.number} is live again.`);
      else toast.info(`Putting publish #${b.number} back is taking a while. Check again in a minute.`);
    } finally {
      setRestoring(null);
      void reloadSite();
      void refresh();
      void load();
    }
  };

  const count = changes?.count ?? status?.count ?? 0;
  const live = builds?.find((b) => b.live) ?? status?.live ?? null;
  // The running publish as the progress card shows it: its progress (status) and its changes (builds).
  const runningBuild = running ? { ...running, changes: builds?.find((b) => b.id === running.id)?.changes ?? running.changes } : null;
  const view = runningBuild ? "publishing" : changes && count === 0 && (changes.ever_published || site.status !== "draft") ? "live" : "ready";

  return (
    <>
      <SiteBar section="publish" />
      {view === "publishing" && runningBuild ? (
        <ProgressView
          build={runningBuild}
          queuedAfter={Math.max(0, (status?.running_count ?? 1) - 1)}
          compareHref={compareHref(base, builds ? previousLive(builds, runningBuild) : "live", runningBuild.id)}
        />
      ) : view === "live" ? (
        <LiveView live={live} builds={builds} setup={setup} restoring={restoring} onRestore={setRestoreFor} />
      ) : (
        <ReadyView
          changes={changes}
          loadError={loadError}
          onRetry={() => void load()}
          live={live}
          builds={builds}
          setup={setup}
          reviews={reviews}
          you={user?.id}
          note={note}
          setNote={setNote}
          actionError={actionError}
          clearError={() => setActionError("")}
          onPublish={() => void onPublish()}
          publishing={starting}
          mustReview={mustReview}
          review={{ busy, approve: (r) => void approve(r), sendBack: (r) => { setRejectFor(r); setComment(""); setSendError(""); }, withdraw: (r) => void withdraw(r), submit: () => void submitReview() }}
          restoring={restoring}
          onRestore={setRestoreFor}
        />
      )}

      <Dialog
        open={!!rejectFor}
        onClose={() => setRejectFor(null)}
        dismissible={!sending}
        title={`Send back to ${firstName(rejectFor?.requested_by_name)}`}
        description="Their drafts stay as they are. Say what to change; they'll see your note."
        footer={
          <>
            <Button variant="secondary" disabled={sending} onClick={() => setRejectFor(null)}>Cancel</Button>
            <Button variant="primary" loading={sending} disabled={!comment.trim()} onClick={() => void sendBack()}>Request changes</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="What should change" htmlFor={`${uid}-comment`}>
            <Textarea rows={4} value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} />
          </Field>
          {sendError && <Alert tone="danger">{sendError}</Alert>}
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!restoreFor}
        onClose={() => setRestoreFor(null)}
        onConfirm={restore}
        tone="default"
        title={`Put publish #${restoreFor?.number ?? ""} live?`}
        body={<>Readers see &ldquo;<span className="ph-sensitive ph-mask">{restoreFor ? restoreFor.note?.trim() || `Publish #${restoreFor.number}` : ""}</span>&rdquo; in a few seconds. Your drafts don&apos;t change, and you can switch back any time.</>}
        confirmLabel="Restore"
      />
    </>
  );
}
