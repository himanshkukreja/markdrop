"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Field, Input, Textarea, cx } from "@/components/ui";
import { StatTile } from "@/components/kit/StatTile";
import { isUnauthorized, useOnUnauthorized } from "../shared";
import { emailApi, type AudienceResponse, type AudienceSpec } from "./api";
import { AUDIENCES, Section, num, useDebounced } from "./bits";

/** Live audience counts (after exclusions) for a spec, debounced, keeping the last answer while updating. */
export function useAudienceCount(token: string, spec: AudienceSpec, campaignId: string | null) {
  const onUnauthorized = useOnUnauthorized();
  const key = JSON.stringify([spec, campaignId]);
  const dkey = useDebounced(key, 450);
  const [data, setData] = useState<AudienceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const [s, cid] = JSON.parse(dkey) as [AudienceSpec, string | null];
    setLoading(true);
    emailApi.audience(token, s, cid)
      .then((r) => { if (!cancelled) { setData(r); setError(null); } })
      .catch((e) => { if (isUnauthorized(e)) onUnauthorized(); else if (!cancelled) setError(e instanceof Error ? e.message : "Count failed"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, dkey, nonce, onUnauthorized]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading: loading || dkey !== key, refresh };
}

export default function AudiencePicker({ token, spec, onChange, campaignId, readOnly }: {
  token: string; spec: AudienceSpec; onChange: (s: AudienceSpec) => void; campaignId: string | null; readOnly?: boolean;
}) {
  const { data, error, loading } = useAudienceCount(token, spec, campaignId);
  const c = data?.count;
  const set = (patch: Partial<AudienceSpec>) => onChange({ ...spec, ...patch });
  const existing = (data?.existing ?? 0) > 0;
  const needsDays = spec.kind === "recent" || spec.kind === "active";
  const needsMin = spec.kind === "with_documents" || spec.kind === "with_artifacts";

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Section id="email-audience" label="Audience" title="Who gets it">
        <fieldset className="min-w-0" disabled={readOnly}>
          <legend className="md-visually-hidden">Audience</legend>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {AUDIENCES.map((a) => {
              const on = spec.kind === a.kind;
              const n = data?.presets[a.kind];
              return (
                <label
                  key={a.kind}
                  className={cx(
                    "flex min-h-16 min-w-0 cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-border-focus",
                    on ? "border-accent bg-accent-soft" : "border-border bg-surface-inset hover:border-border-strong",
                    readOnly && "cursor-default opacity-80",
                  )}
                >
                  <input type="radio" name="email-audience" value={a.kind} checked={on} onChange={() => set({ kind: a.kind })} className="mt-0.5 size-5 shrink-0 accent-(--color-accent)" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className={cx("text-body-strong", on ? "text-accent-text" : "text-text")}>{a.label}</span>
                      {n !== undefined && a.kind !== "custom" && <span className="shrink-0 font-mono text-micro tabular-nums text-text-secondary">{num(n)}</span>}
                    </span>
                    <span className="block text-caption text-text-secondary">{a.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {(needsDays || needsMin || spec.kind === "custom") && (
          <div className="mt-4 flex flex-col gap-3">
            {needsDays && (
              <Field label={spec.kind === "recent" ? "Joined in the last N days" : "Active in the last N days"}>
                <Input type="number" min={1} max={3650} value={spec.days ?? 30} readOnly={readOnly} className="max-w-32"
                  onChange={(e) => set({ days: Math.max(1, Math.min(3650, Number(e.target.value) || 1)) })} />
              </Field>
            )}
            {needsMin && (
              <Field label={spec.kind === "with_documents" ? "At least N documents" : "At least N files"}>
                <Input type="number" min={1} max={1000} value={spec.min ?? 1} readOnly={readOnly} className="max-w-32"
                  onChange={(e) => set({ min: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })} />
              </Field>
            )}
            {spec.kind === "custom" && (
              <Field label="Addresses (comma, space or one per line)"
                hint="Matched to accounts for names and counts; addresses without an account get empty merge data (fallbacks apply). Unsubscribed and suppressed addresses are always skipped.">
                <Textarea mono rows={6} readOnly={readOnly} spellCheck={false} className="text-caption" value={spec.emails ?? ""}
                  placeholder={"ana@example.com\nbo@example.com"} onChange={(e) => set({ emails: e.target.value })} />
              </Field>
            )}
          </div>
        )}
      </Section>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-live="polite">
        <StatTile size="md" label={existing ? "Will receive · new" : "Will receive"} loading={!c} value={c ? num(c.eligible) : "—"} caption={loading ? "updating…" : "after exclusions"} />
        <StatTile size="md" label="Unsubscribed" loading={!c} value={c ? num(c.unsubscribed) : "—"} caption="always excluded" />
        <StatTile size="md" label="Bounced · suppressed" loading={!c} value={c ? num(c.suppressed) : "—"} caption="always excluded" />
        {spec.kind === "custom" ? (
          <StatTile size="md" label="Invalid · duplicate" loading={!c} value={c ? `${num(c.invalid)} · ${num(c.duplicates)}` : "—"} caption="skipped" />
        ) : existing ? (
          <StatTile size="md" label="Already in campaign" loading={!c} value={c ? num(c.already) : "—"} caption="not sent again" />
        ) : (
          <StatTile size="md" label="Duplicates" loading={!c} value={c ? num(c.duplicates) : "—"} caption="folded" />
        )}
      </div>
      {c && c.sample.length > 0 && (
        <p className="min-w-0 break-words text-caption text-text-secondary">
          <span className="text-text-muted">Sample · </span>
          {c.sample.join(", ")}{c.eligible > c.sample.length ? ` … + ${num(c.eligible - c.sample.length)} more` : ""}
        </p>
      )}
      {error && <Alert tone="danger" title="Count failed">{error}</Alert>}
    </div>
  );
}
