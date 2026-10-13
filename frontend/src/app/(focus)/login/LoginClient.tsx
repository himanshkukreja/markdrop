"use client";

import { useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SignInForm } from "@/components/auth/SignInForm";
import { Benefits, LoginVignette } from "./LoginVignette";

/** `next` must be a path on this site (open-redirect guard). */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard";
}

/** When sign-in was started by a workspace's own domain (`signInUrlFor` → handoff), name that host. */
function tenantHostOf(next: string): string | null {
  if (!next.startsWith("/auth/handoff?")) return null;
  const host = new URLSearchParams(next.slice("/auth/handoff?".length)).get("host")?.trim().toLowerCase() ?? "";
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
}

export default function LoginClient() {
  const params = useSearchParams();
  const router = useRouter();
  const next = safeNext(params.get("next"));
  const urlError = params.get("error");
  const tenantHost = tenantHostOf(next);
  // Phones show the benefits card under the email step only (MobileAccount frames 1–2).
  const [step, setStep] = useState<"email" | "code">("email");
  const onStepChange = useCallback((s: "email" | "code") => setStep(s), []);

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="grid w-full min-w-0 max-w-[480px] lg:max-w-[1040px] lg:grid-cols-[480px_minmax(0,1fr)] lg:overflow-hidden lg:rounded-2xl lg:border lg:border-border lg:bg-surface lg:shadow-(--shadow-sm)">
        <section aria-label="Sign in" className="min-w-0 py-2 lg:px-10 lg:py-10">
          <SignInForm
            variant="page"
            next={next}
            urlError={urlError}
            message={tenantHost ? (
              <>Sign in to read <strong className="font-semibold text-text break-words">{tenantHost}</strong>. You&apos;ll go straight back to it.</>
            ) : undefined}
            onSignedIn={() => router.push(next)}
            onStepChange={onStepChange}
          />
          {step === "email" && <Benefits className="mt-8 lg:hidden" />}
        </section>
        <LoginVignette className="hidden lg:flex" />
      </div>
    </div>
  );
}
