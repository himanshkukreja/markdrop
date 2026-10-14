"use client";
/**
 * OtpInput (REVAMP_PLAN 7.14, 8.2): six one-digit boxes for the sign-in code.
 *
 * - `inputMode="numeric"`, the first box carries `autoComplete="one-time-code"` (iOS/Android offer
 *   the emailed code there and fill the whole string into it, which is spread across the boxes).
 * - Typing advances; Backspace on an empty box clears the previous one and moves back;
 *   Left/Right/Home/End move. Pasting anywhere fills from that box (a full-length paste fills
 *   from the first).
 * - `onComplete(code)` fires when the last empty box is filled (typing, paste or autofill), once
 *   per distinct code.
 * - `error` (truthy) marks every box invalid and shakes the row once: 3 × 4px over 280ms; nothing
 *   moves under reduced motion. Change `errorKey` to shake again for a repeated error.
 * - Controlled (`value` + `onChange`) or uncontrolled.
 */
import React, { useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { Icon } from "@/components/ui";
import s from "./publish.module.css";

export interface OtpInputHandle { focus: (index?: number) => void; clear: () => void; }

export interface OtpInputProps {
  length?: number;
  value?: string;
  defaultValue?: string;
  onChange?: (code: string) => void;
  onComplete?: (code: string) => void;
  /** true marks the boxes invalid; a string is also shown under them (role="alert"). */
  error?: boolean | string;
  /** Bump to replay the shake for the same error. */
  errorKey?: number | string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Names the group. Default "6-digit sign-in code". */
  label?: string;
  /** Form field name for a hidden input carrying the joined code. */
  name?: string;
  className?: string;
}

const onlyDigits = (s: string) => s.replace(/\D+/g, "");

export const OtpInput = React.forwardRef<OtpInputHandle, OtpInputProps>(function OtpInput(
  { length = 6, value, defaultValue = "", onChange, onComplete, error, errorKey, disabled, autoFocus, label, name, className }, ref) {
  const controlled = value !== undefined;
  const [inner, setInner] = useState(() => onlyDigits(defaultValue).slice(0, length));
  const code = (controlled ? onlyDigits(value!) : inner).slice(0, length);
  // The latest code, including a write this render hasn't caught up with yet (focus handlers run
  // synchronously inside set(), before React re-renders).
  const codeRef = useRef(code);
  codeRef.current = code;
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  const lastCompleted = useRef<string | null>(null);
  const [shake, setShake] = useState(0);
  const uid = useId();

  const focusAt = (i: number) => {
    const el = boxes.current[Math.max(0, Math.min(length - 1, i))];
    el?.focus(); el?.select();
  };
  useImperativeHandle(ref, () => ({ focus: (i = Math.min(code.length, length - 1)) => focusAt(i), clear: () => set("", 0) }));

  // Shake on a new error (or a bumped errorKey); move focus back to the first box.
  const hasError = !!error;
  useEffect(() => {
    if (!hasError) return;
    setShake((n) => n + 1);
    focusAt(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasError, errorKey]);
  // The a/b class flip replays the CSS animation without remounting the boxes (focus stays put).
  const shakeClass = shake > 0 && hasError ? (shake % 2 ? s.otpShakeA : s.otpShakeB) : undefined;
  useEffect(() => { if (autoFocus) focusAt(0); /* once */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A new code (shorter than full) re-arms onComplete for the same digits.
  useEffect(() => { if (code.length < length) lastCompleted.current = null; }, [code, length]);

  function set(next: string, focusIndex: number) {
    const v = onlyDigits(next).slice(0, length);
    codeRef.current = v;
    if (!controlled) setInner(v);
    onChange?.(v);
    focusAt(focusIndex);
    if (v.length === length && lastCompleted.current !== v) {
      lastCompleted.current = v;
      onComplete?.(v);
    }
  }
  /** Writes `digits` starting at box `i` (overwriting), keeping the boxes before it. */
  function writeAt(i: number, digits: string) {
    const chars = codeRef.current.padEnd(length, " ").split("");
    for (let k = 0; k < digits.length && i + k < length; k++) chars[i + k] = digits[k]!;
    // Keep it a prefix: digits after a gap would be ambiguous, so cut at the first empty box.
    const joined = chars.join("");
    const gap = joined.indexOf(" ");
    const next = gap < 0 ? joined : joined.slice(0, gap);
    set(next, Math.min(i + digits.length, length - 1));
  }

  const onInput = (i: number, raw: string) => {
    const code = codeRef.current;
    const d = onlyDigits(raw);
    if (!d) return;
    // Autofill or a fast typist: several digits arrive in one box. A full code fills from the start.
    if (d.length >= length) { writeAt(0, d.slice(0, length)); return; }
    // A box that already had a digit: the new one is whichever isn't the old one.
    const old = code[i];
    const digit = d.length > 1 && old && d.startsWith(old) ? d.slice(1) : d;
    writeAt(Math.min(i, code.length), digit);
  };

  const onKey = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    const code = codeRef.current;
    switch (e.key) {
      case "Backspace": {
        e.preventDefault();
        // Removes this digit (the later ones shift left), or, in an empty box, the one before.
        if (code[i]) set(code.slice(0, i) + code.slice(i + 1), i);
        else if (i > 0) set(code.slice(0, i - 1) + code.slice(i), i - 1);
        break;
      }
      case "Delete": e.preventDefault(); if (code[i]) set(code.slice(0, i) + code.slice(i + 1), i); break;
      case "ArrowLeft": e.preventDefault(); focusAt(i - 1); break;
      case "ArrowRight": e.preventDefault(); focusAt(Math.min(i + 1, code.length)); break;
      case "Home": e.preventDefault(); focusAt(0); break;
      case "End": e.preventDefault(); focusAt(Math.min(code.length, length - 1)); break;
      default:
        // A digit typed into a filled box replaces it (the input event follows).
        if (/^\d$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); writeAt(Math.min(i, code.length), e.key); }
    }
  };

  const onPaste = (i: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    const d = onlyDigits(e.clipboardData.getData("text"));
    e.preventDefault();
    if (!d) return;
    writeAt(d.length >= length ? 0 : Math.min(i, codeRef.current.length), d);
  };

  const errId = `${uid}-err`;
  const groupLabel = label ?? `${length}-digit sign-in code`;
  return (
    <div className={[s.otp, className].filter(Boolean).join(" ")}>
      <div role="group" aria-label={groupLabel} aria-describedby={typeof error === "string" ? errId : undefined}
        className={[s.otpRow, shakeClass].filter(Boolean).join(" ")}>
        {Array.from({ length }, (_, i) => (
          <input key={i} ref={(el) => { boxes.current[i] = el; }}
            className={[s.otpBox, hasError && s.otpBoxError, i === Math.floor(length / 2) && s.otpBoxGap].filter(Boolean).join(" ")}
            type="text" inputMode="numeric" pattern="[0-9]*" maxLength={i === 0 ? length : 2}
            autoComplete={i === 0 ? "one-time-code" : "off"} autoCorrect="off" spellCheck={false}
            aria-label={`Digit ${i + 1} of ${length}`} aria-invalid={hasError || undefined}
            disabled={disabled} value={code[i] ?? ""}
            // Only the next empty box (or the last) is a tab stop, so Tab doesn't walk six boxes.
            tabIndex={i === Math.min(code.length, length - 1) ? 0 : -1}
            onFocus={(e) => { const n = codeRef.current.length; if (i > n) focusAt(n); else e.currentTarget.select(); }}
            onChange={(e) => onInput(i, e.target.value)}
            onKeyDown={(e) => onKey(i, e)}
            onPaste={(e) => onPaste(i, e)} />
        ))}
      </div>
      {name && <input type="hidden" name={name} value={code} />}
      {typeof error === "string" && error && (
        <div id={errId} className={s.hintError} role="alert"><Icon name="alertCircle" /> {error}</div>
      )}
    </div>
  );
});
