"use client";

import { Badge, cx } from "@/components/ui";
import { GA_ID, POSTHOG_KEY, POSTHOG_PROXY } from "@/lib/analyticsConfig";
import type { PhStatus } from "./api";
import { EYEBROW } from "./bits";

type Step = { env: string; title: string; example: string; scope: "public" | "server" | "secret"; set: boolean; where: React.ReactNode; optional?: boolean };

/**
 * Not configured: what to set, where to find each value, and what is already in place. The public
 * project key and GA ID are compiled into the site (lib/analyticsConfig.ts); the personal API key
 * and project id live only in the API's environment.
 */
export function SetupCard({ status, compact }: { status: PhStatus; compact?: boolean }) {
  const ingest = `${status.region}.i.posthog.com`;
  const steps: Step[] = [
    {
      env: "POSTHOG_KEY",
      title: "Create a PostHog project",
      example: "phc_…",
      scope: "public",
      set: !!POSTHOG_KEY,
      where: (
        <>Sign up at posthog.com (pick the <b>US</b> or <b>EU</b> cloud), create a project for markdrop.in, then put <b>Project settings → General → Project API key</b> in <code className="font-mono">frontend/src/lib/analyticsConfig.ts</code>.</>
      ),
    },
    {
      env: "MARKDROP_POSTHOG_HOST",
      title: "Region",
      example: status.ui_host || "https://us.posthog.com",
      scope: "server",
      set: true,
      where: <>The cloud you picked, <code className="font-mono">https://us.posthog.com</code> (the default) or <code className="font-mono">https://eu.posthog.com</code>. It decides where this API reads from.</>,
    },
    {
      env: "MARKDROP_POSTHOG_PROJECT_ID",
      title: "Project id",
      example: "12345",
      scope: "server",
      set: !status.missing.includes("MARKDROP_POSTHOG_PROJECT_ID"),
      where: <><b>Project settings → General → Project ID</b> (the number in /project/<b>12345</b>/ URLs).</>,
    },
    {
      env: "MARKDROP_POSTHOG_PERSONAL_API_KEY",
      title: "Personal API key for this dashboard",
      example: "phx_…",
      scope: "secret",
      set: !status.missing.includes("MARKDROP_POSTHOG_PERSONAL_API_KEY"),
      where: (
        <><b>Account settings → Personal API keys → Create</b>, limited to this project, with the scopes <b>query:read</b>, <b>person:read</b> and <b>session_recording:read</b>. Replays are fetched by our API and played here, so no sharing scopes. API environment only, never in the frontend.</>
      ),
    },
    {
      env: "GA_ID",
      title: "Google Analytics 4 (optional)",
      example: "G-XXXXXXXXXX",
      scope: "public",
      optional: true,
      set: !!GA_ID,
      where: <>analytics.google.com → <b>Admin → Data streams → Web → Measurement ID</b>, in <code className="font-mono">lib/analyticsConfig.ts</code>. Leave Google signals off.</>,
    },
  ];
  const done = steps.filter((s) => s.set).length;

  return (
    <section aria-labelledby="journeys-setup" className="rounded-xl border border-dashed border-accent bg-accent-soft">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-dashed border-accent px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <p className={EYEBROW}>setup · {done}/{steps.length} done</p>
          <h2 id="journeys-setup" className="mt-1 text-h3 text-text">Connect PostHog to see journeys and replays here</h2>
        </div>
        {POSTHOG_KEY ? <Badge tone="success">capture on</Badge> : <Badge tone="neutral">capture off</Badge>}
      </div>
      {!compact && (
        <p className="max-w-prose px-4 pt-4 text-body text-text-secondary sm:px-5">
          The site already sends events to PostHog (with consent), but this section reads them back with a personal API key that
          only the API holds. Add the server values to the API&apos;s <code className="font-mono">.env</code> and restart it; nothing in the
          frontend needs a redeploy.
        </p>
      )}
      <ol className="flex flex-col gap-4 px-4 py-4 sm:px-5">
        {steps.map((s, i) => (
          <li key={s.env} className="flex gap-3">
            <span
              aria-hidden
              className={cx(
                "grid size-7 shrink-0 place-items-center rounded-md border font-mono text-caption",
                s.set ? "border-success text-success" : "border-border-strong text-text-secondary",
              )}
            >
              {s.set ? "✓" : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-body-strong text-text">{s.title}</span>
                <Badge size="sm" tone={s.scope === "secret" ? "danger" : s.scope === "server" ? "info" : "neutral"}>{s.scope === "secret" ? "server secret" : s.scope === "server" ? "server" : "public"}</Badge>
                {s.set ? <Badge size="sm" tone="success">set</Badge> : s.optional ? <Badge size="sm" tone="neutral">optional</Badge> : <Badge size="sm" tone="warning">missing</Badge>}
                <span className="md-visually-hidden">{s.set ? "Done." : "Not done."}</span>
              </div>
              <code className="mt-1 block break-all font-mono text-caption text-accent-text">{s.env}={s.example}</code>
              <p className="mt-1 max-w-prose text-caption text-text-secondary">{s.where}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="max-w-prose px-4 pb-4 text-caption text-text-secondary sm:px-5">
        Also turn on <b>cookieless mode</b> in PostHog project settings: visitors who haven&apos;t accepted cookies are counted that way, and
        their events are dropped without it.
      </p>
      <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-dashed border-accent px-4 py-3 font-mono text-micro text-text-secondary sm:px-5">
        <span>proxy · {POSTHOG_PROXY}/* → {ingest}</span>
        <span>api · {status.ui_host}</span>
        <span>replays · consent only, inputs masked, never documents or /admin</span>
      </div>
    </section>
  );
}
