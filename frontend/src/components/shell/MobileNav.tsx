"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Anchor, Button, Drawer, Icon, IconButton, MarkdropMark, VisuallyHidden, Wordmark, cx } from "@/components/ui";
import { ThemeSegmented } from "@/components/theme/ThemeSegmented";
import { openFeedback, FeedbackDialog } from "@/components/FeedbackWidget";
import { useAuth } from "@/contexts/AuthContext";
import { LIGHT_ENABLED } from "@/lib/theme";
import { UserAvatar } from "./AccountMenu";
import { useSignInHref } from "./useLocation";
import { NAV_LINKS } from "./links";

/**
 * The phone/tablet menu (REVAMP_PLAN 4.6, MobileLanding "menu open"): an IconButton "Menu" that
 * opens a full-width Drawer from the right with the nav links, Sign in (signed out) or the account
 * links (signed in), Send feedback and the theme SegmentedControl. The DS Drawer traps focus,
 * closes on Escape and returns focus to the Menu button. It closes itself on navigation.
 */
export function MobileNav({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const signInHref = useSignInHref();

  useEffect(() => setOpen(false), [pathname]);

  const close = () => setOpen(false);
  const row =
    "md-focus flex min-h-14 items-center justify-between gap-3 border-b border-border text-h4 text-text no-underline hover:text-accent-text";

  return (
    <>
      <IconButton icon="menu" label="Menu" className={cx("max-md:size-11", className)} onClick={() => setOpen(true)} aria-expanded={open} aria-haspopup="dialog" />
      <Drawer
        open={open}
        onClose={close}
        side="right"
        width={420}
        title={
          <span className="flex items-center gap-2">
            <VisuallyHidden>Menu</VisuallyHidden>
            <span className="flex items-center gap-2" aria-hidden>
              <MarkdropMark size={24} />
              <Wordmark style={{ fontSize: 18 }} />
            </span>
          </span>
        }
        bodyClassName="flex flex-col"
        footer={
          <div className="flex w-full items-center justify-between gap-3 text-caption text-text-muted">
            <span>© Markdrop · MIT licensed</span>
            <span className="inline-flex items-center gap-1"><Icon name="globe" size={14} /> markdrop.in</span>
          </div>
        }
      >
        <nav aria-label="Site" className="flex flex-col">
          {NAV_LINKS.map((l) => (
            <Anchor key={l.href} href={l.href} className={row} onClick={close}
              {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
              <span>{l.label}</span>
              <Icon name={l.external ? "external" : "chevronRight"} size={18} className="text-text-muted" />
              {l.external && <VisuallyHidden> (opens in a new tab)</VisuallyHidden>}
            </Anchor>
          ))}
          {user && (
            <>
              <Anchor href="/dashboard" className={row} onClick={close}>
                <span>Dashboard</span>
                <Icon name="chevronRight" size={18} className="text-text-muted" />
              </Anchor>
              <Anchor href="/dashboard/analytics" className={row} onClick={close}>
                <span>Analytics</span>
                <Icon name="chevronRight" size={18} className="text-text-muted" />
              </Anchor>
              <Anchor href="/settings/account" className={row} onClick={close}>
                <span>Account settings</span>
                <Icon name="chevronRight" size={18} className="text-text-muted" />
              </Anchor>
            </>
          )}
          <button
            type="button"
            className={cx(row, "w-full cursor-pointer bg-transparent text-left")}
            onClick={() => {
              close();
              if (!openFeedback()) setFeedbackOpen(true);
            }}
          >
            <span>Send feedback</span>
            <Icon name="message" size={18} className="text-text-muted" />
          </button>
        </nav>

        <div className="mt-6 flex flex-col gap-2">
          {user ? (
            <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-raised p-3">
              <UserAvatar user={user} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body-strong text-text">{user.name || "Signed in"}</span>
                <span className="truncate text-caption text-text-muted">{user.email}</span>
              </span>
              <Button variant="secondary" className="h-11" onClick={() => { close(); void logout(); }}>Sign out</Button>
            </div>
          ) : (
            <>
              <Button variant="secondary" size="lg" block iconLeft="user" href={signInHref} onClick={close}>Sign in</Button>
              <p className="flex items-center justify-center gap-1.5 text-caption text-text-muted">
                <Icon name="check" size={14} className="text-success" /> Markdown never needs an account
              </p>
            </>
          )}
        </div>

        {LIGHT_ENABLED && (
          <div className="mt-6 flex flex-col gap-2">
            <span className="text-eyebrow uppercase text-text-muted" id="md-mobilenav-theme">Theme</span>
            <ThemeSegmented block label="Theme" className="w-full [&_.md-seg__opt]:h-11" />
          </div>
        )}
      </Drawer>
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </>
  );
}

export default MobileNav;
