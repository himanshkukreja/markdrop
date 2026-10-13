"use client";

import { useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Button, Dialog, Field, Icon, IconButton, Input, Tabs, Textarea, announce } from "@/components/ui";
import { submitFeedback, type FeedbackType } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Feedback (REVAMP_PLAN 7.19).
 *
 * - `FeedbackDialog`: the "Send feedback" dialog (Bug / Idea, message, optional email). Same API
 *   call and payload as before: `submitFeedback({ type, message, email, pageUrl })`.
 * - `FeedbackWidget`: mounts one dialog for the page, listens for `openFeedback()`, and on marketing
 *   and tool pages shows a quiet 40px launcher bottom-right (`launcher={false}` in the app shell,
 *   where the rail and the account menu carry "Send feedback" instead).
 * - `openFeedback()`: opens the mounted widget's dialog. Returns false when no widget is mounted, so
 *   the caller (account menu) can render its own `FeedbackDialog`.
 */

const OPEN_EVENT = "md:feedback";

export function openFeedback(): boolean {
  if (typeof window === "undefined") return false;
  const ev = new Event(OPEN_EVENT, { cancelable: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
}

const NETWORK_ERROR = "Couldn't send — check your connection and try again.";

type Phase = "form" | "sending" | "done";

export function FeedbackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const [type, setType] = useState<FeedbackType>("bug");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const ids = useId();

  // Prefill the email with the signed-in account (still editable).
  useEffect(() => {
    if (user?.email) setEmail((e) => e || user.email);
  }, [user]);

  // A fresh form on every open.
  useEffect(() => {
    if (!open) return;
    setPhase("form");
    setError("");
    setFieldError("");
  }, [open]);

  function close() {
    onClose();
    if (phase === "done") {
      setMessage("");
      setType("bug");
    }
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (phase === "sending") return;
    if (message.trim().length < 3) {
      setFieldError("Add a little more detail so we can act on it.");
      messageRef.current?.focus();
      return;
    }
    setPhase("sending");
    setError("");
    setFieldError("");
    try {
      await submitFeedback({
        type,
        message: message.trim(),
        email: email.trim() || undefined,
        pageUrl: typeof window !== "undefined" ? window.location.pathname + window.location.search : undefined,
      });
      setPhase("done");
      announce("Thanks. We read every one.");
      requestAnimationFrame(() => doneRef.current?.focus());
    } catch (err) {
      // The API's own 429 copy names the fix; anything else is treated as a connection problem.
      const msg = err instanceof Error && /^Too many/.test(err.message) ? err.message : NETWORK_ERROR;
      setError(msg);
      setPhase("form");
    }
  }

  const done = phase === "done";

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Send feedback"
      description={done ? undefined : "Tell us what broke or what you'd like Markdrop to do."}
      initialFocus={done ? doneRef : messageRef}
      dismissible={phase !== "sending"}
      footer={
        done ? (
          <Button ref={doneRef} variant="primary" onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close} disabled={phase === "sending"}>Cancel</Button>
            <Button variant="primary" type="submit" form={`${ids}-form`} loading={phase === "sending"}>
              Send feedback
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="flex flex-col items-center gap-3 py-4 text-center" role="status">
          <span className="grid size-12 place-items-center rounded-full bg-success-soft text-success" aria-hidden>
            <Icon name="check" size={24} />
          </span>
          <p className="text-body-lg text-text">Thanks. We read every one.</p>
        </div>
      ) : (
        <form id={`${ids}-form`} onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          <Tabs
            variant="pill"
            aria-label="Kind of feedback"
            value={type}
            onChange={(v) => setType(v as FeedbackType)}
            items={[
              { value: "bug", label: "Bug", icon: "bug" },
              { value: "feature", label: "Idea", icon: "sparkle" },
            ]}
          />
          <Field label={type === "bug" ? "What went wrong?" : "What would you like Markdrop to do?"} error={fieldError || undefined}>
            <Textarea
              ref={messageRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={5}
              maxLength={4000}
              invalid={!!fieldError}
              placeholder={type === "bug" ? "Steps to reproduce, and what you expected instead" : "Describe the idea and what it would help you do"}
              className="resize-y"
            />
          </Field>
          <Field label="Email (optional, so we can reply)">
            <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </Field>
          {error && (
            <p role="alert" className="flex items-start gap-2 text-body text-danger">
              <Icon name="alert" size={16} className="mt-0.5" />
              <span>{error}</span>
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
}

/** Marks the launcher hidden while something it would sit on is open (a bottom sheet, immersive). */
function useCovered(): boolean {
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    const check = () =>
      setCovered(!!document.querySelector(".md-drawer--bottom, .md-immersive, [data-md-immersive], [data-md-sheet-open]"));
    check();
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-md-sheet-open", "data-md-immersive"] });
    return () => mo.disconnect();
  }, []);
  return covered;
}

export default function FeedbackWidget({ launcher = true }: { launcher?: boolean }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() || "/";
  const covered = useCovered();

  useEffect(() => {
    const onOpen = (e: Event) => {
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  // Never over a document or a tenant page (the layouts that mount this already exclude them).
  const hiddenRoute = pathname.startsWith("/h/");
  const showLauncher = launcher && !hiddenRoute && !covered;

  return (
    <>
      {showLauncher && (
        // Desktop and tablet only: on phones the tool pages own the bottom edge (sticky action bars),
        // so feedback lives in the Menu drawer and the account menu there.
        <div className="no-print fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-(--z-sticky) hidden md:block">
          <IconButton
            icon="message"
            label="Send feedback"
            variant="secondary"
            className="size-10 rounded-full"
            onClick={() => setOpen(true)}
          />
        </div>
      )}
      <FeedbackDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
