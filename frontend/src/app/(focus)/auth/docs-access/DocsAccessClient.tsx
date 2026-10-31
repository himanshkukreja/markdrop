"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, MarkdropLoader, VisuallyHidden } from "@/components/ui";
import { FocusState } from "@/components/auth/FocusState";
import { useAuth } from "@/contexts/AuthContext";
import { API_BASE, getToken } from "@/lib/api";

/**
 * Sign a reader in to a members-only guide (Markdrop Guides).
 *
 * The site's sign-in page (served by the docs edge on the site's own address) links here with the
 * site, its address, the page to land on and the hash of a random state the edge keeps in a cookie.
 * This page runs on markdrop.in, where the reader's session lives: it asks the API for a grant
 * (POST /api/v1/docs-access/grant), which the API gives only when the reader's Guides role on
 * the site is viewer or more. The grant comes back as the address to go to: the site's
 * /_access/callback with the grant in the URL fragment (never sent to a server, never logged),
 * where the edge checks it — that site, that address, that browser, two minutes — and sets its own
 * session cookie. The grant carries no identity: the site never learns who signed in.
 *
 * Everything in this page's address is attacker-supplied (it is reachable by any link), so the only
 * place it ever sends the reader is the address the API returns, which the API builds from the
 * site's own hosts; never the `host` parameter itself.
 */
const HOST_RE = /^[a-z0-9.-]+(?::\d{1,5})?$/;
const SITE_RE = /^[a-f0-9]{24}$/;
const SH_RE = /^[A-Za-z0-9_-]{43}$/;

type Failure = { kind: "invalid" } | { kind: "denied"; site: string } | { kind: "gone" } | { kind: "error" };

export function DocsAccessFallback() {
  return (
    <div className="flex flex-1 items-center justify-center py-10">
      <VisuallyHidden as="h1">Signing in</VisuallyHidden>
      <MarkdropLoader label="Signing in…" />
    </div>
  );
}

export default function DocsAccessClient() {
  const params = useSearchParams();
  const { user, loading, logout } = useAuth();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const started = useRef(false);

  const site = params.get("site") || "";
  const host = (params.get("host") || "").trim().toLowerCase();
  const next = params.get("next") || "/";
  const sh = params.get("sh") || "";
  const here = `/auth/docs-access?${new URLSearchParams({ site, host, next, sh })}`;
  const loginUrl = `/login?next=${encodeURIComponent(here)}`;

  const toLogin = useCallback(() => {
    setLeaving("Taking you to sign in…");
    window.location.replace(loginUrl);
  }, [loginUrl]);

  useEffect(() => {
    if (started.current || loading) return;
    started.current = true;
    const nextOk = next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\");
    if (!SITE_RE.test(site) || !HOST_RE.test(host) || !SH_RE.test(sh) || !nextOk) {
      setFailure({ kind: "invalid" });
      return;
    }
    const token = getToken();
    if (!token) {
      toLogin();
      return;
    }
    (async () => {
      let res: Response;
      try {
        res = await fetch(`${API_BASE}/api/v1/docs-access/grant`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ site_id: site, host, next, sh }),
        });
      } catch {
        setFailure({ kind: "error" });
        return;
      }
      if (res.status === 401) return toLogin();
      const body = (await res.json().catch(() => null)) as { url?: string; detail?: { site_name?: string } | string } | null;
      if (res.ok && body?.url) {
        setLeaving(`Opening ${host}…`);
        window.location.replace(body.url);
        return;
      }
      if (res.status === 403) {
        const name = typeof body?.detail === "object" && body.detail?.site_name ? body.detail.site_name : host;
        setFailure({ kind: "denied", site: name });
      } else if (res.status === 404 || res.status === 409 || res.status === 400) setFailure({ kind: "gone" });
      else setFailure({ kind: "error" });
    })();
  }, [loading, site, host, next, sh, toLogin]);

  async function switchAccount() {
    setLeaving("Signing out…");
    try {
      await logout();
    } finally {
      window.location.replace(loginUrl);
    }
  }

  if (failure && !leaving) {
    const home = <Button href="/dashboard" variant="secondary" size="lg">Go to your documents</Button>;
    if (failure.kind === "denied") {
      return (
        <div className="flex flex-1 items-center justify-center px-4 py-10">
          <FocusState
            icon="lock"
            title={<>You don&apos;t have access to <span className="break-words">{failure.site}</span></>}
            description={
              <>
                {user?.email ? <>You&apos;re signed in as <span className="break-words">{user.email}</span>. </> : null}
                This guide is for the team that publishes it. Ask one of its admins to give you access,
                or sign in with the account they invited.
              </>
            }
            actions={
              <>
                <Button variant="primary" size="lg" onClick={() => void switchAccount()}>Use another account</Button>
                {home}
              </>
            }
          />
        </div>
      );
    }
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <FocusState
          icon={failure.kind === "error" ? "alert" : "link"}
          title={failure.kind === "error" ? "Couldn't sign you in" : "That link isn't valid"}
          description={
            failure.kind === "error"
              ? "Something went wrong on our side. Go back to the guide and choose Sign in again."
              : "The guide may have changed who can read it, or the link is incomplete. Go back to the guide and choose Sign in again."
          }
          actions={home}
        />
      </div>
    );
  }

  const label = leaving || "Signing in…";
  return (
    <div className="flex flex-1 items-center justify-center py-10">
      <VisuallyHidden as="h1">{label}</VisuallyHidden>
      <MarkdropLoader label={label} />
    </div>
  );
}
