"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { Alert, Button, Card, Icon, MarkdropLoader, VisuallyHidden } from "@/components/ui";
import { slackLinkInfo, slackLinkStart } from "@/lib/slack";
import { SlackMark } from "@/components/integrations/SlackMark";

/**
 * /integrations/slack/link?team=<id>: the "Link my Markdrop account" button in Slack. Signed in to
 * Markdrop, the person confirms, then signs in with Slack (OpenID Connect) so Slack itself proves who
 * they are there. A link forwarded to someone else can't attach their Markdrop account to the sender.
 */
export default function SlackLinkClient() {
  const params = useSearchParams();
  const { user, loading } = useAuth();
  const team = params.get("team") || "";
  const [info, setInfo] = useState<{ team_name: string; linked: boolean; slack_name: string | null } | null>(null);
  const [error, setError] = useState("");
  const [going, setGoing] = useState(false);
  const redirected = useRef(false);

  useEffect(() => {
    if (loading || user || redirected.current) return;
    redirected.current = true;
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  }, [loading, user]);

  useEffect(() => {
    if (!user || !team) return;
    slackLinkInfo(team).then(setInfo).catch((e) => setError(e instanceof Error ? e.message : "Couldn't load this link."));
  }, [user, team]);

  if (loading || !user || (!info && !error && team)) {
    return (
      <>
        <VisuallyHidden as="h1">Link Slack</VisuallyHidden>
        <MarkdropLoader label={loading || !user ? "Loading" : "Checking the Slack workspace…"} size="sm" />
      </>
    );
  }

  async function link() {
    setGoing(true);
    try {
      const { url } = await slackLinkStart({ team_id: team });
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Try again.");
      setGoing(false);
    }
  }

  return (
    <Card className="w-full max-w-[440px] sm:p-3">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col items-center gap-3 text-center">
          <SlackMark size={32} />
          <h1 className="m-0 text-h3 text-text">Link your Slack account</h1>
          {info && (
            <p className="m-0 text-body text-text-secondary">
              In <strong className="ph-sensitive ph-mask text-text">{info.team_name || "Slack"}</strong>, Markdrop will answer you as{" "}
              <strong className="ph-sensitive ph-mask font-semibold text-text break-words">{user.email}</strong>.
            </p>
          )}
        </div>
        {!team && <Alert tone="warning">Open this page from Slack: type <strong>/markdrop link</strong>.</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        {info?.linked ? (
          <Alert tone="success" title="Already linked">
            {info.slack_name ? <>You&apos;re linked as <strong>{info.slack_name}</strong>. </> : null}You can close this tab and go back to Slack.
          </Alert>
        ) : info && (
          <>
            <ul className="m-0 flex list-none flex-col gap-2 rounded-lg border border-border bg-surface-inset p-3 sm:p-4">
              {["/markdrop search and ask use only what you can open", "Answers are shown only to you", "Done, Approve and sign-off buttons work as you"].map((t) => (
                <li key={t} className="flex items-center gap-2.5 text-body text-text">
                  <span className="grid size-5 flex-none place-items-center rounded-full bg-success-soft text-success" aria-hidden="true">
                    <Icon name="check" size={12} />
                  </span>
                  {t}
                </li>
              ))}
            </ul>
            <Button variant="primary" size="lg" block loading={going} onClick={link}>Continue with Slack</Button>
            <p className="m-0 text-center text-caption text-text-muted">Slack asks you to confirm who you are. Markdrop keeps no Slack password or token for you.</p>
          </>
        )}
      </div>
    </Card>
  );
}
