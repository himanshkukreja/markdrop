"use client";

import { useState } from "react";
import { googleLoginUrl, emailRequestLogin, emailVerifyOtp } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import Modal from "@/components/Modal";
import Spinner from "@/components/Spinner";

/**
 * In-place sign-in / sign-up modal (Markdrop is passwordless, so the same flow
 * both signs in and creates an account). Email-code verification completes
 * without leaving the page and fires `onSuccess`; "Continue with Google" is a
 * full OAuth redirect, so it carries `next` to resume the action on return.
 */
export default function AuthModal({
  onClose,
  onSuccess,
  next = "/dashboard",
  title = "Sign in to Markdrop",
  message,
}: {
  onClose: () => void;
  onSuccess?: () => void;
  next?: string;
  title?: string;
  message?: string;
}) {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [error, setError] = useState("");

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true); setError("");
    try {
      await emailRequestLogin(email.trim());
      setStage("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send code");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (code.trim().length < 4) return;
    setBusy(true); setError("");
    try {
      const { token, user } = await emailVerifyOtp(email.trim(), code.trim());
      await login(token, user);
      onSuccess?.();
      onClose();
    } catch {
      setError("Invalid or expired code");
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "w-full bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg px-3 py-2.5 text-sm text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] outline-none focus:border-blue-500 transition-colors";

  return (
    <Modal title={title} onClose={() => { if (!busy && !googleBusy) onClose(); }}>
      <div className="space-y-4">
        {message && (
          <p className="text-sm text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">{message}</p>
        )}

        {error && (
          <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        <a
          href={googleLoginUrl(next)}
          onClick={() => setGoogleBusy(true)}
          aria-disabled={googleBusy}
          className={`flex items-center justify-center gap-2 w-full border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] rounded-lg px-3 py-2.5 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] transition-colors text-gray-700 dark:text-gray-200 vscode:text-[#d4d4d4] ${googleBusy ? "opacity-70 pointer-events-none" : ""}`}
        >
          {googleBusy ? (
            <Spinner className="w-4 h-4" />
          ) : (
            <svg className="w-4 h-4" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"/><path fill="#EA4335" d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.44 14.97.5 12 .5A11 11 0 0 0 2.18 7.06L5.84 9.9C6.71 7.3 9.14 4.75 12 4.75z"/></svg>
          )}
          {googleBusy ? "Redirecting…" : "Continue with Google"}
        </a>

        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-gray-200 dark:bg-gray-800 vscode:bg-[#3c3c3c]" />
          <span className="text-xs text-gray-400">or</span>
          <div className="flex-1 h-px bg-gray-200 dark:bg-gray-800 vscode:bg-[#3c3c3c]" />
        </div>

        {stage === "email" ? (
          <form onSubmit={sendCode} className="space-y-3">
            <input
              type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com" className={inputClass} autoFocus
            />
            <button type="submit" disabled={busy}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg px-3 py-2.5 text-sm font-medium transition-colors">
              {busy && <Spinner className="w-4 h-4" />}
              {busy ? "Sending…" : "Email me a code"}
            </button>
          </form>
        ) : (
          <form onSubmit={verify} className="space-y-3">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              We emailed <span className="font-medium text-gray-700 dark:text-gray-200">{email}</span> a 6-digit code.
            </p>
            <input
              inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="123456" maxLength={6}
              className={`${inputClass} text-center text-lg tracking-[0.5em] font-mono`} autoFocus
            />
            <button type="submit" disabled={busy}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg px-3 py-2.5 text-sm font-medium transition-colors">
              {busy && <Spinner className="w-4 h-4" />}
              {busy ? "Verifying…" : "Verify & continue"}
            </button>
            <button type="button" onClick={() => { setStage("email"); setCode(""); setError(""); }}
              className="w-full text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
              Use a different email
            </button>
          </form>
        )}

        <p className="text-xs text-gray-400 dark:text-gray-500 text-center">
          No password needed — new here? An account is created automatically.
        </p>
      </div>
    </Modal>
  );
}
