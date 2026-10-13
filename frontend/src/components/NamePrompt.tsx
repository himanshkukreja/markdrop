"use client";

import { useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { updateMyName } from "@/lib/api";
import { Button, Dialog, Field, Input } from "@/components/ui";

/**
 * Asks an account with no display name (passwordless email sign-ups; Google sign-ins already have
 * one) for a name. No longer mounted globally: the dashboard shows an inline name card instead
 * (REVAMP_PLAN 7.10 / 7.19), and this must never appear on /invite, /auth/* or /extension/authorize.
 * Kept, on the design-system Dialog, for any surface that still wants the modal form.
 */
export default function NamePrompt() {
  const { user, loading, updateUser } = useAuth();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (loading || !user || user.name || dismissed) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const updated = await updateMyName(name.trim());
      updateUser(updated);
    } catch {
      setError("Couldn't save your name. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={() => setDismissed(true)}
      title="What should we call you?"
      description="Add a display name for your account. You can change it later."
      initialFocus={inputRef}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={() => setDismissed(true)} disabled={busy}>Skip</Button>
          <Button variant="primary" type="submit" form="md-name-prompt" loading={busy} disabled={!name.trim()}>Save</Button>
        </>
      }
    >
      <form id="md-name-prompt" onSubmit={save}>
        <Field label="Display name" error={error || undefined}>
          <Input ref={inputRef} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" placeholder="Your name" />
        </Field>
      </form>
    </Dialog>
  );
}
