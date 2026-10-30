"use client";

import { useState } from "react";
import { Button, Dropdown, Skeleton, cx, type MenuEntry } from "@/components/ui";
import { ThemeSegmented } from "@/components/theme/ThemeSegmented";
import { FeedbackDialog, openFeedback } from "@/components/FeedbackWidget";
import { useAuth } from "@/contexts/AuthContext";
import { getToken, type MeUser } from "@/lib/api";
import { LIGHT_ENABLED } from "@/lib/theme";
import { DOCS_URL } from "./links";
import { useMounted, useSignInHref } from "./useLocation";

/** Initials for the avatar: two words → two letters, else the first letter of the name or email. */
export function initialsOf(user: Pick<MeUser, "name" | "email">): string {
  const words = (user.name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0]?.[0] || user.email.charAt(0) || "?").toUpperCase();
}

/**
 * The signed-in user's avatar, on the DS avatar classes. A profile picture (Google) loads with
 * `referrerPolicy="no-referrer"`, which googleusercontent needs; otherwise initials on the accent.
 */
export function UserAvatar({ user, size = "md", className }: { user: MeUser; size?: "sm" | "md" | "lg" | "xl"; className?: string }) {
  return (
    <span className={cx("md-avatar", `md-avatar--${size}`, className)} aria-hidden>
      {user.picture ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={user.picture} alt="" referrerPolicy="no-referrer" />
      ) : (
        initialsOf(user)
      )}
    </span>
  );
}

/**
 * Account menu (REVAMP_PLAN 4.2): an avatar trigger → WAI-ARIA menu with the identity header,
 * Dashboard, Workspaces & domains, API tokens, Connected apps, Account settings, a Theme row (System / Light /
 * Dark), Send feedback, and Sign out (neutral: signing out isn't destructive). Sign-out uses
 * AuthContext.logout() (server revoke, then the local token is cleared).
 */
export function AccountMenu({ user, align = "right" }: { user: MeUser; align?: "left" | "right" }) {
  const { logout } = useAuth();
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const items: MenuEntry[] = [
    {
      header: (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-body-strong text-text">{user.name || "Signed in"}</span>
          <span className="truncate text-caption text-text-muted">{user.email}</span>
        </span>
      ),
    },
    { label: "Dashboard", href: "/dashboard", icon: "home", separated: true },
    { label: "Workspaces & domains", href: "/settings/workspaces", icon: "users" },
    { label: "API tokens", href: "/settings/tokens", icon: "key" },
    { label: "Connected apps", href: "/settings/connections", icon: "sparkle" },
    { label: "Account settings", href: "/settings/account", icon: "settings" },
    { label: "Docs", href: DOCS_URL, icon: "doc" },
    ...(LIGHT_ENABLED
      ? [{
          custom: (
            <div className="flex items-center justify-between gap-3">
              <span className="text-body text-text-secondary" aria-hidden>Theme</span>
              <ThemeSegmented size="sm" iconOnly label="Theme" />
            </div>
          ),
          separated: true,
        }]
      : []),
    {
      label: "Send feedback",
      icon: "message",
      separated: !LIGHT_ENABLED,
      onClick: () => {
        if (!openFeedback()) setFeedbackOpen(true);
      },
    },
    { label: "Sign out", icon: "logOut", separated: true, onClick: () => void logout() },
  ];

  return (
    <>
      <Dropdown
        align={align}
        minWidth={264}
        aria-label="Account"
        trigger={
          <button
            type="button"
            className="md-focus grid size-9 shrink-0 cursor-pointer place-items-center rounded-full max-md:size-11"
            aria-label={`Account menu for ${user.name || user.email}`}
            title={user.email}
          >
            <UserAvatar user={user} />
          </button>
        }
        items={items}
      />
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </>
  );
}

/**
 * The header's auth slot. The server (and the first client render) emits a "Sign in" link so
 * signed-out visitors and no-JS readers get a working control and static pages stay static; it is
 * kept invisible under JS until the client knows (no flash). Then: a token but no user yet → a
 * 32px skeleton circle; a user → AccountMenu; otherwise the "Sign in" link (ghost) to
 * /login?next=<this page>.
 */
export function HeaderAuthSlot({ className, signInClassName }: { className?: string; signInClassName?: string }) {
  const { user, loading } = useAuth();
  const mounted = useMounted();
  const signInHref = useSignInHref();

  if (user) return <div className={className}><AccountMenu user={user} /></div>;

  if (mounted && loading && getToken()) {
    return (
      <div className={cx("grid size-9 place-items-center max-md:size-11", className)} role="status" aria-label="Checking your account">
        <Skeleton variant="circle" height={32} />
      </div>
    );
  }

  return (
    <div className={className}>
      <Button
        variant="ghost"
        href={signInHref}
        className={cx(!mounted && "[.js_&]:invisible", "max-md:h-11", signInClassName)}
      >
        Sign in
      </Button>
    </div>
  );
}

export default AccountMenu;
