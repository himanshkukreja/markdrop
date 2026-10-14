"use client";

import { useEffect, useRef, useState } from "react";
import { Avatar, Button, Icon, Input } from "@/components/ui";
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
  className?: string;
}

export default function AccessGate({
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
