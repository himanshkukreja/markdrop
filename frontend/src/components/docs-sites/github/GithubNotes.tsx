"use client";

import { useState } from "react";
import { Alert, Button, type ButtonProps } from "@/components/ui";
import { githubError, startGithubAuthorize, startGithubInstall } from "@/lib/docsGithub";

/** The one sentence for a server without the Markdrop Guides app. */
export const NOT_SET_UP = "Not set up yet: private repositories and sync need the Markdrop Guides GitHub App. Public repositories import without it.";
/** The same, under a "Not set up yet" title. */
export const NOT_SET_UP_BODY = "Private repositories and sync need the Markdrop Guides GitHub App. Public repositories import without it.";

/** "in 3 minutes", "in 40 seconds". */
export function waitWords(seconds: number): string {
  if (seconds >= 90) return `in ${Math.ceil(seconds / 60)} minutes`;
  if (seconds > 1) return `in ${seconds} seconds`;
  return "in a moment";
}

/**
 * A GitHub read that failed, said for what was being read: GitHub's rate limit (with when to try
 * again), a repository that isn't there (or is private without the app), the app not set up here,
 * or anything else with its message. Always offers "Try again" when `onRetry` is given.
 */
export function GithubErrorNote({ error, onRetry, what = "repository", compact }: {
  error: unknown;
  onRetry?: () => void;
  /** What was being read: "repository" (default), "repositories", "folder", "GitHub". */
  what?: "repository" | "repositories" | "folder" | "GitHub";
  compact?: boolean;
}) {
  const e = githubError(error);
  const retry = onRetry ? <Button size="sm" variant="secondary" iconLeft="refresh" onClick={onRetry}>Try again</Button> : undefined;
  if (e.kind === "rate_limit") {
    return (
      <Alert tone="warning" title="GitHub asked us to slow down" actions={retry}>
        GitHub limits how often a repository can be read. Try again {e.retryAfter ? waitWords(e.retryAfter) : "in a few minutes"}.
      </Alert>
    );
  }
  if (e.kind === "not_configured") return <Alert tone="info" title="Not set up yet">{NOT_SET_UP_BODY}</Alert>;
  if (e.kind === "not_found") {
    return (
      <Alert tone="warning" title={what === "folder" ? "That folder isn't in the repository" : "We couldn't find that repository"} actions={retry}>
        {what === "folder"
          ? "Check the folder name and the branch."
          : "Check the address. A private repository needs the Markdrop Guides app on its account."}
      </Alert>
    );
  }
  if (e.kind === "forbidden") {
    return <Alert tone="warning" title="GitHub didn't allow that" actions={retry}>{e.message}</Alert>;
  }
  return (
    <Alert tone="danger" title={compact ? undefined : what === "repositories" ? "We couldn't list the repositories" : what === "folder" ? "We couldn't read that folder" : "We couldn't reach GitHub"} actions={retry}>
      {e.message}
    </Alert>
  );
}

/**
 * "Connect GitHub": asks the API for the app's install address (it carries a signed state with the
 * workspace and where to come back to) and goes there. `link`: link an installation that already
 * exists instead (GitHub sign-in). A 503 means the app isn't set up on this server.
 */
export function ConnectGithubButton({ workspace, returnTo, link, children, onError, ...rest }: {
  workspace: string;
  returnTo: string;
  link?: boolean;
  children?: React.ReactNode;
  onError?: (message: string) => void;
} & Omit<ButtonProps, "onClick" | "onError">) {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      const { url } = await (link ? startGithubAuthorize : startGithubInstall)(workspace, returnTo);
      window.location.assign(url);
    } catch (err) {
      const e = githubError(err);
      onError?.(e.kind === "not_configured" ? NOT_SET_UP : e.message);
      setBusy(false);
    }
  }
  return (
    <Button iconLeft="github" variant="secondary" {...rest} loading={busy} onClick={() => void go()}>
      {children ?? (link ? "Link an existing installation" : "Connect GitHub")}
    </Button>
  );
}
