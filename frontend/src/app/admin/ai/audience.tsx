"use client";

import { Select } from "@/components/ui";
import { plural } from "../shared";
import { usd } from "./common";

/** Who an Admin → AI view counts (services/ai_log.AUDIENCES). Every call is classified when it is
 *  recorded: a person in the app, an AI app (MCP), a system job, a public visitor, or test/internal
 *  traffic (test harness, test domains, internal accounts and addresses). */

export type UsageAudience = "live" | "real" | "system" | "public" | "test" | "all";
export const USAGE_AUDIENCES: { value: UsageAudience; label: string }[] = [
  { value: "live", label: "All but tests" },
  { value: "real", label: "Real users" },
  { value: "system", label: "System" },
  { value: "public", label: "Public" },
  { value: "test", label: "Test & internal" },
  { value: "all", label: "Everything" },
];

export interface LeftOut { calls: number; test: number; cost_usd: number }

export function AudienceSelect({ value, onChange, className }: { value: UsageAudience; onChange: (v: UsageAudience) => void; className?: string }) {
  return (
    <Select aria-label="Who to count" value={value} className={className} onChange={(e) => onChange(e.target.value as UsageAudience)}
      options={USAGE_AUDIENCES} />
  );
}

/** "Excluding 37 test/internal calls ($0.42)", when the filter leaves anything out. */
export function LeftOutNote({ audience, leftOut }: { audience: UsageAudience; leftOut: LeftOut | null | undefined }) {
  if (!leftOut || leftOut.calls <= 0) return null;
  const text = audience === "live"
    ? `Excluding ${plural(leftOut.calls, "test/internal call")} (${usd(leftOut.cost_usd)})`
    : `Excluding ${plural(leftOut.calls, "call")} outside this filter (${usd(leftOut.cost_usd)})${leftOut.test ? `, ${leftOut.test.toLocaleString("en")} of them test/internal` : ""}`;
  return <p className="text-caption text-text-muted" data-testid="ai-left-out">{text}</p>;
}
