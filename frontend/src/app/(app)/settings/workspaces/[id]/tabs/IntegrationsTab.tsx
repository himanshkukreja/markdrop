"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, ConfirmDialog, Field, Select, Skeleton, useToast } from "@/components/ui";
import {
  slackChannels, slackDisconnect, slackInstallUrl, slackLinkStart, slackSettings, slackStatus, slackUnlink,
  type SlackChannel, type SlackStatus,
} from "@/lib/slack";
import { SlackMark } from "@/components/integrations/SlackMark";
import { SwitchRow, shortDate } from "../../../settings-shared";
import { Locked, lockProps, lockSelectProps, type WsTabProps } from "../ws-shared";

/**
 * Integrations (Workspace settings): Markdrop for Slack. Admins connect a Slack workspace (Add to Slack),
 * pick the channel meeting notes go to, update the app's permissions when Markdrop needs new ones, and
 * disconnect. Everyone links their own Slack account (Sign in with Slack); direct messages are opt-in,
 * in Settings › Account › Slack notifications (SlackCard). Backend: routers/slack.py.
 */
export default function IntegrationsTab({ id, isAdmin }: WsTabProps) {
  const toast = useToast();
  const [st, setSt] = useState<SlackStatus | null>(null);
  const [error, setError] = useState("");
  const [channels, setChannels] = useState<SlackChannel[] | null>(null);
  const [busy, setBusy] = useState<"" | "install" | "link" | "unlink" | "channel" | "auto">("");
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    try {
      setSt(await slackStatus(id));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load Slack's settings.");
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!st?.install || !isAdmin || channels) return;
    slackChannels(id).then((r) => setChannels(r.channels)).catch(() => setChannels([]));
  }, [st?.install, isAdmin, id, channels]);

  async function go(kind: "install" | "link") {
    setBusy(kind);
    try {
      const { url } = kind === "install" ? await slackInstallUrl(id) : await slackLinkStart({ workspace_id: id });
      window.location.href = url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work. Try again.");
      setBusy("");
    }
  }

  async function run<T>(key: typeof busy, fn: () => Promise<T>, done?: string): Promise<T | undefined> {
    setBusy(key);
    try {
      const out = await fn();
      if (done) toast.success(done);
      return out;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't save. Try again.");
      return undefined;
    } finally {
      setBusy("");
    }
  }

  if (error) {
    return <Alert tone="danger" title="Couldn't load Slack" actions={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>{error}</Alert>;
  }
  if (!st) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5" aria-busy="true">
        <Skeleton width="40%" height={18} />
        <Skeleton width="80%" height={14} />
      </div>
    );
  }

  const inst = st.install;
  const chosen = inst?.meetings_channel?.id ?? "";

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section aria-labelledby="slack-h" data-testid="slack-card" className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface p-5">
        <div className="flex min-w-0 flex-wrap items-start gap-3">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-bg"><SlackMark /></span>
          <div className="min-w-0 flex-[1_1_280px]">
            <h2 id="slack-h" className="flex flex-wrap items-center gap-2 text-body-strong text-text">
              Slack
              {inst ? <Badge tone="success" size="sm" dot data-testid="slack-connected">Connected</Badge> : st.configured ? null : <Badge size="sm">Not set up yet</Badge>}
            </h2>
            <p className="mt-0.5 text-[13px] leading-5 text-text-secondary">
              Meeting notes with Done buttons in a channel, <code>/markdrop search</code> and <code>/markdrop ask</code> (answers only you see,
              from what you can open), link previews, and direct messages for mentions, sign-offs, shares and access requests for
              people who turn them on.
            </p>
          </div>
          {!inst && st.configured && (
            <Locked locked={!isAdmin}>
              <Button iconLeft="plus" loading={busy === "install"} {...lockProps(!isAdmin)} onClick={() => isAdmin && void go("install")}>Add to Slack</Button>
            </Locked>
          )}
        </div>

        {!st.configured && (
          <p className="text-[13px] text-text-muted">Markdrop for Slack isn&apos;t switched on for this server yet.</p>
        )}

        {inst && (
          <>
            <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
              <dt className="text-text-muted">Slack workspace</dt>
              <dd className="ph-sensitive ph-mask min-w-0 text-text [overflow-wrap:anywhere]" data-testid="slack-team">{inst.team_name || inst.team_id}</dd>
              <dt className="text-text-muted">Connected</dt>
              <dd className="text-text">{[inst.installed_by && `by ${inst.installed_by}`, inst.installed_at && shortDate(inst.installed_at)].filter(Boolean).join(", ")}</dd>
              <dt className="text-text-muted">People linked</dt>
              <dd className="text-text">{inst.linked_people}</dd>
            </dl>
            {!inst.token_ok && (
              <Alert tone="warning" title="Slack's connection broke">Disconnect, then add Markdrop to Slack again.</Alert>
            )}
            {inst.token_ok && !inst.can_find_by_email && (
              <Alert
                tone="warning"
                title="Update Markdrop for Slack"
                actions={isAdmin ? <Button size="sm" loading={busy === "install"} onClick={() => void go("install")}>Update permissions</Button> : undefined}
              >
                <span data-testid="slack-needs-update">
                  Slack notifications find people by their email, which needs two more permissions in Slack.
                  {isAdmin ? " Slack asks you to allow them, then brings you back here." : " A workspace admin updates it here."}
                  {" "}Until then, people link their Slack account to get them.
                </span>
              </Alert>
            )}

            <Locked locked={!isAdmin}>
              <div className="max-w-[360px]">
                <Field label="Meetings channel" hint="Each imported meeting's summary, decisions and action items go here. Meetings restricted to their attendees are never posted. For a private channel, first type /invite @Markdrop in it.">
                  <Select
                    data-testid="slack-channel"
                    value={chosen}
                    disabled={busy === "channel" || (isAdmin && channels === null)}
                    {...lockSelectProps(!isAdmin)}
                    onChange={async (e) => {
                      if (!isAdmin) return;
                      const v = e.target.value;
                      const out = await run("channel", () => slackSettings(id, v ? { meetings_channel_id: v } : { clear_channel: true }),
                        v ? "Meeting notes go to that channel now." : "Meeting notes aren't posted to Slack now.");
                      if (out) setSt(out);
                    }}
                    options={[
                      { value: "", label: "Don't post meetings" },
                      ...(channels ?? (inst.meetings_channel ? [inst.meetings_channel] : [])).map((c) => ({
                        value: c.id, label: `${c.private ? "🔒 " : "#"}${c.name}${c.shared ? " (shared with another organization)" : ""}`,
                      })),
                    ]}
                  />
                </Field>
              </div>
            </Locked>
            {inst.meetings_channel && (
              <Locked locked={!isAdmin}>
                <div>
                  <SwitchRow
                    id="slack-auto"
                    label="Post new meetings automatically"
                    hint="Off: post a meeting by hand from its panel (Post to Slack)."
                    checked={inst.post_meetings}
                    disabled={busy === "auto"}
                    locked={!isAdmin}
                    onChange={async (on) => {
                      const out = await run("auto", () => slackSettings(id, { post_meetings: on }), on ? "New meetings are posted." : "New meetings aren't posted automatically.");
                      if (out) setSt(out);
                    }}
                  />
                </div>
              </Locked>
            )}
            {isAdmin && (
              <div>
                <Button size="sm" variant="secondary" iconLeft="logOut" onClick={() => setConfirm(true)}>Disconnect Slack…</Button>
              </div>
            )}
          </>
        )}
      </section>

      {inst && (
        <section aria-labelledby="slack-me-h" data-testid="slack-me" className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface p-5">
          <div className="flex min-w-0 flex-wrap items-start gap-3">
            <div className="min-w-0 flex-[1_1_280px]">
              <h2 id="slack-me-h" className="text-body-strong text-text">Your Slack account</h2>
              <p className="mt-0.5 text-[13px] leading-5 text-text-secondary">
                {st.me.linked
                  ? <>Linked{st.me.slack_name ? <> as <strong className="ph-sensitive ph-mask">{st.me.slack_name}</strong></> : null}. <code>/markdrop</code> answers you from what your Markdrop account can open, and only you see them.</>
                  : <>Link it once so <code>/markdrop</code> can answer you from what you can open and Done buttons work for you. Slack notifications find you by your email, without linking.</>}
              </p>
            </div>
            {st.me.linked
              ? <Button size="sm" variant="secondary" loading={busy === "unlink"} onClick={async () => {
                  const out = await run("unlink", () => slackUnlink(id), "Your Slack account isn't linked now.");
                  if (out) setSt(out);
                }}>Unlink</Button>
              : <Button size="sm" iconLeft="link" loading={busy === "link"} onClick={() => void go("link")}>Link my Slack account</Button>}
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-t border-border pt-4" data-testid="slack-me-notify">
            <p className="min-w-0 text-[13px] text-text-secondary">
              Slack notifications: <strong className="text-text">{st.me.on ? "On" : "Off"}</strong>
              {st.me.on ? null : <> (off until you turn them on)</>}
            </p>
            <Link href="/settings/account#slack" className="text-[13px] font-medium text-accent-text hover:underline">
              {st.me.on ? "Change" : "Turn on"} in Settings › Account
            </Link>
          </div>
        </section>
      )}

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Disconnect Slack?"
        description={<>Markdrop is removed from <strong>{inst?.team_name}</strong>, and everyone&apos;s Slack link here is forgotten. Messages already posted stay in Slack.</>}
        confirmLabel="Disconnect"
        onConfirm={async () => {
          setSt(await slackDisconnect(id));
          setChannels(null);
          setConfirm(false);
          toast.success("Slack is disconnected.");
        }}
      />
    </div>
  );
}
