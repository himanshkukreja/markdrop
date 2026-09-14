"use client";

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
 */

type Mode = "password" | "signin" | "denied";

const COPY: Record<Mode, { title: string; body: string }> = {
  password: {
    title: "This document is password protected",
    body: "Enter the password you were given to open it.",
  },
  signin: {
    title: "This document is private",
    body: "It's shared with specific people. Sign in with the address it was shared with and it'll open.",
  },
  denied: {
    title: "You don't have access",
    body: "This document is shared with specific people, and this account isn't one of them.",
  },
};

function Glyph({ mode }: { mode: Mode }) {
  return (
    <span
      className={`grid h-14 w-14 place-items-center rounded-2xl border ${
        mode === "denied"
          ? "border-amber-500/25 bg-amber-500/10 text-amber-500 dark:text-amber-400"
          : "border-blue-500/25 bg-blue-500/10 text-blue-500 dark:text-blue-400"
      }`}
    >
      <svg
        className="h-6 w-6"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {mode === "denied" ? (
          <>
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="m17 8 5 5M22 8l-5 5" />
          </>
        ) : mode === "signin" ? (
          <>
            <rect x="4" y="10" width="16" height="11" rx="2.5" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            <circle cx="12" cy="15.5" r="1.2" />
          </>
        ) : (
          <>
            <rect x="4" y="10" width="16" height="11" rx="2.5" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            <path d="M12 14v3" />
          </>
        )}
      </svg>
    </span>
  );
}

export default function AccessGate({
  mode,
  signInHref,
  email,
  // Password mode only.
  value,
  onValue,
  onSubmit,
  submitting,
  error,
  visible,
  onToggleVisible,
}: {
  mode: Mode;
  signInHref: string;
  /** The address the reader is signed in as, for `denied`. */
  email?: string | null;
  value?: string;
  onValue?: (v: string) => void;
  onSubmit?: (e: React.SyntheticEvent) => void;
  submitting?: boolean;
  error?: string;
  visible?: boolean;
  onToggleVisible?: () => void;
}) {
  const { title, body } = COPY[mode];

  return (
    <div className="relative overflow-hidden rounded-2xl border border-gray-200 dark:border-white/[0.08]">
      {/* Enough of a document to show there is one here, and not a line of it
          legible. Purely decorative, so it is hidden from assistive tech.
          Absolutely positioned so the panel is sized by the message rather than
          by the decoration — the other way round clipped the longer states. */}
      <div
        className="pointer-events-none absolute inset-0 select-none space-y-3 p-6 opacity-40 blur-[6px]"
        aria-hidden
      >
        {[...Array(9)].map((_, i) => (
          <div
            key={i}
            className={`h-3 rounded-full bg-gray-300 dark:bg-white/10 ${
              i === 0 ? "w-2/5" : i % 3 === 1 ? "w-full" : i % 3 === 2 ? "w-5/6" : "w-3/4"
            }`}
          />
        ))}
      </div>

      <div className="relative grid place-items-center bg-white/70 px-5 py-12 backdrop-blur-[3px] sm:py-16 dark:bg-gray-950/70">
        <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
          <Glyph mode={mode} />

          <div className="space-y-1.5">
            <h2 className="text-[15px] font-semibold text-gray-900 dark:text-gray-100">
              {title}
            </h2>
            <p className="text-[13px] leading-relaxed text-gray-500 dark:text-gray-400">
              {body}
            </p>
          </div>

          {mode === "password" ? (
            <form onSubmit={onSubmit} className="w-full space-y-2">
              <div className="flex gap-2">
                <div className="flex flex-1 items-center overflow-hidden rounded-xl border border-gray-300 bg-white transition-colors focus-within:border-blue-500 dark:border-white/10 dark:bg-white/[0.04]">
                  <input
                    type={visible ? "text" : "password"}
                    value={value}
                    onChange={(e) => onValue?.(e.target.value)}
                    placeholder="Password"
                    autoFocus
                    className="min-w-0 flex-1 bg-transparent px-3.5 py-2.5 text-sm text-gray-800 outline-none placeholder:text-gray-400 dark:text-gray-100"
                  />
                  {value ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={onToggleVisible}
                      className="shrink-0 px-3 text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-200"
                      aria-label={visible ? "Hide password" : "Show password"}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        {visible ? (
                          <>
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                            <line x1="1" y1="1" x2="23" y2="23" />
                          </>
                        ) : (
                          <>
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </>
                        )}
                      </svg>
                    </button>
                  ) : null}
                </div>
                <button
                  type="submit"
                  disabled={submitting || !value?.trim()}
                  className="shrink-0 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {submitting ? "…" : "Unlock"}
                </button>
              </div>
              {error && <p className="text-left text-xs text-red-500">{error}</p>}
            </form>
          ) : mode === "signin" ? (
            <a
              href={signInHref}
              className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-500"
            >
              Sign in
            </a>
          ) : (
            <div className="flex w-full flex-col items-center gap-3">
              {email && (
                <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-gray-200 bg-gray-50 px-3 py-1.5 dark:border-white/10 dark:bg-white/[0.04]">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-blue-600 text-[9px] font-bold text-white">
                    {(email.trim()[0] || "?").toUpperCase()}
                  </span>
                  <span className="truncate text-[12.5px] text-gray-600 dark:text-gray-300">
                    Signed in as {email}
                  </span>
                </span>
              )}
              <p className="text-[12.5px] leading-relaxed text-gray-500 dark:text-gray-400">
                Ask the owner to share it with this address — or sign in with the
                account it was sent to.
              </p>
              <a
                href={signInHref}
                className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:border-white/15 dark:text-gray-200 dark:hover:bg-white/[0.06]"
              >
                Use a different account
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
