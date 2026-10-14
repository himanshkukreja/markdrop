"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Avatar, Button, Card, Icon, MarkdropLoader, cx } from "@/components/ui";
import { BrandTile } from "@/components/workspace/BrandTile";
import { useAuth } from "@/contexts/AuthContext";
import { acceptInvite, declineInvite, previewInvite, type InvitePreview } from "@/lib/workspaces";
import styles from "./invite.module.css";

/** The preview as the API now returns it (D27): the brand tile fields are newer than lib's type. */
type Preview = InvitePreview & { logo_url?: string | null; accent_color?: string | null; logo_well?: string | null };

const ROLE_BLURB: Record<string, string> = {
  admin: "manage members, domains and branding",
  member: "create and publish documents",
  viewer: "read what the workspace publishes",
  owner: "do anything in the workspace",
};

const TERMINAL: Record<string, { title: string; body: string; icon: string }> = {
  accepted: { title: "Already accepted", body: "This invitation has already been used.", icon: "checkCircle" },
  declined: { title: "Already declined", body: "This invitation was declined. Ask for a new one if that was a mistake.", icon: "x" },
  revoked: { title: "Invitation withdrawn", body: "An admin cancelled this invitation.", icon: "minus" },
  expired: { title: "Invitation expired", body: "Invitations are valid for 7 days. Ask whoever invited you to send a new one.", icon: "clock" },
};

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** A centred 440px card (REVAMP_PLAN 7.13), full-width buttons on phones. */
function Shell({ children, busy }: { children: React.ReactNode; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<number | null>(null);
  // FLIP the card's height between states (220ms), so "You're in" grows out of the live card.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.getBoundingClientRect().height;
    const prev = last.current;
    last.current = h;
    if (prev === null || Math.abs(prev - h) < 1 || reducedMotion() || !el.animate) return;
    el.animate([{ height: `${prev}px` }, { height: `${h}px` }], { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
  });
  return (
    <div className="flex flex-1 items-start justify-center pt-2 sm:items-center sm:pt-0">
      <div ref={ref} className="w-full max-w-[440px] overflow-hidden" aria-busy={busy || undefined}>
        <Card className="w-full">
          <div className="flex flex-col items-center gap-3 text-center">{children}</div>
        </Card>
      </div>
    </div>
  );
}

/** The state glyph: an icon on a tinted tile. Changing `icon` crossfades with a small scale. */
function Glyph({ icon, tone = "accent" }: { icon: string; tone?: "accent" | "success" | "warning" | "neutral" }) {
  const tones = {
    accent: "bg-accent-soft text-accent-text",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning",
    neutral: "bg-surface-inset text-text-muted",
  };
  return (
    <span className={cx("grid size-12 place-items-center rounded-xl", tones[tone])} aria-hidden>
      <Icon key={icon} name={icon} size={24} className={styles.glyph} />
    </span>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return <h1 className="text-h3 text-text [overflow-wrap:anywhere]">{children}</h1>;
}

function Body({ children }: { children: React.ReactNode }) {
  return <p className="text-body text-text-secondary">{children}</p>;
}

/** /invite/[token]: live, signed out, wrong account, already a member, terminal and loading states. */
export default function InviteClient({ token }: { token: string }) {
  const { user, loading: authLoading, logout } = useAuth();
  const router = useRouter();

  const [invite, setInvite] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"accept" | "decline" | "switch" | null>(null);
  const [actionError, setActionError] = useState("");
  const [done, setDone] = useState<"accepted" | "declined" | null>(null);
  const [joined, setJoined] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setInvite(await previewInvite(token));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "This invitation link isn't valid.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Waits for auth to settle before asking: the preview tells us whether the signed-in address
  // matches, and asking too early would always say "no".
  useEffect(() => {
    if (authLoading) return;
    load();
  }, [authLoading, load]);

  const next = `/invite/${encodeURIComponent(token)}`;

  async function decline() {
    setBusy("decline");
    setActionError("");
    try {
      await declineInvite(token);
      setDone("declined");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Couldn't decline. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function accept() {
    setBusy("accept");
    setActionError("");
    try {
      const r = await acceptInvite(token);
      setJoined({ id: r.workspace_id, name: r.workspace_name });
      setDone("accepted");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Couldn't accept. Try again.");
      load(); // the reason is usually a state change: show the new one
    } finally {
      setBusy(null);
    }
  }

  if (authLoading || loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <MarkdropLoader label="Checking invitation…" />
      </div>
    );
  }

  if (loadError || !invite) {
    return (
      <Shell>
        <Glyph icon="link" tone="neutral" />
        <Title>This link doesn&apos;t work</Title>
        <Body>{loadError || "This invitation link isn't valid."} Ask whoever invited you to send it again.</Body>
        <Button variant="secondary" href="/" block className="mt-2">Go to Markdrop</Button>
      </Shell>
    );
  }

  // ── Terminal states ────────────────────────────────────────────────────

  if (done === "accepted" && joined) {
    return (
      <Shell>
        <Glyph icon="check" tone="success" />
        <Title>You&apos;re in</Title>
        <Body>
          You joined <strong className="font-semibold text-text">{joined.name}</strong> as {invite.role === "admin" ? "an admin" : `a ${invite.role}`}.
        </Body>
        <div role="status" className="md-visually-hidden">You joined {joined.name}.</div>
        <Button variant="primary" block iconLeft="folder" className="mt-2" href={`/dashboard?ws=${encodeURIComponent(joined.id)}`}>
          Open library
        </Button>
      </Shell>
    );
  }

  if (done === "declined") {
    return (
      <Shell>
        <Glyph icon="x" tone="neutral" />
        <Title>Invitation declined</Title>
        <Body>You haven&apos;t been added to {invite.workspace_name}, and nothing was shared with you.</Body>
        <div role="status" className="md-visually-hidden">Invitation declined.</div>
        <Button variant="secondary" href="/" block className="mt-2">Go to Markdrop</Button>
      </Shell>
    );
  }

  if (invite.status !== "pending") {
    const c = TERMINAL[invite.status] ?? { title: "Nothing to do here", body: "This invitation is no longer open.", icon: "info" };
    return (
      <Shell>
        <Glyph icon={c.icon} tone={invite.status === "accepted" ? "success" : invite.status === "expired" ? "warning" : "neutral"} />
        <p className="text-eyebrow uppercase text-text-muted">{invite.workspace_name}</p>
        <Title>{c.title}</Title>
        <Body>{c.body}</Body>
        <Button variant="secondary" href={invite.status === "accepted" && user ? "/settings/workspaces" : "/"} block className="mt-2">
          {invite.status === "accepted" && user ? "Open workspaces" : "Go to Markdrop"}
        </Button>
      </Shell>
    );
  }

  // Already a member: accepting would be a no-op, so don't offer it.
  if (invite.already_member) {
    return (
      <Shell>
        <Glyph icon="check" tone="success" />
        <Title>You&apos;re already in {invite.workspace_name}</Title>
        <Body>Nothing to accept. You already have access.</Body>
        <Button variant="primary" href="/settings/workspaces" block className="mt-2">Open workspaces</Button>
      </Shell>
    );
  }

  // ── The live invitation ────────────────────────────────────────────────

  const tile = invite.logo_url || invite.accent_color ? (
    <BrandTile
      name={invite.workspace_name}
      logoUrl={invite.logo_url}
      logoWell={invite.logo_well}
      accent={invite.accent_color}
      size={48}
    />
  ) : (
    <Glyph icon="userPlus" />
  );

  const header = (
    <>
      {tile}
      <p className="text-eyebrow uppercase text-text-muted">Workspace invitation</p>
      <Title>
        {invite.invited_by_name ? `${invite.invited_by_name} invited you to ` : "You're invited to "}
        <span className="text-accent-text">{invite.workspace_name}</span>
      </Title>
      <Body>
        As {invite.role === "admin" ? "an" : "a"} <strong className="font-semibold text-text">{invite.role}</strong>, you&apos;ll be able to{" "}
        {ROLE_BLURB[invite.role] ?? "collaborate"}.
      </Body>
    </>
  );

  const errorLine = actionError ? <Alert tone="danger" className="w-full text-left">{actionError}</Alert> : null;

  // Not signed in. Login with `next` brings them back here afterwards, so the invitation survives
  // the detour — including for someone who has to create an account on the way.
  if (!user) {
    return (
      <Shell busy={!!busy}>
        {header}
        <Alert tone="info" className="mt-1 w-full text-left">
          Sign in as <strong className="font-semibold">{invite.email}</strong> to accept. No account? Signing in creates one.
        </Alert>
        {errorLine}
        <div className="mt-1 flex w-full flex-col gap-2">
          <Button variant="primary" block href={`/login?next=${encodeURIComponent(next)}`}>Sign in to continue</Button>
          <Button variant="ghost" block loading={busy === "decline"} disabled={!!busy} onClick={decline}>Decline</Button>
        </div>
      </Shell>
    );
  }

  // Signed in as the wrong person. Naming both addresses turns a dead end into an obvious fix, and
  // the token holder was already told the invited address by the email that carried this link.
  if (!invite.email_matches) {
    return (
      <Shell busy={!!busy}>
        {header}
        <Alert tone="warning" className="mt-1 w-full text-left">
          This invitation was sent to <strong className="font-semibold">{invite.email}</strong>, but you&apos;re signed in as{" "}
          <strong className="font-semibold">{invite.signed_in_as ?? user.email}</strong>.
        </Alert>
        <div className="mt-1 flex w-full flex-col gap-2">
          <Button
            variant="primary"
            block
            loading={busy === "switch"}
            onClick={async () => {
              // Signs out first, then sign-in comes back here; the address is passed along for prefill.
              setBusy("switch");
              try { await logout(); } finally {
                router.push(`/login?next=${encodeURIComponent(next)}&email=${encodeURIComponent(invite.email)}`);
              }
            }}
          >
            <span className="truncate">Sign in as {invite.email}</span>
          </Button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell busy={!!busy}>
      {header}
      <p className="mt-1 flex w-full min-w-0 items-center justify-center gap-2 rounded-lg bg-surface-inset px-3 py-2 text-caption text-text-secondary">
        <Avatar name={user.name || user.email} size="sm" />
        <span className="min-w-0 truncate">Accepting as <strong className="font-semibold text-text">{invite.signed_in_as ?? user.email}</strong></span>
      </p>
      {errorLine}
      <div className="mt-1 flex w-full flex-col-reverse gap-2 sm:flex-row">
        <Button variant="secondary" className="sm:flex-1" block loading={busy === "decline"} disabled={!!busy} onClick={decline}>Decline</Button>
        <Button variant="primary" className="sm:flex-1" block loading={busy === "accept"} disabled={!!busy} onClick={accept}>Accept invitation</Button>
      </div>
    </Shell>
  );
}
