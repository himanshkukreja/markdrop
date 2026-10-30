"use client";
/**
 * SignInForm (REVAMP_PLAN 7.14): the one sign-in form, used by /login (`variant="page"`) and by the
 * auth Dialog (`AuthModal`, `variant="dialog"`).
 *
 * Two steps that slide (220ms, 16px; nothing moves under reduced motion):
 *   1. email: "Continue with Google" (full OAuth redirect carrying `next`), or "Email me a code".
 *   2. code: six OtpInput boxes, auto-submit on the sixth digit, "Resend code" after 30s,
 *      "Use a different email". A wrong code shakes the boxes once and names the fix.
 *
 * The email endpoints are called here (same paths and bodies as `emailRequestLogin` /
 * `emailVerifyOtp` in lib/api) because the form needs the HTTP status and `Retry-After` to tell
 * a wrong code from a rate limit (§7.22) from an outage, which the lib helpers don't expose.
 * Signing in goes through `AuthContext.login()` (which records `track("logged_in")`).
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Field, Icon, Input, MarkdropLogo, Spinner, announce } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { OtpInput, type OtpInputHandle } from "@/components/kit/OtpInput";
import { API_BASE, googleLoginUrl, type MeUser } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

/* ── Copy ─────────────────────────────────────────────────────────────── */

export const SIGN_IN_TITLE = "Sign in to Markdrop";
/** Board copy (Auth.dc.html): honest about artifacts, which do need an account. */
export const SIGN_IN_BODY =
  "Writing a document never needs an account. Sign in to upload files, keep what you publish together and see who reads it.";
const FOOTNOTE = "No password. We email you a code each time, and your first sign-in creates the account.";
const RESEND_AFTER = 30;
const CODE_LENGTH = 6;

/** Errors the API sends back to /login as `?error=` (backend/app/routers/auth.py). Each names the fix. */
export const URL_ERRORS: Record<string, { title: string; body: string }> = {
  oauth_cancelled: { title: "Google sign-in was cancelled", body: "Choose Continue with Google to try again, or use your email instead." },
  oauth_state: { title: "That sign-in took too long", body: "Start again with Google or your email. It only takes a moment." },
  oauth_failed: { title: "Google couldn't sign you in", body: "Try Continue with Google again, or use your email instead." },
  email_unverified: { title: "Your Google email isn't verified", body: "Verify the address with Google first, or sign in with your email here." },
  link_invalid: { title: "That sign-in link has expired", body: "Links work once and only for a short time. Enter your email to get a new one." },
};
const URL_ERROR_FALLBACK = { title: "Sign-in didn't finish", body: "Try again with Google or your email." };

/* ── API (see the note at the top) ────────────────────────────────────── */

type Failure =
  | { kind: "rate"; retryAfter: number | null }
  | { kind: "bad-code" }
  | { kind: "invalid-email" }
  | { kind: "unavailable" }
  | { kind: "send-failed" }
  | { kind: "offline" };

class SignInError extends Error {
  constructor(public failure: Failure) { super(failure.kind); }
}

function retryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get("Retry-After");
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.min(Math.ceil(n), 3600);
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) { const s = Math.ceil((at - Date.now()) / 1000); return s > 0 ? Math.min(s, 3600) : null; }
  return null;
}

async function post(path: string, body: unknown): Promise<Response> {
  try {
    return await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SignInError({ kind: "offline" });
  }
}

async function requestCode(email: string): Promise<void> {
  const res = await post("/api/v1/auth/email/request", { email });
  if (res.ok) return;
  if (res.status === 429) throw new SignInError({ kind: "rate", retryAfter: retryAfterSeconds(res) });
  if (res.status === 422 || res.status === 400) throw new SignInError({ kind: "invalid-email" });
  if (res.status === 503) throw new SignInError({ kind: "unavailable" });
  if (res.status === 502) throw new SignInError({ kind: "send-failed" });
  throw new SignInError({ kind: "offline" });
}

async function verifyCode(email: string, code: string): Promise<{ token: string; user: MeUser }> {
  const res = await post("/api/v1/auth/email/verify", { email, code });
  if (res.ok) return res.json();
  if (res.status === 429) throw new SignInError({ kind: "rate", retryAfter: retryAfterSeconds(res) });
  if (res.status === 401 || res.status === 400 || res.status === 422) throw new SignInError({ kind: "bad-code" });
  throw new SignInError({ kind: "offline" });
}

function failureOf(err: unknown): Failure {
  return err instanceof SignInError ? err.failure : { kind: "offline" };
}

/* ── Small pieces ─────────────────────────────────────────────────────── */

/** Seconds left until `until` (ms epoch), re-rendering once a second while it runs; 0 when past or null. */
function useSecondsLeft(until: number | null): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => {
      tick((n) => n + 1);
      if (Date.now() >= until) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [until]);
  // Computed on every render, so it is right on the very render that sets `until`.
  return until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Google's four-colour G. The fills are Google's brand colours (a third-party logo: documented hex exception). */
export function GoogleG({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
      <path fill="#EA4335" d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.44 14.97.5 12 .5A11 11 0 0 0 2.18 7.06L5.84 9.9C6.71 7.3 9.14 4.75 12 4.75z" />
    </svg>
  );
}

/** The envelope with the code card (Auth.dc.html panel 2). Static and decorative. */
function Envelope() {
  return (
    <svg width="132" height="92" viewBox="0 0 132 92" aria-hidden="true" focusable="false" className="overflow-visible">
      <rect x="14" y="30" width="104" height="60" rx="10" style={{ fill: "var(--surface-inset)", stroke: "var(--border-strong)", strokeWidth: 1.5 }} />
      <rect x="26" y="4" width="80" height="58" rx="8" style={{ fill: "var(--surface-raised)", stroke: "var(--border)", strokeWidth: 1.5 }} />
      <rect x="36" y="14" width="30" height="5" rx="2.5" style={{ fill: "var(--border-strong)" }} />
      <text x="66" y="40" textAnchor="middle" style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700, letterSpacing: 1.5, fill: "var(--accent-text)" }}>482 917</text>
      <path d="M14 44 L66 70 L118 44 L118 80 Q118 90 108 90 L24 90 Q14 90 14 80 Z" style={{ fill: "var(--surface)", stroke: "var(--border-strong)", strokeWidth: 1.5, strokeLinejoin: "round" }} />
      <path d="M14 88 L56 62 M118 88 L76 62" style={{ fill: "none", stroke: "var(--border)", strokeWidth: 1.5, strokeLinecap: "round" }} />
    </svg>
  );
}

function FailureAlert({ failure, secondsLeft }: { failure: Failure; secondsLeft: number }) {
  switch (failure.kind) {
    case "rate":
      return (
        <Alert tone="warning" title="Too many tries in a short time">
          {failure.retryAfter && secondsLeft > 0
            ? <>Wait <span className="tabular-nums">{secondsLeft}</span> {secondsLeft === 1 ? "second" : "seconds"} and try again.</>
            : "Wait a minute and try again."}
        </Alert>
      );
    case "bad-code":
      return <Alert tone="danger">That code didn&apos;t work. Check the latest email, or resend.</Alert>;
    case "invalid-email":
      return <Alert tone="danger" title="Check the email address">Enter a full address, like you@example.com.</Alert>;
    case "unavailable":
      return <Alert tone="danger" title="Email sign-in isn't available right now">Continue with Google instead, or try again later.</Alert>;
    case "send-failed":
      return <Alert tone="danger" title="We couldn't send the email">Check the address for typos and try again.</Alert>;
    case "offline":
    default:
      return (
        <Alert tone="danger" title="Can't reach Markdrop right now">
          Check your connection. If it&apos;s working, we&apos;re having trouble — try again in a minute.
        </Alert>
      );
  }
}

/* ── The form ─────────────────────────────────────────────────────────── */

export interface SignInFormProps {
  /** Where Google OAuth returns to (and where /login goes after a code sign-in). Must start with "/". */
  next: string;
  /** Called after an email-code sign-in has completed (the session is stored). */
  onSignedIn?: (user: MeUser) => void;
  /** "page" draws the logo and its own headings (h1); "dialog" leaves the title to the Dialog. */
  variant?: "page" | "dialog";
  /** Page variant only: replaces the default title. */
  title?: string;
  /**
   * Page variant: replaces the default body line (e.g. "Sign in to read docs.example.com.").
   * Dialog variant: the Dialog shows it as its description, so its presence only drops the default body.
   */
  message?: React.ReactNode;
  /** `?error=` from the API's OAuth / magic-link redirects. */
  urlError?: string | null;
  /** Reports whether a request is in flight (the dialog blocks dismissal while busy). */
  onBusyChange?: (busy: boolean) => void;
  /** Reports the current step (the dialog uses it for its title). */
  onStepChange?: (step: "email" | "code") => void;
  className?: string;
}

export function SignInForm({
  next, onSignedIn, variant = "page", title = SIGN_IN_TITLE, message, urlError, onBusyChange, onStepChange, className,
}: SignInFormProps) {
  const { login } = useAuth();
  const safeNextPath = next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  const isPage = variant === "page";
  const Heading = (isPage ? "h1" : "h3") as "h1" | "h3";
  const uid = useId();
  const emailId = `${uid}-email`;

  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"send" | "verify" | "resend" | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [errorKey, setErrorKey] = useState(0);
  const [showUrlError, setShowUrlError] = useState(true);
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const [resent, setResent] = useState(false);

  const blockedLeft = useSecondsLeft(blockedUntil);
  const resendLeft = useSecondsLeft(resendAt);
  const blocked = blockedLeft > 0;

  const emailRef = useRef<HTMLInputElement>(null);
  const otpRef = useRef<OtpInputHandle>(null);
  const stepRef = useRef<HTMLDivElement>(null);
  const firstStep = useRef(true);

  useEffect(() => { onBusyChange?.(busy !== null || googleBusy); }, [busy, googleBusy, onBusyChange]);
  useEffect(() => { onStepChange?.(step); }, [step, onStepChange]);

  // Coming back to this page from Google with the Back button (bfcache) must not leave the button stuck.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) setGoogleBusy(false); };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  // A rate-limit block that ends clears its alert.
  useEffect(() => {
    if (blockedUntil && !blocked && failure?.kind === "rate") setFailure(null);
  }, [blocked, blockedUntil, failure]);

  // Step change: slide 16px from the direction of travel (220ms, ease-out tokens), then focus.
  useLayoutEffect(() => {
    if (firstStep.current) { firstStep.current = false; return; }
    const el = stepRef.current;
    if (el && !reducedMotion() && typeof el.animate === "function") {
      const css = getComputedStyle(document.documentElement);
      const duration = parseFloat(css.getPropertyValue("--duration-panel")) || 220;
      const easing = css.getPropertyValue("--ease-out").trim() || "ease-out";
      const dx = step === "code" ? 16 : -16;
      el.animate(
        [{ opacity: 0, transform: `translateX(${dx}px) scale(.98)` }, { opacity: 1, transform: "none" }],
        { duration, easing },
      );
    }
    if (step === "code") otpRef.current?.focus(0);
    else emailRef.current?.focus();
  }, [step]);

  const block = useCallback((f: Failure) => {
    if (f.kind !== "rate") return;
    setBlockedUntil(Date.now() + (f.retryAfter ?? 60) * 1000);
    announce(f.retryAfter ? `Too many tries in a short time. Wait ${f.retryAfter} seconds and try again.` : "Too many tries in a short time. Wait a minute and try again.");
  }, []);

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    const addr = email.trim();
    if (busy || blocked) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) { setFailure({ kind: "invalid-email" }); emailRef.current?.focus(); return; }
    setBusy("send"); setFailure(null); setShowUrlError(false);
    try {
      await requestCode(addr);
      setSentTo(addr);
      setCode("");
      setResent(false);
      setResendAt(Date.now() + RESEND_AFTER * 1000);
      setStep("code");
      announce(`We emailed ${addr} a 6-digit code.`);
    } catch (err) {
      const f = failureOf(err);
      setFailure(f); block(f);
    } finally {
      setBusy(null);
    }
  }

  async function resend() {
    if (busy || resendLeft > 0 || blocked) return;
    setBusy("resend"); setFailure(null);
    try {
      await requestCode(sentTo);
      setCode("");
      otpRef.current?.clear();
      setResent(true);
      setResendAt(Date.now() + RESEND_AFTER * 1000);
      announce(`We sent a new code to ${sentTo}.`);
      otpRef.current?.focus(0);
    } catch (err) {
      const f = failureOf(err);
      setFailure(f); block(f);
    } finally {
      setBusy(null);
    }
  }

  async function verify(value: string) {
    // Six digits, always (this used to accept four).
    if (!/^\d{6}$/.test(value) || busy || blocked) return;
    setBusy("verify"); setFailure(null);
    try {
      const { token, user } = await verifyCode(sentTo, value);
      await login(token, user);
      announce("Signed in.");
      onSignedIn?.(user);
    } catch (err) {
      const f = failureOf(err);
      setFailure(f); block(f);
      if (f.kind === "bad-code") { setCode(""); setErrorKey((k) => k + 1); }
      setBusy(null);
      return;
    }
    // Success: stay "busy" (boxes disabled, "Signing you in…") while the caller navigates or closes.
  }

  function differentEmail() {
    setStep("email");
    setFailure((f) => (f?.kind === "rate" ? f : null));
    setCode("");
    setResent(false);
  }

  const urlErr = showUrlError && urlError ? (URL_ERRORS[urlError] ?? URL_ERROR_FALLBACK) : null;
  const failureSlot = failure
    ? <FailureAlert failure={failure} secondsLeft={blockedLeft} />
    : urlErr && step === "email"
      ? <Alert tone="danger" title={urlErr.title}>{urlErr.body}</Alert>
      : null;

  return (
    <div className={["min-w-0", className].filter(Boolean).join(" ")}>
      <div ref={stepRef} className="min-w-0">
        {step === "email" ? (
          <div className="flex min-w-0 flex-col gap-4">
            {isPage && (
              <>
                {/* Phones already show the logo in the minimal header (MobileAccount frame 1). */}
                <MarkdropLogo className="max-lg:hidden" />
                <div className="flex flex-col gap-1">
                  <Heading className="m-0 text-h2 text-text">{title}</Heading>
                  <p className="m-0 text-body text-text-secondary">{message ?? <>{SIGN_IN_BODY} <ReadMore topic="accounts" /></>}</p>
                </div>
              </>
            )}
            {!isPage && !message && <p className="m-0 text-body text-text-secondary">{SIGN_IN_BODY} <ReadMore topic="accounts" /></p>}

            {failureSlot}

            <div className={isPage ? "mt-1 flex flex-col gap-3" : "flex flex-col gap-3"}>
              <Button
                variant="secondary" size="lg" block
                href={googleLoginUrl(safeNextPath)}
                loading={googleBusy}
                onClick={() => setGoogleBusy(true)}
              >
                {!googleBusy && <GoogleG />}
                {googleBusy ? "Opening Google…" : "Continue with Google"}
              </Button>

              <div role="separator" aria-label="or" className="flex h-4 items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="text-caption text-text-muted" aria-hidden="true">or</span>
                <span className="h-px flex-1 bg-border" />
              </div>

              <form onSubmit={sendCode} noValidate className="flex flex-col gap-3">
                <Field label="Email" htmlFor={emailId}>
                  <Input
                    ref={emailRef} id={emailId} type="email" name="email" required
                    autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false}
                    placeholder="you@example.com" value={email}
                    invalid={failure?.kind === "invalid-email" || undefined}
                    onChange={(e) => { setEmail(e.target.value); if (failure?.kind === "invalid-email") setFailure(null); }}
                    size="md" className="min-h-11"
                  />
                </Field>
                <Button
                  type="submit" variant="primary" size="lg" block
                  loading={busy === "send"}
                  iconRight={busy === "send" ? undefined : "arrowRight"}
                  aria-disabled={blocked || undefined}
                >
                  {busy === "send" ? "Sending…" : blocked ? `Try again in ${mmss(blockedLeft)}` : "Email me a code"}
                </Button>
              </form>
            </div>

            <p className="m-0 flex items-start gap-2 text-caption text-text-muted">
              <Icon name="lock" size={14} className="mt-px flex-none" />
              <span>{FOOTNOTE}</span>
            </p>
          </div>
        ) : (
          <form
            onSubmit={(e) => { e.preventDefault(); void verify(code); }}
            className="flex min-w-0 flex-col items-center gap-5 text-center"
          >
            <Envelope />
            <div className="flex max-w-md flex-col gap-1.5">
              <Heading className={isPage ? "m-0 text-h2 text-text" : "m-0 text-h3 text-text"}>Check your email</Heading>
              <p className="m-0 text-body text-text-secondary">
                We emailed <strong className="font-semibold text-text break-words">{sentTo}</strong> a 6-digit code and a sign-in link.
                Enter the code, or open the link on this device.
              </p>
            </div>

            <OtpInput
              ref={otpRef}
              length={CODE_LENGTH}
              value={code}
              onChange={(v) => { setCode(v); if (failure?.kind === "bad-code" && v) setFailure(null); }}
              onComplete={(v) => void verify(v)}
              error={failure?.kind === "bad-code"}
              errorKey={errorKey}
              disabled={busy === "verify" || blocked}
              className="mx-auto"
            />

            {busy === "verify" && (
              <p className="m-0 flex items-center gap-2 text-body text-text-secondary" role="status">
                <Spinner size={14} /> Signing you in…
              </p>
            )}
            {failure && <div className="w-full max-w-sm text-left">{failureSlot}</div>}
            {resent && !failure && busy !== "verify" && (
              <p className="m-0 flex items-center gap-1.5 text-caption text-success">
                <Icon name="check" size={14} /> New code sent. Use the latest email.
              </p>
            )}

            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 sm:gap-x-2">
              {resendLeft > 0 ? (
                <Button variant="ghost" size="sm" iconLeft="clock" aria-disabled className="min-h-11 sm:min-h-0 tabular-nums">
                  Resend code in {mmss(resendLeft)}
                </Button>
              ) : (
                <Button
                  variant={failure?.kind === "bad-code" ? "secondary" : "ghost"} size="sm" iconLeft="inbox"
                  loading={busy === "resend"} aria-disabled={blocked || undefined}
                  onClick={resend} className="min-h-11 sm:min-h-0"
                >
                  {busy === "resend" ? "Sending…" : "Resend code"}
                </Button>
              )}
              <span aria-hidden="true" className="hidden size-[3px] rounded-full bg-border-strong sm:block" />
              <Button variant="ghost" size="sm" iconLeft="edit" onClick={differentEmail} className="min-h-11 sm:min-h-0">
                Use a different email
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default SignInForm;
