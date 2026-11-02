"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Anchor } from "@/components/ui";
import { SignInForm } from "@/components/auth/SignInForm";
import { studioPathOf } from "@/lib/studioHost";
import s from "./login.module.css";

/** `next` must be a path on this site (open-redirect guard). */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard";
}

const HANDOFF = "/auth/handoff?";

/** When sign-in was started by a workspace's own domain (`signInUrlFor` → handoff), name that host. */
function tenantHostOf(next: string): string | null {
  if (!next.startsWith(HANDOFF)) return null;
  const host = new URLSearchParams(next.slice(HANDOFF.length)).get("host")?.trim().toLowerCase() ?? "";
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
}

/**
 * Signing in for Markdrop Guides: the studio host's hand-off (`/auth/handoff?studio=1…`, see
 * lib/studioSession), or a studio route on hosts that keep the studio under /guides (localhost,
 * previews). The studio host itself never serves /login (lib/studioHost studioRouting).
 */
function isGuidesNext(next: string): boolean {
  if (next.startsWith(HANDOFF)) return new URLSearchParams(next.slice(HANDOFF.length)).get("studio") === "1";
  return studioPathOf(next) !== null;
}

/** The mark, drawn as MarkdropMark, with a drop that falls into the dot once (login.module.css). */
function LoginMark() {
  return (
    <svg width={44} height={44} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={s.mark}>
      <rect width="32" height="32" rx="8" style={{ fill: "var(--logo-ground)" }} />
      <rect className={s.edge} x=".5" y=".5" width="31" height="31" rx="7.5" fill="none" strokeWidth=".75" />
      <text x="3" y="23" fontSize="18" fontWeight="700" style={{ fontFamily: "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace", fill: "var(--logo-ink)" }}>m</text>
      <circle className={s.ring} cx="27" cy="20" r="4" fill="none" strokeWidth="1.25" style={{ stroke: "var(--logo-drop)" }} />
      <circle className={s.dot} cx="27" cy="20" r="4" style={{ fill: "var(--logo-dot)" }} />
      <path className={s.drop} d="M27 3.2c0 0 3 4.1 3 5.8a3 3 0 0 1-6 0c0-1.7 3-5.8 3-5.8z" style={{ fill: "var(--logo-drop)" }} />
    </svg>
  );
}

/** Sign-in and sign-up are one flow (an email code or Google creates the account on first use). */
export default function LoginClient() {
  const params = useSearchParams();
  const router = useRouter();
  const next = safeNext(params.get("next"));
  const urlError = params.get("error");
  const tenantHost = tenantHostOf(next);
  const guides = isGuidesNext(next);

  return (
    <div className={s.page}>
      <div aria-hidden="true" className={s.mat} />
      <section aria-label="Sign in" className={s.card}>
        <SignInForm
          variant="page"
          next={next}
          urlError={urlError}
          mark={<LoginMark />}
          title={guides ? "Sign in to Markdrop Guides" : "Sign in to Markdrop"}
          message={tenantHost ? (
            <>Sign in to read <strong className="ph-sensitive ph-mask font-semibold text-text break-words">{tenantHost}</strong>. You&apos;ll go straight back to it.</>
          ) : guides
            ? "Write, publish and improve your docs."
            : "One account for your documents, files, Guides and sharing."}
          footer={<p className={`${s.footer} text-caption text-text-muted`}>New here? The same steps create your account.</p>}
          onSignedIn={() => router.push(next)}
        />
      </section>
      <p className={`${s.below} text-caption text-text-muted`}>
        <Anchor href="/privacy" className="md-focus inline-flex min-h-6 items-center rounded-sm text-text-muted no-underline hover:text-text">
          Privacy
        </Anchor>
      </p>
    </div>
  );
}
