"use client";

import { useEffect, useId, useState } from "react";
import { Button, IconButton, Input } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { useAuth } from "@/contexts/AuthContext";
import { updateMyName } from "@/lib/api";

const DISMISS_KEY = "md_name_card_dismissed";

function readDismissed(userId: string): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === userId;
  } catch {
    return false;
  }
}

/**
 * The inline replacement for the old global NamePrompt modal (REVAMP_PLAN 7.10 / 7.19): shown on
 * the dashboard for an account with no display name (passwordless email sign-ups). Dismissible,
 * and remembered per account on this device. Uses the same PATCH /auth/me call NamePrompt made;
 * the name is trimmed and an empty one is never sent (the API would store "" for whitespace).
 */
export default function NameCard() {
  const { user, loading, updateUser } = useAuth();
  const toast = useToast();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState(true);
  const inputId = useId();
  const titleId = useId();
  const errorId = useId();

  useEffect(() => {
    if (user) setDismissed(readDismissed(user.id));
  }, [user]);

  if (loading || !user || user.name || dismissed) return null;

  function dismiss() {
    setDismissed(true);
    try {
      if (user) localStorage.setItem(DISMISS_KEY, user.id);
    } catch {
      /* the card just comes back next time */
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError("");
    try {
      const updated = await updateMyName(n);
      updateUser(updated);
      toast.success("Name saved");
    } catch {
      setError("Couldn't save your name. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={titleId} className="relative rounded-xl border border-border bg-surface p-4">
      <IconButton icon="x" label="Dismiss" size="sm" className="absolute top-2 right-2 max-sm:size-11" onClick={dismiss} />
      <h2 id={titleId} className="pr-10 text-body-strong text-text">Add your name so teammates recognise you</h2>
      <p className="mt-0.5 pr-10 text-caption text-text-muted">
        It shows on invitations and on documents you share with a workspace.
      </p>
      <form onSubmit={save} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
        <label htmlFor={inputId} className="md-visually-hidden">Your name</label>
        <Input
          id={inputId}
          value={name}
          onChange={(e) => { setName(e.target.value); setError(""); }}
          maxLength={80}
          autoComplete="name"
          placeholder="Your name"
          invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          className="w-full sm:max-w-80"
        />
        <Button type="submit" variant="secondary" loading={busy} disabled={!name.trim()} className="max-sm:h-11">Save</Button>
      </form>
      {error && <p id={errorId} role="alert" className="mt-2 text-caption text-danger">{error}</p>}
    </section>
  );
}
