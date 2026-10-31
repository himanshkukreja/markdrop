"use client";

import { ReadMore } from "@/components/ReadMore";
import { useId } from "react";
import { Alert, Anchor, Avatar, Badge, Button, CopyButton, EmptyState, Field, Icon, Skeleton, Textarea, type Tone } from "@/components/ui";
import { guideEvents } from "@/lib/guidesEvents";
import { primaryAddress, siteHost, type Build, type ChangeSummary, type ChangesResponse, type PageChange, type Review, type SetupStatus } from "@/lib/docsSites";
import { firstName, plural, timeAgo } from "../format";
import { liveUrl } from "../PublishState";
import { useSite } from "../SiteContext";
import { Checklist } from "./Checklist";
import { compareHref } from "./CompareScreen";
import { History } from "./History";
import { SETTING_LABEL, SummaryBadges } from "./shared";

const KIND: Record<PageChange["change"], { label: string; tone: Tone }> = {
  modified: { label: "Edited", tone: "info" },
  added: { label: "New", tone: "success" },
  deleted: { label: "Removed", tone: "danger" },
};

function changeMeta(c: PageChange): string {
  const who = c.updated_by_name ? firstName(c.updated_by_name) : null;
  if (c.change === "deleted") return [`Removed from ${c.path}`].join("");
  if (c.change === "added") {
    const group = c.path.split("/").filter(Boolean);
    return [group.length > 1 ? `New page in /${group[0]}` : "New page", who].filter(Boolean).join(" · ");
  }
  return [
    who ? `Edited by ${who}` : "Edited",
    c.updated_at ? timeAgo(c.updated_at) : null,
    c.moved_from ? `moved from ${c.moved_from}` : null,
  ].filter(Boolean).join(" · ");
}

/** The summary badges' numbers from the changes list (GET /changes). */
export function summaryOf(ch: ChangesResponse | null): ChangeSummary | null {
  if (!ch) return null;
  const s = ch.settings_changed;
  return {
    added: ch.pages.filter((p) => p.change === "added").length,
    edited: ch.pages.filter((p) => p.change === "modified").length,
    removed: ch.pages.filter((p) => p.change === "deleted").length,
    design: s.includes("theme"),
    redirects: s.includes("redirects"),
    api: s.includes("api"),
    settings: s,
  };
}

export interface ReviewActions {
  busy: string;
  approve: (r: Review) => void;
  sendBack: (r: Review) => void;
  withdraw: (r: Review) => void;
  submit: () => void;
}

/**
 * Changes ready to publish (PublishReady board): "N changes ready to publish", what kind, the list
 * (Compare per page), and on the right Publish (a note, Publish, Preview first, the review rule) and
 * what readers see now. An editor on a guide that requires a review sends it for review instead;
 * reviewers and admins see other people's open reviews here.
 */
export function ReadyView(props: {
  changes: ChangesResponse | null;
  loadError: string;
  onRetry: () => void;
  live: Build | null;
  builds: Build[] | null;
  setup: SetupStatus | null;
  reviews: Review[] | null;
  you: string | null | undefined;
  note: string;
  setNote: (v: string) => void;
  actionError: string;
  clearError: () => void;
  onPublish: () => void;
  publishing: boolean;
  mustReview: boolean;
  review: ReviewActions;
  restoring: string | null;
  onRestore: (b: Build) => void;
}) {
  const { changes, live, reviews, you, note, setNote, review, mustReview } = props;
  const { site, base, isAdmin, canEdit, canReview } = useSite();
  const uid = useId();
  const pageChanges = changes?.pages ?? [];
  const settingKeys = changes?.settings_changed ?? [];
  const count = changes?.count ?? 0;
  const mine = reviews?.filter((r) => r.requested_by === you) ?? [];
  const othersOpen = reviews?.filter((r) => r.requested_by !== you) ?? [];
  const reviewers = reviews?.[0]?.reviewers ?? null;
  const reviewRequired = !!site.settings.review?.required;
  const host = primaryAddress(site);
  const isLive = site.status === "live";
  const firstChanged = pageChanges.find((c) => c.change !== "deleted");
  const previewHref = firstChanged ? `${base}?page=${encodeURIComponent(firstChanged.id)}&preview=1` : `${base}?preview=1`;
  const ever = changes?.ever_published ?? isLive;
  const from = live?.id ?? (ever ? "live" : "none");

  return (
    <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-4 pb-16 pt-6 outline-none sm:px-6 sm:pt-8">
      {props.loadError && (
        <Alert tone="danger" title="We couldn't load this" actions={<Button size="sm" variant="secondary" onClick={props.onRetry}>Try again</Button>}>{props.loadError}</Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        <section aria-labelledby={`${uid}-ch`} className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h1 id={`${uid}-ch`} className="text-[26px] font-bold leading-8 tracking-[-0.02em] text-text">
              {!changes ? "Changes ready to publish" : count === 0 ? "Nothing to publish yet" : `${plural(count, "change")} ready to publish`}
            </h1>
            <p className="text-body text-text-secondary">
              {count === 0 && changes
                ? "Write a page and it shows up here, ready to publish."
                : isLive
                  ? <>Readers still see the version published {timeAgo(site.last_published_at) || "earlier"}. {mustReview ? "Send it for review: once it's approved, it's live in about a minute." : "Preview the new one, then publish: it's live in about a minute."}</>
                  : <>Nothing is public until the first publish. Preview it, then publish: it&apos;s live in about a minute.</>}{" "}
              <ReadMore topic="studioPublish" />
            </p>
          </div>
          <SummaryBadges summary={summaryOf(changes)} />

          {othersOpen.map((r) => (
            <div key={r.id} className="flex flex-col gap-2.5 rounded-xl border border-warning bg-warning-soft p-[18px]">
              <div className="flex flex-wrap items-center gap-2.5">
                <Avatar name={r.requested_by_name || "Someone"} size="sm" />
                <strong className="min-w-0 flex-1 text-text">{firstName(r.requested_by_name)} wants to publish {plural(r.page_ids.length, "change")}</strong>
                <span className="text-[12px] text-text-secondary">{timeAgo(r.created_at)}</span>
              </div>
              {r.note && <p className="ph-sensitive ph-mask text-body text-text-secondary">&ldquo;{r.note}&rdquo;</p>}
              {canReview ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" size="sm" iconLeft="check" loading={review.busy === `approve:${r.id}`} disabled={props.publishing} onClick={() => review.approve(r)}>Approve and publish</Button>
                  <Button variant="secondary" size="sm" onClick={() => review.sendBack(r)}>Request changes</Button>
                  <Button variant="ghost" size="sm" href={compareHref(base, from, "drafts")}>Compare</Button>
                </div>
              ) : (
                <p className="text-[13px] text-text-muted">Waiting for a reviewer or an admin.</p>
              )}
            </div>
          ))}

          {!changes && !props.loadError && (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4" aria-busy="true" aria-label="Loading changes">
              <Skeleton width="70%" /><Skeleton width="55%" /><Skeleton width="62%" />
            </div>
          )}
          {changes && count === 0 && (
            <EmptyState icon="doc" title="No pages yet" description="Pages you write show up here, ready to publish." actions={canEdit ? <Button variant="primary" iconLeft="edit" href={base}>Write a page</Button> : undefined} />
          )}
          {count > 0 && (
            <ul className="ph-no-capture flex flex-col overflow-hidden rounded-xl border border-border bg-surface" aria-label="Changes">
              {pageChanges.map((c) => (
                <li key={c.id} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                  <span className="grid size-[30px] shrink-0 place-items-center rounded-md bg-surface-inset text-text-secondary" aria-hidden><Icon name="doc" size={15} /></span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <strong className="truncate font-semibold text-text" dir="auto" title={c.title}>{c.title}</strong>
                    <span className="truncate text-[12px] text-text-muted">{changeMeta(c)}</span>
                  </span>
                  <Badge tone={KIND[c.change]?.tone ?? "neutral"} size="sm">{KIND[c.change]?.label ?? "Changed"}</Badge>
                  <Button variant="ghost" size="sm" href={compareHref(base, from, "drafts", c.id)}>
                    Compare<span className="md-visually-hidden"> {c.title}</span>
                  </Button>
                </li>
              ))}
              {settingKeys.map((k) => {
                const s = SETTING_LABEL[k] ?? { title: k, meta: "Guide settings", badge: "Settings", icon: "settings", href: "/settings" };
                return (
                  <li key={`setting-${k}`} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                    <span className="grid size-[30px] shrink-0 place-items-center rounded-md bg-surface-inset text-text-secondary" aria-hidden><Icon name={s.icon} size={15} /></span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <strong className="truncate font-semibold text-text">{s.title}</strong>
                      <span className="truncate text-[12px] text-text-muted">{s.meta}</span>
                    </span>
                    <Badge size="sm">{s.badge}</Badge>
                    <Button variant="ghost" size="sm" href={`${base}${s.href}`}>Open<span className="md-visually-hidden"> {s.title}</span></Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <aside aria-label="Publish" className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-[132px]">
          {canEdit && mine.length === 0 && count > 0 && (
            <div className="flex flex-col gap-3.5 rounded-xl border border-border bg-surface p-5 shadow-sm">
              <h2 className="text-[16px] font-semibold leading-6 text-text">{mustReview ? "Send for review" : "Publish"}</h2>
              {mustReview && (
                <p className="flex items-center gap-2 text-[13px] text-text-secondary">
                  <Icon name="shield" size={15} className="shrink-0" /> This guide requires a review before it&apos;s published.
                </p>
              )}
              <Field label={mustReview ? "Note for the reviewer" : <>What changed <span className="font-normal text-text-muted">(optional)</span></>} htmlFor={`${uid}-note`} hint={mustReview ? undefined : "Shown in the publish history."}>
                <Textarea id={`${uid}-note`} rows={3} value={note} maxLength={500} placeholder={mustReview ? "What changed and why" : "Rewrote Quickstart for the new onboarding"} onChange={(e) => setNote(e.target.value)} className="ph-sensitive ph-mask" />
              </Field>
              {props.actionError && <Alert tone="danger" onDismiss={props.clearError}>{props.actionError}</Alert>}
              {mustReview ? (
                <>
                  <span className="flex items-center gap-2 text-[13px] text-text-secondary">
                    {reviewers?.length ? <Avatar name={reviewers[0]!.name} size="sm" /> : <Icon name="users" size={15} />}
                    {reviewers?.length
                      ? `${reviewers[0]!.name}${reviewers.length > 1 ? ` and ${plural(reviewers.length - 1, "other admin")}` : ""} will be asked`
                      : "The guide's reviewers and admins will be asked"}
                  </span>
                  <Button variant="primary" iconLeft="send" block loading={review.busy === "review"} disabled={!note.trim()} onClick={review.submit}>Send for review</Button>
                </>
              ) : (
                <Button variant="primary" iconLeft="upload" block loading={props.publishing} onClick={props.onPublish}>Publish {plural(count, "change")}</Button>
              )}
              <Button variant="secondary" iconLeft="eye" block href={previewHref}>Preview first</Button>
              <div className="flex items-center gap-2 border-t border-border pt-3 text-[12px] text-text-muted">
                <Icon name="info" size={13} className="shrink-0" />
                <span className="flex-1">
                  {reviewRequired
                    ? isAdmin ? <>Reviews are required. You&apos;re an admin, so your publish goes straight out. <Anchor href={`${base}/settings#review`} className="text-accent-text underline">Change</Anchor></> : <>Reviewers and admins approve changes. <ReadMore topic="studioReviews" /></>
                    : isAdmin ? <>Want a second pair of eyes? <Anchor href={`${base}/settings#review`} className="text-accent-text underline">Require reviews</Anchor></> : "Your publish goes straight out."}
                </span>
              </div>
            </div>
          )}

          {mine.map((r) => (
            <div key={r.id} className="flex flex-col gap-2.5 rounded-xl border border-border bg-surface p-5 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="warning" size="sm" dot>Waiting for review</Badge>
                <span className="text-[12px] text-text-muted">sent {timeAgo(r.created_at)}</span>
              </div>
              {r.note && <p className="ph-sensitive ph-mask text-body text-text-secondary">&ldquo;{r.note}&rdquo;</p>}
              <div><Button variant="secondary" size="sm" loading={review.busy === `withdraw:${r.id}`} onClick={() => review.withdraw(r)}>Withdraw</Button></div>
            </div>
          ))}

          {!canEdit && count > 0 && (
            <p className="rounded-xl border border-border bg-surface p-4 text-[13px] text-text-muted">You can view this guide. Editors and admins publish it.</p>
          )}

          <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-surface px-[18px] py-4">
            <h2 className="text-[14px] font-semibold leading-5 text-text">Readers see now</h2>
            {isLive ? (
              <>
                <span className="flex min-w-0 items-center gap-1.5">
                  <a href={liveUrl(host)} target="_blank" rel="noopener noreferrer" onClick={() => guideEvents.liveOpened("publish")}
                    className="ph-sensitive ph-mask inline-flex min-w-0 items-center gap-1.5 font-mono text-[13px] text-accent-text no-underline hover:underline">
                    <span className="truncate">{host}</span><Icon name="external" size={12} className="shrink-0" />
                    <span className="md-visually-hidden">(opens in a new tab)</span>
                  </a>
                  <CopyButton text={liveUrl(host)} label={`Copy ${host}`} iconOnly size="sm" announceText="Address copied" onCopy={() => guideEvents.addressCopied(host !== siteHost(site))} />
                </span>
                {live && (
                  <span className="text-[12px] text-text-muted">
                    Publish #{live.number} · {timeAgo(live.finished_at ?? site.last_published_at)}{live.requested_by_name ? ` by ${firstName(live.requested_by_name)}` : ""} · <Anchor href="#history" className="text-accent-text underline-offset-2 hover:underline">History</Anchor>
                  </span>
                )}
              </>
            ) : (
              <span className="text-[13px] text-text-muted">{site.status === "unpublished" ? "Nothing: the guide is unpublished." : "Nothing yet: the guide isn't published."}</span>
            )}
          </div>

          {!ever && <Checklist setup={props.setup} />}
        </aside>
      </div>

      {ever && <History builds={props.builds} restoring={props.restoring} onRestore={props.onRestore} />}
    </main>
  );
}

export default ReadyView;
