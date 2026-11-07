"use client";

import { Badge, Icon, Tooltip } from "@/components/ui";

/** Types and small pieces shared by Admin → AI → Requests (backend/app/routers/admin_ai_log.py). */

export type ActorKind = "user" | "api" | "system" | "public";
export type Actor = ActorKind | "test";
export type OutcomeKind = "ok" | "error" | "limit" | "refused";

export interface Who {
  kind: ActorKind; actor: Actor; name: string; sub: string | null; user_id: string | null; email: string | null;
  test: boolean; test_reason: string | null; test_reason_label: string | null; job: string | null; app: string | null;
}

export interface ConvCard {
  conversation_id: string; title: string; label: string | null; feature: string | null; kind: string | null; features: string[];
  who: Who; workspace_id: string | null; workspace_name: string | null; scope_label: string | null; turns: number;
  first_ts: string | null; last_ts: string | null; cost_usd: number; tokens_in: number; tokens_out: number;
  outcomes: Partial<Record<OutcomeKind, number>>; has_error: boolean; content: boolean; via: string | null;
}

export interface Citation {
  label?: string; n?: number; title?: string; url?: string; web_url?: string; kind?: string; slug?: string;
  subtitle?: string; moment?: string; quote?: string; page?: string; id?: string;
}

export interface ContextItem { kind?: string; title?: string; id?: string; url?: string; slug?: string; subtitle?: string; label?: string }

export interface Turn {
  request_id: string; ts: string | null; feature: string | null; feature_label: string | null; kind: string | null; label: string | null;
  who: Who; via: string | null; site: string | null; workspace_id: string | null; workspace_name: string | null;
  scope_label: string | null; slug: string | null; page_title: string | null; model: string | null; calls: number | null;
  tokens: { input: number; output: number; cache_read: number; cache_write: number; prompt: number };
  cost_usd: number; latency_ms: number | null; ttft_ms: number | null; outcome: string | null; outcome_kind: OutcomeKind;
  stop_reason: string | null; error_code: string | null; limit_reason: string | null; content: boolean;
  input: string | null; input_truncated: boolean; selection: string | null; output: string | null; output_truncated: boolean;
  output_format: "markdown" | "text" | "json"; citations: Citation[];
  context: { summary: string; items: ContextItem[]; more: number } | null;
  description: string | null; results: Record<string, unknown> | null; actions: string[] | null;
}

export interface Conversation extends ConvCard { turns_list: Turn[] }

export type LogAudience = "real" | "system" | "public" | "test" | "all";
export type Counts = Record<"user" | "api" | "system" | "public" | "test" | "real" | "all" | "live", number>;

export const LOG_AUDIENCES: { value: LogAudience; label: string }[] = [
  { value: "real", label: "Real users" },
  { value: "system", label: "System" },
  { value: "public", label: "Public" },
  { value: "test", label: "Test & internal" },
  { value: "all", label: "All" },
];

export const OUTCOMES: { value: OutcomeKind; label: string }[] = [
  { value: "ok", label: "Answered" }, { value: "error", label: "Error" }, { value: "limit", label: "Limited" }, { value: "refused", label: "Refused" },
];

const ACTOR: Record<Actor, { label: string; tone: "neutral" | "info" | "success" | "warning" | "danger"; icon: string }> = {
  user: { label: "Person", tone: "success", icon: "user" },
  api: { label: "AI app", tone: "info", icon: "sparkle" },
  system: { label: "System", tone: "neutral", icon: "server" },
  public: { label: "Public", tone: "neutral", icon: "globe" },
  test: { label: "Test & internal", tone: "warning", icon: "bug" },
};

/** Person / AI app / System / Public / Test & internal; a test row says why on hover and focus. */
export function ActorBadge({ who, size = "sm" }: { who: Pick<Who, "actor" | "test" | "test_reason_label">; size?: "sm" | "md" }) {
  const a = ACTOR[who.test ? "test" : who.actor] ?? ACTOR.user;
  const badge = <Badge size={size} tone={a.tone} icon={a.icon}>{a.label}</Badge>;
  if (!who.test || !who.test_reason_label) return badge;
  return <Tooltip content={who.test_reason_label} focusable>{badge}</Tooltip>;
}

/** A round initial (or a glyph for jobs and visitors). */
export function WhoMark({ who, size = 28 }: { who: Pick<Who, "kind" | "name">; size?: number }) {
  const glyph = who.kind === "system" ? "server" : who.kind === "public" ? "globe" : null;
  const initial = (who.name || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span aria-hidden className="inline-grid shrink-0 place-items-center rounded-full border border-border bg-surface-inset text-micro font-semibold text-text-secondary"
      style={{ width: size, height: size }}>
      {glyph ? <Icon name={glyph} size={Math.round(size * 0.5)} /> : initial}
    </span>
  );
}

/** A small pill for the scope a question was asked in ("Ask Senseloaf", "This page: Roadmap"). */
export function ScopeChip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className="inline-flex max-w-[16rem] items-center gap-1 truncate rounded-full bg-accent-soft px-2 py-0.5 text-micro font-medium text-accent-text">
      <Icon name="search" size={11} /><span className="truncate">{children}</span>
    </span>
  );
}

/** A date for a transcript line: "7 Nov, 10:42". */
export function stamp(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** A person filter: what the API gets (an account id, or text) and what the chip says. */
export interface PersonFilter { value: string; label: string }
export function personFilterOf(who: Who): PersonFilter | null {
  if (who.user_id) return { value: who.user_id, label: who.name || who.email || "Person" };
  if (who.kind === "system" && who.job) return { value: who.job, label: who.job };
  return null;
}
