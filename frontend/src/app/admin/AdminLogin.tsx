"use client";

import { useState } from "react";
import { Alert, Button, Card, Field, IconButton, Input, MarkdropMark } from "@/components/ui";
import { adminLogin, setAdminToken } from "@/lib/api";

/** The admin sign-in card (REVAMP_PLAN 7.18 "Login"). Separate from Markdrop accounts. */
export function AdminLogin({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { token } = await adminLogin(username, password);
      setAdminToken(token);
      onSignedIn(token);
    } catch {
      setError("That username and password don't match. Check both and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main id="main" tabIndex={-1} className="flex min-h-dvh w-full flex-1 items-center justify-center px-4 py-12 outline-none">
      <Card className="w-full max-w-[400px] rounded-2xl">
        <form onSubmit={submit} className="flex flex-col gap-5 p-1 sm:p-2">
          <div className="flex flex-col items-center gap-3 text-center">
            <MarkdropMark size={40} />
            <div>
              <h1 className="text-h3 text-text">Sign in to the admin console</h1>
              <p className="mt-1 text-caption text-text-muted">Your admin credentials, not your Markdrop account.</p>
            </div>
          </div>
          <Field label="Username">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
          </Field>
          <Field label="Password">
            <Input
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              suffix={
                <IconButton
                  icon={show ? "eyeOff" : "eye"}
                  label={show ? "Hide password" : "Show password"}
                  size="sm"
                  aria-pressed={show}
                  onClick={() => setShow((s) => !s)}
                />
              }
            />
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" variant="primary" block loading={loading}>
            Sign in
          </Button>
        </form>
      </Card>
    </main>
  );
}
