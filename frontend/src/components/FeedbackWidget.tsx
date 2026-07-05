"use client";

import { useEffect, useState } from "react";
import Modal from "@/components/Modal";
import { submitFeedback, type FeedbackType } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

type Phase = "form" | "sending" | "done";

export default function FeedbackWidget() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<FeedbackType>("bug");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState("");

  // Prefill the email with the signed-in account (still editable).
  useEffect(() => {
    if (user?.email) setEmail(user.email);
  }, [user]);

  function openForm() {
    setPhase("form");
    setError("");
    setOpen(true);
  }

  function close() {
    setOpen(false);
    // Reset shortly after the modal closes so the next open is clean.
    setTimeout(() => {
      setPhase("form");
      setMessage("");
      setError("");
      setType("bug");
    }, 200);
  }

  async function handleSubmit() {
    if (message.trim().length < 3) {
      setError("Please add a little more detail.");
      return;
    }
    setPhase("sending");
    setError("");
    try {
      await submitFeedback({
        type,
        message: message.trim(),
        email: email.trim() || undefined,
        pageUrl: typeof window !== "undefined" ? window.location.pathname + window.location.search : undefined,
      });
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("form");
    }
  }

  const seg = (t: FeedbackType, label: string, icon: React.ReactNode) => (
    <button
      type="button"
      onClick={() => setType(t)}
      className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border transition-colors ${
        type === t
          ? "border-blue-500/60 bg-blue-50 dark:bg-blue-950/30 vscode:bg-[#264f78]/30 text-blue-700 dark:text-blue-300"
          : "border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] text-gray-600 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600"
      }`}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <>
      {/* Floating launcher — visible on every page, for anyone */}
      <button
        onClick={openForm}
        title="Report a bug or request a feature"
        aria-label="Send feedback"
        className="no-print fixed bottom-4 right-4 z-[90] inline-flex items-center gap-2 rounded-full pl-3 pr-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/30 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h8M8 14h5M21 12a8 8 0 01-11.3 7.3L3 21l1.7-6.7A8 8 0 1121 12z" />
        </svg>
        <span className="text-sm font-medium">Feedback</span>
      </button>

      {open && (
        <Modal title={phase === "done" ? "Thank you!" : "Send feedback"} onClose={close}>
          {phase === "done" ? (
            <div className="text-center py-4">
              <div className="mx-auto mb-3 w-12 h-12 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center">
                <svg className="w-6 h-6 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-300 vscode:text-[#cccccc]">
                {type === "bug"
                  ? "Thanks for the report — we'll look into it."
                  : "Thanks for the idea — we appreciate it!"}
              </p>
              <button
                onClick={close}
                className="mt-5 px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
              >
                Done
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex gap-2">
                {seg(
                  "bug",
                  "Bug",
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 6a3 3 0 016 0M5 12h14M6 9a6 6 0 0112 0v3a6 6 0 01-12 0V9zM4 10l2 1M4 16l2.5-1M20 10l-2 1M20 16l-2.5-1M12 15v6" />
                  </svg>
                )}
                {seg(
                  "feature",
                  "Feature request",
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 18h6M10 22h4M12 2a7 7 0 00-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0012 2z" />
                  </svg>
                )}
              </div>

              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                autoFocus
                rows={5}
                maxLength={4000}
                placeholder={
                  type === "bug"
                    ? "What went wrong? Steps to reproduce, what you expected…"
                    : "What would you like Markdrop to do?"
                }
                className="w-full bg-gray-50 dark:bg-gray-900 vscode:bg-[#1e1e1e] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg px-3 py-2 text-sm text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] resize-none outline-none focus:border-blue-500 transition-colors"
              />

              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                  Email <span className="font-normal text-gray-400">(optional — so we can follow up)</span>
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full bg-gray-50 dark:bg-gray-900 vscode:bg-[#1e1e1e] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg px-3 py-2 text-sm text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] outline-none focus:border-blue-500 transition-colors"
                />
              </div>

              {error && <p className="text-red-500 text-sm">{error}</p>}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={close}
                  className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={phase === "sending"}
                  className="px-4 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition-colors"
                >
                  {phase === "sending" ? "Sending…" : "Send"}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
