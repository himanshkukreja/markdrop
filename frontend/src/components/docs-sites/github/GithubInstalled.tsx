"use client";

/**
 * /guides/github/installed: where github.com sends the browser back after installing the Markdrop
 * Guides app (its setup URL) or after GitHub sign-in to link an installation that already exists
 * (its callback). Reads `code`, `state`, `installation_id` and `setup_action`, finishes linking
 * (POST /github/connect: the code is single-use, so it's sent once), says which accounts are
 * connected, then goes back to where it started: the API's `return_to`, only when it's a same-origin
 * /guides address (else /guides).
 *
 * The query holds a one-time code: session replay never records this page (lib/analyticsPath:
 * `code`/`state` aren't Guides query keys), and the address is cleaned once it has been read.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar, Button, Icon, Spinner } from "@/components/ui";
import { useLocationSearch, useMounted } from "@/components/shell/useLocation";
import { connectGithub, githubError, startGithubAuthorize, type GithubInstallation } from "@/lib/docsGithub";
import { StudioLoader, useStudioSession } from "../SiteContext";
import { STUDIO, STUDIO_GITHUB_INSTALLED, studioNew } from "../routes";
import { NOT_SET_UP, recallConnect } from "./GithubNotes";

/** A same-origin /guides address (path, query, hash), else null. */
function safeGuidesPath(v: unknown): string | null {
  if (typeof v !== "string" || !v.startsWith("/") || v.startsWith("//") || v.includes("\\")) return null;
  try {
    const u = new URL(v, window.location.origin);
    if (u.origin !== window.location.origin) return null;
    if (u.pathname !== STUDIO && !u.pathname.startsWith(`${STUDIO}/`)) return null;
    if (u.pathname.startsWith(STUDIO_GITHUB_INSTALLED)) return null;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}

type View =
  | { kind: "working" }
  | { kind: "done"; accounts: GithubInstallation[]; to: string; requested: boolean }
  | { kind: "error"; title: string; body: string };

/** Each code is exchanged once per page load, even when React runs the effect twice. */
let sentFor: string | null = null;

export default function GithubInstalled() {
  const mounted = useMounted();
  const search = useLocationSearch();
  const { ready } = useStudioSession(`${STUDIO_GITHUB_INSTALLED}${search}`);
  const router = useRouter();
  const [view, setView] = useState<View>({ kind: "working" });
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const [started] = useState(() => recallConnect());

  useEffect(() => {
    if (!mounted || !ready) return;
    const p = new URLSearchParams(window.location.search);
    const code = p.get("code");
    const state = p.get("state");
    const instRaw = p.get("installation_id");
    const setup = p.get("setup_action");
    const denied = p.get("error");
    if (denied) {
      setView({ kind: "error", title: "GitHub wasn't connected", body: p.get("error_description") || "The request was cancelled on GitHub. Nothing changed." });
      return;
    }
    // An organization member asked its owners to install the app: nothing to link until they approve.
    if (setup === "request" && !code) {
      setView({ kind: "done", accounts: [], to: safeGuidesPath(started?.returnTo) ?? STUDIO, requested: true });
      return;
    }
    if (!state || !code) {
      setView({
        kind: "error",
        title: state ? "One more step" : "This link is incomplete",
        body: state
          ? "GitHub needs you to sign in to finish linking the app. Choose Try again."
          : "Start again from Guides: choose Import from GitHub, then Connect GitHub.",
      });
      return;
    }
    const once = `${state}|${code ?? ""}|${instRaw ?? ""}`;
    if (sentFor === once) return;
    sentFor = once;
    // The code is single-use: take it out of the address (and the history entry) once read.
    window.history.replaceState(window.history.state, "", STUDIO_GITHUB_INSTALLED);
    const installation_id = instRaw && /^\d+$/.test(instRaw) ? Number(instRaw) : null;
    connectGithub({ code, state, installation_id, setup_action: setup })
      .then((r) => {
        const linked = new Set(r.linked ?? []);
        const accounts = (r.installations ?? []).filter((i) => !linked.size || linked.has(i.installation_id));
        const to = safeGuidesPath(r.return_to) ?? safeGuidesPath(started?.returnTo) ?? STUDIO;
        setView({ kind: "done", accounts, to, requested: setup === "request" && !linked.size });
      })
      .catch((e) => {
        const g = githubError(e);
        setView({
          kind: "error",
          title: g.kind === "bad_request" ? "This link has expired" : g.kind === "forbidden" ? "Your GitHub account can't use that installation" : g.kind === "not_configured" ? "Not set up yet" : "GitHub wasn't connected",
          body: g.kind === "bad_request"
            ? "It was already used, or it's more than a few minutes old. Try again: it takes a moment."
            : g.kind === "forbidden"
              ? "Sign in to GitHub as someone who can manage the app on that account, or ask them to connect it."
              : g.kind === "not_configured" ? NOT_SET_UP : g.message,
        });
      });
  }, [mounted, ready, started]);

  // Connected: go back after a moment (long enough to read which account), unless it was only a request.
  useEffect(() => {
    if (view.kind !== "done" || view.requested) return;
    const t = window.setTimeout(() => router.replace(view.to), 1500);
    return () => window.clearTimeout(t);
  }, [view, router]);

  useEffect(() => {
    if (view.kind !== "working") heading.current?.focus();
  }, [view.kind]);

  if (!ready) return <StudioLoader />;

  const back = safeGuidesPath(started?.returnTo) ?? STUDIO;

  async function retry() {
    const s = started;
    if (!s) { router.replace(studioNew(null, "github")); return; }
    setRetrying(true);
    setRetryError("");
    try {
      const { url } = await startGithubAuthorize(s.workspace, s.returnTo);
      if (!/^https:\/\//i.test(url)) throw new Error("GitHub didn't answer as expected. Try again.");
      window.location.assign(url);
    } catch (e) {
      const g = githubError(e);
      setRetryError(g.kind === "not_configured" ? NOT_SET_UP : g.message);
      setRetrying(false);
    }
  }

  const tile = (icon: string, tone: "accent" | "success" | "danger") => (
    <span
      aria-hidden
      className={`grid size-12 place-items-center rounded-xl ${tone === "success" ? "bg-success-soft text-success" : tone === "danger" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent-text"}`}
    >
      <Icon name={icon} size={24} />
    </span>
  );

  return (
    <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-[560px] flex-1 flex-col px-4 pb-16 pt-12 outline-none sm:pt-20">
      <div className="flex flex-col items-start gap-4 rounded-2xl border border-border bg-surface p-6 sm:p-8" aria-live="polite">
        {view.kind === "working" ? (
          <>
            {tile("github", "accent")}
            <h1 className="text-[22px] font-bold leading-8 text-text">Connecting GitHub…</h1>
            <p className="flex items-center gap-2 text-body text-text-secondary"><Spinner size={14} /> Linking the Markdrop Guides app to your workspace.</p>
          </>
        ) : view.kind === "done" ? (
          <>
            {tile(view.requested ? "clock" : "checkCircle", view.requested ? "accent" : "success")}
            <h1 ref={heading} tabIndex={-1} className="text-[22px] font-bold leading-8 text-text outline-none">
              {view.requested ? "Request sent" : "GitHub is connected"}
            </h1>
            {view.requested ? (
              <p className="text-body text-text-secondary">The organization&apos;s owners have to approve the Markdrop Guides app. Once they do, its repositories show up here.</p>
            ) : view.accounts.length > 0 ? (
              <ul className="flex w-full flex-col gap-2" aria-label="Connected accounts">
                {view.accounts.map((a) => (
                  <li key={a.installation_id} className="flex min-w-0 items-center gap-2.5 rounded-lg border border-border bg-surface-inset px-3 py-2">
                    <Avatar name={a.account.login} src={a.account.avatar_url ?? undefined} size="sm" className="ph-sensitive ph-mask" />
                    <span className="ph-sensitive ph-mask min-w-0 flex-1 truncate font-semibold text-text">{a.account.login}</span>
                    <span className="shrink-0 text-caption text-text-muted">{a.repository_selection === "all" ? "All repositories" : "Selected repositories"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-body text-text-secondary">Your repositories are ready to import.</p>
            )}
            {!view.requested && <p className="flex items-center gap-2 text-[13px] text-text-muted"><Spinner size={12} /> Taking you back…</p>}
            <Button variant={view.requested ? "secondary" : "primary"} iconRight="arrowRight" href={view.to}>{view.requested ? "Back to Guides" : "Continue"}</Button>
          </>
        ) : (
          <>
            {tile("alertCircle", "danger")}
            <h1 ref={heading} tabIndex={-1} className="text-[22px] font-bold leading-8 text-text outline-none">{view.title}</h1>
            <p className="text-body text-text-secondary [overflow-wrap:anywhere]">{view.body}</p>
            {retryError && <p role="alert" className="text-body text-danger">{retryError}</p>}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" iconLeft="refresh" loading={retrying} onClick={() => void retry()}>Try again</Button>
              <Button variant="secondary" href={back}>Back to Guides</Button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
