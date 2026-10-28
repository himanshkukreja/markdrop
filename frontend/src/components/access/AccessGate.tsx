"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Alert, Avatar, Button, Icon, Input, Textarea } from "@/components/ui";
import s from "./AccessGate.module.css";

/**
 * What a reader sees instead of a document they cannot open.
 *
 * Three different situations used to share one screen, and it told two of them
 * something untrue. "Sign in to continue" is right for a stranger, useless for
 * someone already signed in with the wrong account, and actively misleading for
 * a document that has no password when the screen offers a password box.
 *
 * So the state is named, and each one says the thing that is actually true and
 * offers the action that would actually help:
 *
 *   password  a shared secret anyone holding it may type
 *   signin    not public, and we do not know who you are yet
 *   denied    we know exactly who you are, and it is not shared with you
 *
 * `denied` names the address, because the fix is nearly always that the reader
 * is signed in as the wrong one — a personal address when the document went to
 * a work address. Telling them to "sign in" when they already are is how people
 * end up convinced the link is broken.
 *
 * Used by documents and artifacts alike (REVAMP_PLAN 7.6 "Access gates"); pass
 * `noun` for the artifact wording. Titles and bodies are verbatim from before
 * the revamp; the button labels and the wrong-password treatment follow 7.6.
 */

type Mode = "password" | "signin" | "denied";

function copyFor(mode: Mode, noun: string): { title: string; body: string } {
  switch (mode) {
    case "password":
      return {
        title: `This ${noun} is password protected`,
        body: "Enter the password you were given to open it.",
      };
    case "signin":
      return {
        title: `This ${noun} is private`,
        body: "It's shared with specific people. Sign in with the address it was shared with and it'll open.",
      };
    default:
      return {
        title: "You don't have access",
        body: `This ${noun} is shared with specific people, and this account isn't one of them.`,
      };
  }
}

export interface AccessGateProps {
  mode: Mode;
  signInHref: string;
  /** The address the reader is signed in as, for `denied`. */
  email?: string | null;
  /** "document" (default), "file", "page"… for the title and body. */
  noun?: string;
  /** The sign-in button's label. Tenants pass "Sign in to read {site name}". */
  signInLabel?: string;
  /** Heading level of the title. The viewer passes 1: the gate is the page's only heading. */
  headingLevel?: 1 | 2;
  // Password mode only.
  value?: string;
  onValue?: (v: string) => void;
  onSubmit?: (e: React.SyntheticEvent) => void;
  submitting?: boolean;
  error?: string;
  /** Bump for each failed attempt, so a repeated error shakes again. */
  errorKey?: number;
  /** Controlled show/hide of the password (optional; uncontrolled otherwise). */
  visible?: boolean;
  onToggleVisible?: () => void;
  /**
   * Denied mode only: the server said this reader may ask the owner for access ("No dead ends").
   * Without it (or with `canRequest` false) the gate keeps its plain "ask the owner" copy, so a
   * backend that doesn't offer requests never shows a button that would be refused.
   */
  request?: { slug: string; canRequest: boolean; pending: boolean; ownerFirstName: string | null; requestUrl?: string } | null;
  className?: string;
}

export default function AccessGate(props: AccessGateProps) {
  const { mode, request } = props;
  if (mode === "denied" && request?.canRequest) {
    return (
      <RequestAccessGate
        request={request}
        email={props.email}
        signInHref={props.signInHref}
        headingLevel={props.headingLevel ?? 2}
        className={props.className}
      />
    );
  }
  return <StandardGate {...props} />;
}

function StandardGate({
  mode,
  signInHref,
  email,
  noun = "document",
  signInLabel = "Sign in to open",
  headingLevel = 2,
  value = "",
  onValue,
  onSubmit,
  submitting,
  error,
  errorKey = 0,
  visible: visibleProp,
  onToggleVisible,
  className,
}: AccessGateProps) {
  const { title, body } = copyFor(mode, noun);
  const [visibleState, setVisibleState] = useState(false);
  const visible = visibleProp ?? visibleState;
  const toggle = onToggleVisible ?? (() => setVisibleState((v) => !v));
  const inputRef = useRef<HTMLInputElement>(null);
  const [shake, setShake] = useState(false);

  // A wrong password: shake once and put the cursor back in the field.
  useEffect(() => {
    if (!error || mode !== "password") return;
    setShake(true);
    inputRef.current?.focus();
    inputRef.current?.select();
    const t = setTimeout(() => setShake(false), 320);
    return () => clearTimeout(t);
  }, [error, errorKey, mode]);

  const H = headingLevel === 1 ? "h1" : "h2";
  const errorId = "md-gate-error";

  return (
    <section
      aria-labelledby="md-gate-title"
      className={[s.gate, s.enter, className].filter(Boolean).join(" ")}
    >
      <div className={s.ghost} aria-hidden>
        {[40, 100, 83, 75, 100, 83, 60, 100, 90].map((w, i) => (
          <span key={i} style={{ width: `${w}%` }} />
        ))}
      </div>
      <div className={s.panel}>
        <span className={[s.glyph, mode === "denied" && s.glyphWarn].filter(Boolean).join(" ")} aria-hidden>
          <Icon name={mode === "denied" ? "userX" : "lock"} />
        </span>
        <div className="flex flex-col gap-1.5">
          <H id="md-gate-title" className="text-h4 text-text">{title}</H>
          <p className="text-body text-text-secondary">{body}</p>
        </div>

        {mode === "password" && (
          <form
            className="flex w-full flex-col gap-2 text-left"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit?.(e);
            }}
          >
            <div className={[s.form, shake && s.shake].filter(Boolean).join(" ")}>
              <Input
                ref={inputRef}
                type={visible ? "text" : "password"}
                placeholder="Password"
                aria-label="Password"
                autoComplete="current-password"
                autoFocus
                value={value}
                onChange={(e) => onValue?.(e.target.value)}
                invalid={!!error}
                aria-describedby={error ? errorId : undefined}
                wrapClassName="min-w-0 flex-1"
                suffix={
                  <button
                    type="button"
                    className="md-focus grid h-8 w-8 place-items-center rounded-md text-text-muted hover:text-text"
                    aria-label={visible ? "Hide password" : "Show password"}
                    aria-pressed={visible}
                    onClick={toggle}
                  >
                    <Icon name={visible ? "eyeOff" : "eye"} />
                  </button>
                }
              />
              <Button type="submit" loading={submitting} disabled={!value.trim()} className="shrink-0">
                Unlock
              </Button>
            </div>
            {error && (
              <p id={errorId} role="alert" className="flex items-start gap-1.5 text-caption text-danger">
                <Icon name="alertCircle" className="mt-0.5 shrink-0" />
                {error}
              </p>
            )}
          </form>
        )}

        {mode === "signin" && (
          <Button href={signInHref} iconLeft="user" className="w-full sm:w-auto">
            {signInLabel}
          </Button>
        )}

        {mode === "denied" && (
          <div className="flex w-full flex-col items-center gap-3">
            {email && (
              <span className={s.chip}>
                <Avatar name={email} size="sm" />
                <span className="min-w-0 truncate text-caption text-text-secondary">
                  Signed in as <span className="font-semibold text-text">{email}</span>
                </span>
              </span>
            )}
            <p className="text-caption text-text-secondary">
              Ask the owner to share it with this address — or sign in with the account it was sent to.
            </p>
            <Button href={signInHref} variant="secondary" className="w-full sm:w-auto">
              Sign in with another account
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * "No dead ends" (simpler UI, RequestAccess board): a signed-in reader the document isn't shared
 * with can ask its owner, with an optional note. The owner gets an email and decides; nothing is
 * opened here. Offered only when the server said so on the denied read (`can_request_access`).
 */
function RequestAccessGate({
  request, email, signInHref, headingLevel, className,
}: {
  request: NonNullable<AccessGateProps["request"]>;
  email?: string | null;
  signInHref: string;
  headingLevel: 1 | 2;
  className?: string;
}) {
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "pending">(request.pending ? "pending" : "idle");
  const [error, setError] = useState("");
  const statusRef = useRef<HTMLParagraphElement>(null);
  const msgId = useId();
  const H = headingLevel === 1 ? "h1" : "h2";
  const owner = request.ownerFirstName;
  const decides = `You'll get an email when ${owner ?? "the owner"} decides.`;

  useEffect(() => {
    if (state === "sent") statusRef.current?.focus();
  }, [state]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (state === "sending") return;
    setState("sending");
    setError("");
    try {
      // Loaded on demand: the authenticated API module isn't part of a public page's first load.
      const { requestAccess } = await import("@/lib/me");
      await requestAccess(request.slug, message);
      setState("sent");
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      if (status === 409) { setState("pending"); return; }
      setState("idle");
      setError(
        status === 429 ? "You've asked for a lot of things in the last hour. Try again later."
          : status === 403 ? "This one is opened with a password, not by asking. Get the password from whoever shared it."
            : status === 401 || status === 404 ? "This can't be requested from here. Open the link on markdrop.in, signed in, to ask for access."
            : err instanceof Error && err.message ? err.message : "Couldn't send the request. Try again.",
      );
    }
  }

  const done = state === "sent" || state === "pending";

  return (
    <section aria-labelledby="md-gate-title" className={[s.gate, s.enter, className].filter(Boolean).join(" ")}>
      <div className={s.ghost} aria-hidden>
        {[40, 100, 83, 75, 100, 83, 60, 100, 90].map((w, i) => (
          <span key={i} style={{ width: `${w}%` }} />
        ))}
      </div>
      <div className={s.panel}>
        <span className={[s.glyph, s.glyphQuiet].join(" ")} aria-hidden>
          <Icon name={done ? "send" : "lock"} />
        </span>
        <div className="flex flex-col gap-1.5">
          <H id="md-gate-title" className="text-h2 text-text">{done ? "Request sent" : "You don't have access yet"}</H>
          {!done && (
            <p className="text-body text-text-secondary">
              {email ? <>You&apos;re signed in as <strong className="font-semibold text-text">{email}</strong>. </> : null}
              Ask the owner and you&apos;ll get an email when they let you in.
            </p>
          )}
          {done && (
            <p ref={statusRef} tabIndex={-1} role="status" className="text-body text-text-secondary outline-none">
              {state === "pending" ? `You've already asked for this. ${decides}` : `Request sent. ${decides}`}
            </p>
          )}
        </div>

        {!done && request.requestUrl && (
          <div className="flex flex-wrap justify-center gap-2">
            <Button href={request.requestUrl} variant="primary" iconLeft="arrowRight">Request access</Button>
            <Button href={signInHref} variant="ghost">Switch account</Button>
          </div>
        )}

        {!done && !request.requestUrl && (
          <form className="flex w-full flex-col gap-4 text-left" onSubmit={send}>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={msgId} className="text-body-strong text-text">
                Message <span className="font-normal text-text-muted">(optional)</span>
              </label>
              <Textarea
                id={msgId}
                rows={2}
                maxLength={500}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={owner ? `Hi ${owner}, I need this for Thursday's review.` : "Hi, I need this for Thursday's review."}
                className="resize-none"
              />
            </div>
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="flex flex-wrap justify-center gap-2">
              <Button type="submit" variant="primary" iconLeft="arrowRight" loading={state === "sending"}>Request access</Button>
              <Button href={signInHref} variant="ghost">Switch account</Button>
            </div>
          </form>
        )}

        {done && (
          <Button href={signInHref} variant="ghost">Switch account</Button>
        )}
      </div>
    </section>
  );
}
