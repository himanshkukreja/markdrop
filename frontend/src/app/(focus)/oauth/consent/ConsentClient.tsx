"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { ApiError, clearToken } from "@/lib/api";
import { useQueryFlags } from "@/lib/useQueryFlags";
import { track } from "@/lib/track";
import {
  decideOAuthRequest, getOAuthRequest, hostOf, scopeIcon, type OAuthRequestInfo,
} from "@/lib/oauthClient";
import { Alert, Anchor, Avatar, Button, Card, Icon, MarkdropMark, MarkdropLoader, Spinner, VisuallyHidden } from "@/components/ui";
import { SignInForm } from "@/components/auth/SignInForm";
import { FocusState } from "@/components/auth/FocusState";
import { ClientLogo } from "@/components/oauth/ClientLogo";

/**
 * /oauth/consent?request=<id> — the OAuth 2.1 consent screen for the MCP server (spec: "Frontend" §1).
 *
 * The API's /oauth/authorize validates the client and redirect URI, stores a pending request (10
 * minutes) and sends the browser here. This page signs the visitor in if needed (the shared
 * SignInForm, whose Google path returns to this same URL), loads the request with the user's
 * session, and posts Approve or Cancel; the API answers with the client's redirect URL.
 *
 * The request id is read after mount (useQueryFlags), so the route stays static. The card is
 * `ph-no-capture` (it shows the account email); the URL's query never reaches analytics
 * (lib/analyticsPath drops it, and replay only runs on query-free URLs).
 */

/** Remembers, for this tab, that a request was answered: Back after the redirect then says so. */
const DONE_KEY = "md_oauth_done";
interface Done { id: string; approve: boolean; name: string; host: string }

function readDone(id: string): Done | null {
  try {
    const raw = sessionStorage.getItem(DONE_KEY);
    const d = raw ? (JSON.parse(raw) as Done) : null;
    return d && d.id === id ? d : null;
  } catch {
    return null;
  }
}
function writeDone(d: Done) {
  try { sessionStorage.setItem(DONE_KEY, JSON.stringify(d)); } catch { /* private mode: Back just shows "expired" */ }
}

/** Only an https redirect (or a loopback http one, as native apps use) may leave this page. */
function safeRedirect(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return u.toString();
    if (u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return u.toString();
    return null;
  } catch {
    return null;
  }
}

const LINK = "md-focus rounded-sm font-medium text-accent-text underline underline-offset-2 hover:text-accent-text-hover";
const MAX_NAME = 80;

type Load =
  | { s: "idle" }
  | { s: "loading" }
  | { s: "ready"; info: OAuthRequestInfo }
  | { s: "expired" }
  | { s: "invalid"; message: string }
  | { s: "error" };

type Leaving = { approve: boolean; name: string; host: string; slow: boolean };

export default function ConsentClient() {
  const q = useQueryFlags();
  const id = q.ready ? (q.get("request") || "").trim() : null;
  const { user, loading: authLoading, logout, refresh } = useAuth();

  const [load, setLoad] = useState<Load>({ s: "idle" });
  const [done, setDone] = useState<Done | null>(null);
  const [deciding, setDeciding] = useState<"approve" | "deny" | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);
  const [answered, setAnswered] = useState(false);
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const [switching, setSwitching] = useState(false);
  const loadSeq = useRef(0);

  // Back after answering: say it was answered rather than "expired" (the API deleted the request).
  useEffect(() => {
    if (id) setDone(readDone(id));
  }, [id]);

  const fetchRequest = useCallback(async (rid: string) => {
    const seq = ++loadSeq.current;
    setLoad({ s: "loading" });
    try {
      const info = await getOAuthRequest(rid);
      if (seq === loadSeq.current) setLoad({ s: "ready", info });
    } catch (e) {
      if (seq !== loadSeq.current) return;
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 404 || status === 410) setLoad({ s: "expired" });
      else if (status === 401) {
        // The session is no good any more: sign in again, then this loads again.
        clearToken();
        setLoad({ s: "idle" });
        await refresh();
      } else if (status === 0 || status >= 500 || status === 429) setLoad({ s: "error" });
      else setLoad({ s: "invalid", message: e instanceof Error ? e.message : "" });
    }
  }, [refresh]);

  useEffect(() => {
    if (!id || !user || done || leaving) return;
    if (load.s === "idle") void fetchRequest(id);
  }, [id, user, done, leaving, load.s, fetchRequest]);

  // Signing out (Switch account) forgets the loaded request; it reloads for the next account.
  useEffect(() => {
    if (!user) setLoad({ s: "idle" });
  }, [user]);

  // bfcache: Back to this page after the redirect keeps the "Taking you back" view; say it's done.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) setLeaving((l) => (l ? { ...l, slow: true } : l)); };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  async function decide(approve: boolean) {
    if (!id || load.s !== "ready" || deciding) return;
    const info = load.info;
    setDeciding(approve ? "approve" : "deny");
    setDecideError(null);
    try {
      const { redirect_url } = await decideOAuthRequest(id, approve);
      const target = safeRedirect(redirect_url);
      if (!target) throw new ApiError("BAD_REDIRECT", 400);
      const name = info.client.name.slice(0, MAX_NAME);
      const host = info.client.redirect_host || hostOf(target) || "";
      writeDone({ id, approve, name, host });
      track(approve ? "oauth_approved" : "oauth_denied");
      setLeaving({ approve, name, host, slow: false });
      window.location.assign(target);
      // A native app (loopback redirect) may leave this tab open: settle after a beat.
      window.setTimeout(() => setLeaving((l) => (l ? { ...l, slow: true } : l)), 4000);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 404 || status === 409 || status === 410) setAnswered(true);
      else if (status === 401) {
        clearToken();
        await refresh();
      } else if (e instanceof ApiError && e.message === "BAD_REDIRECT") {
        setDecideError("Markdrop couldn't send you back to this app. Start again from the app.");
      } else {
        setDecideError(approve
          ? "Couldn't approve. Check your connection and try again."
          : "Couldn't cancel. Check your connection and try again, or close this tab.");
      }
      setDeciding(null);
    }
  }

  async function switchAccount() {
    setSwitching(true);
    try { await logout(); } finally { setSwitching(false); }
  }

  /* ── Which view ─────────────────────────────────────────────────────── */
  let view: string;
  if (!q.ready || authLoading || switching) view = "loading";
  else if (!id) view = "missing";
  else if (leaving) view = "leaving";
  else if (done) view = "done";
  else if (answered) view = "answered";
  else if (!user) view = "signin";
  else view = load.s === "idle" ? "loading" : load.s;

  // Move focus to the new heading whenever the view changes, so a screen reader hears it.
  const holder = useRef<HTMLDivElement>(null);
  const firstView = useRef(true);
  useEffect(() => {
    if (view === "loading") return;
    if (firstView.current) { firstView.current = false; if (view === "signin") return; }
    const h = holder.current?.querySelector<HTMLElement>("h1");
    if (!h) return;
    h.tabIndex = -1;
    h.style.outline = "none";
    h.focus({ preventScroll: false });
  }, [view]);

  return (
    <div ref={holder} className="flex w-full min-w-0 flex-1 items-center justify-center py-2 sm:py-6">
      {renderView()}
    </div>
  );

  function renderView() {
    switch (view) {
      case "loading":
        return (
          <>
            <VisuallyHidden as="h1">Connect an app to Markdrop</VisuallyHidden>
            <MarkdropLoader label={authLoading || !q.ready ? "Loading" : "Loading the request"} size="sm" />
          </>
        );

      case "missing":
        return (
          <FocusState
            icon="link"
            title="Open this from your AI app"
            description="This page finishes connecting an AI app to Markdrop. Add Markdrop in the app, choose Connect, and it brings you here."
            actions={<Button href="/mcp" variant="primary" size="lg" iconRight="arrowRight">How to connect an app</Button>}
          />
        );

      case "signin": {
        const here = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/oauth/consent";
        return (
          <Card className="w-full max-w-[440px] sm:p-3">
            <SignInForm
              variant="page"
              next={here}
              title="Sign in to connect your app"
              message="An AI app asked to use your Markdrop account. Sign in, then choose whether to allow it."
            />
          </Card>
        );
      }

      case "expired":
        return (
          <FocusState
            icon="clock"
            title="This sign-in link expired"
            description="Start again from your AI app. Each link works once, for 10 minutes."
            actions={<Button href="/mcp" variant="secondary" size="lg">How to connect an app</Button>}
          />
        );

      case "answered":
        return (
          <FocusState
            icon="clock"
            title="This request was already answered"
            description="It was approved, cancelled or expired while this page was open. Start again from your AI app if it isn't connected."
            actions={<Button href="/settings/connections" variant="secondary" size="lg">See connected apps</Button>}
          />
        );

      case "done": {
        const d = done!;
        return (
          <FocusState
            icon={d.approve ? "checkCircle" : "x"}
            title={d.approve ? `${d.name} is connected` : "You cancelled this request"}
            description={d.approve
              ? <>Go back to {d.name} to use Markdrop. You can disconnect it anytime in <Anchor href="/settings/connections" className={LINK}>Connected apps</Anchor>.</>
              : "Nothing was shared. Start again from your AI app if you change your mind."}
          />
        );
      }

      case "invalid":
        return (
          <FocusState
            icon="alertCircle"
            title="This app's request can't be used"
            description={
              <>
                {load.s === "invalid" && load.message && !/^Couldn't/.test(load.message) ? <>{load.message.replace(/\.$/, "")}. </> : null}
                Start again from your AI app. If it keeps happening, the app may not work with Markdrop yet.
              </>
            }
            actions={<Button href="/mcp" variant="secondary" size="lg">Supported apps</Button>}
          />
        );

      case "error":
        return (
          <FocusState
            icon="wifiOff"
            title="Can't reach Markdrop right now"
            description="Check your connection and try again. The request stays open for 10 minutes from when your app sent you here."
            actions={<Button variant="primary" size="lg" iconLeft="refresh" onClick={() => id && void fetchRequest(id)}>Try again</Button>}
          />
        );

      case "leaving": {
        const l = leaving!;
        return (
          <Card className="w-full max-w-[440px] sm:p-3">
            <div className="flex flex-col items-center gap-4 py-2 text-center" role="status">
              <span className={`grid size-12 place-items-center rounded-full ${l.approve ? "bg-success-soft text-success" : "bg-surface-active text-text-secondary"}`} aria-hidden="true">
                <Icon name={l.approve ? "check" : "x"} size={22} />
              </span>
              <h1 className="m-0 text-h3 text-text [overflow-wrap:anywhere]">
                {l.approve ? `Approved. ${l.name} is connected.` : "Cancelled. Nothing was shared."}
              </h1>
              {l.slow ? (
                <p className="m-0 text-body text-text-secondary">
                  You can close this tab and go back to {l.name}.
                </p>
              ) : (
                <p className="m-0 flex items-center gap-2 text-body text-text-secondary">
                  <Spinner size={16} /> Taking you back to <span className="font-mono text-text">{l.host}</span>…
                </p>
              )}
            </div>
          </Card>
        );
      }

      case "ready":
      default:
        return load.s === "ready" ? (
          <ConsentCard
            info={load.info}
            fallbackEmail={user?.email ?? ""}
            deciding={deciding}
            error={decideError}
            onApprove={() => void decide(true)}
            onCancel={() => void decide(false)}
            onSwitch={() => void switchAccount()}
          />
        ) : null;
    }
  }
}

/* ── The consent card ─────────────────────────────────────────────────── */

function ConsentCard({ info, fallbackEmail, deciding, error, onApprove, onCancel, onSwitch }: {
  info: OAuthRequestInfo;
  fallbackEmail: string;
  deciding: "approve" | "deny" | null;
  error: string | null;
  onApprove: () => void;
  onCancel: () => void;
  onSwitch: () => void;
}) {
  const name = (info.client.name || "An app").slice(0, MAX_NAME);
  const email = info.account?.email || fallbackEmail;
  const accountName = info.account?.name || email;
  const host = info.client.redirect_host;
  const unverified = info.client.verified_by === "registration";
  const busy = deciding !== null;

  return (
    <Card className="ph-no-capture w-full max-w-[460px] sm:p-3">
      <div className="flex min-w-0 flex-col gap-5">
        {/* App ⇢ Markdrop. Decorative: the heading says it. */}
        <div className="flex items-center justify-center gap-3" aria-hidden="true">
          <ClientLogo name={name} logo={info.client.logo_uri} size={56} />
          <div className="relative flex h-8 w-16 min-w-0 items-center justify-center sm:w-24">
            <span className="absolute inset-x-0 top-1/2 border-t-2 border-dashed border-border-strong" />
            <span className="relative grid size-7 place-items-center rounded-full border border-border bg-surface-raised text-text-secondary">
              <Icon name="link" size={14} />
            </span>
          </div>
          <span className="grid size-14 flex-none place-items-center rounded-xl border border-border bg-surface-raised shadow-(--shadow-sm)">
            <MarkdropMark size={32} />
          </span>
        </div>

        <div className="flex min-w-0 flex-col gap-1.5 text-center">
          <h1 className="m-0 text-h3 text-text [overflow-wrap:anywhere]" dir="auto">
            <span className="font-extrabold">{name}</span> wants to access your Markdrop account
          </h1>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface-inset p-3">
          <Avatar name={accountName} size="sm" />
          <div className="min-w-0 flex-1 basis-48">
            <p className="m-0 text-caption text-text-muted">Signed in as</p>
            <p className="m-0 text-body-strong text-text break-words">{email}</p>
          </div>
          <span className="ml-auto flex flex-none items-center gap-0.5">
            <span className="text-caption text-text-muted">Not you?</span>
            <Button variant="ghost" size="sm" onClick={onSwitch} disabled={busy} className="max-sm:min-h-11">
              Switch account
            </Button>
          </span>
        </div>

        <section aria-labelledby="consent-scopes" className="flex min-w-0 flex-col gap-2">
          <h2 id="consent-scopes" className="m-0 text-eyebrow uppercase text-text-muted">It will be able to</h2>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {info.scopes.map((sc) => (
              <li key={sc.name} className="flex min-w-0 items-start gap-3">
                <span className="grid size-9 flex-none place-items-center rounded-lg bg-accent-soft text-accent-text" aria-hidden="true">
                  <Icon name={scopeIcon(sc.name)} size={18} />
                </span>
                <div className="min-w-0">
                  <p className="m-0 text-body-strong text-text">{sc.title}</p>
                  <p className="m-0 text-caption text-text-secondary">{sc.description}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <ul className="m-0 flex list-none flex-col gap-1.5 border-t border-border p-0 pt-4 text-caption text-text-secondary">
          <li className="flex items-start gap-2">
            <Icon name="lock" size={14} className="mt-0.5 flex-none text-text-muted" />
            <span>It can&apos;t read end-to-end encrypted documents, and never sees your sign-in code.</span>
          </li>
          <li className="flex items-start gap-2">
            <Icon name="settings" size={14} className="mt-0.5 flex-none text-text-muted" />
            <span>Disconnect it anytime in Settings → Connected apps.</span>
          </li>
        </ul>

        {unverified && (
          <Alert tone="warning">
            Markdrop hasn&apos;t verified who makes this app. Approve only if you just connected it yourself.
          </Alert>
        )}
        {error && <Alert tone="danger" live>{error}</Alert>}

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="secondary" size="lg" onClick={onCancel} loading={deciding === "deny"} disabled={busy && deciding !== "deny"} className="sm:min-w-28">
            Cancel
          </Button>
          <Button variant="primary" size="lg" onClick={onApprove} loading={deciding === "approve"} disabled={busy && deciding !== "approve"} className="sm:min-w-28">
            Approve
          </Button>
        </div>

        {host && (
          <p className="m-0 text-center text-caption text-text-muted">
            You&apos;ll be sent back to <span className="font-mono text-text-secondary [overflow-wrap:anywhere]">{host}</span>.
          </p>
        )}
      </div>
    </Card>
  );
}
