/**
 * Client for the email campaign admin API (`/api/v1/admin/email/*`, backend routers/admin_email.py).
 * Field names are the API's (snake_case). A 401 throws Error("UNAUTHORIZED") like every admin call,
 * so `isUnauthorized` + the shared sign-out hook work unchanged.
 */
import { API_BASE, ApiError } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CampaignStatus = "draft" | "scheduled" | "sending" | "paused" | "sent" | "cancelled";
export type MessageStatus = "queued" | "sending" | "sent" | "failed" | "skipped";
export type DisplayStatus = MessageStatus | "delivered" | "opened" | "clicked" | "bounced" | "complained";
export type AudienceKind =
  | "all" | "recent" | "active" | "with_documents" | "with_artifacts" | "never_published" | "vscode" | "workspace" | "custom";

export interface AudienceSpec { kind: AudienceKind; days?: number; min?: number; emails?: string }

export type BlockType = "hero" | "text" | "button" | "feature" | "callout" | "image" | "divider" | "html";
export interface Block { id: string; type: BlockType; [field: string]: string }
export interface BlocksDoc { layout: "blocks"; top_label: string; footer: string; blocks: Block[] }
export interface RawDoc { layout: "raw"; html: string; text: string; source?: string | null }
export type EmailDoc = BlocksDoc | RawDoc;

/** The editable part of a campaign (what create/patch/render/test take). */
export interface Draft {
  name: string;
  subject: string;
  subject_fallback: string | null;
  preheader: string | null;
  template: string;
  doc: EmailDoc;
  sender_id: string | null;
  audience: AudienceSpec;
  track_opens: boolean;
  track_clicks: boolean;
}

export interface Counts {
  total: number; queued: number; sending: number; sent: number; failed: number; skipped: number;
  opened: number; opens: number; clicked: number; clicks: number; unsubscribed: number;
  delivered: number; bounced: number; complained: number; stuck: number;
}

export interface SenderSnapshot { id?: string; from_name?: string | null; from_email?: string | null; reply_to?: string | null }

export interface CampaignSummary {
  id: string;
  legacy: boolean;
  legacy_status?: string;
  name: string;
  subject: string;
  subject_fallback?: string | null;
  preheader?: string | null;
  template?: string;
  layout?: "blocks" | "raw";
  sender_id?: string | null;
  sender?: SenderSnapshot | null;
  audience: AudienceSpec & { kind: string };
  track_opens: boolean;
  track_clicks: boolean;
  status: CampaignStatus;
  scheduled_at?: string | null;
  last_error?: string | null;
  created_by?: string | null;
  created_at: string | null;
  updated_at: string | null;
  queued_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  lock_until?: string | null;
  counts: Counts;
}
export interface Campaign extends CampaignSummary { doc: EmailDoc; legacy_html?: string }

export interface SenderCheck { level: "ok" | "warn" | "bad"; message: string }
export interface Sender {
  id: string; label: string; from_name: string; from_email: string; reply_to: string | null;
  is_default: boolean; source: "env" | "db"; check: SenderCheck;
}
export interface DomainsInfo { state: "ok" | "restricted" | "console" | "error"; message: string | null; checked_at: string | null; names: Record<string, string> }

export interface Setup {
  transport: "resend" | "console";
  tracking_base: string;
  site: string;
  batch: { size: number; gap_ms: number };
  worker: { enabled: boolean; running: boolean };
  webhooks: boolean;
  webhook_url: string;
  test_to: string;
  admin: string | null;
  domains: DomainsInfo;
  click_hosts: string[];
}
export interface Info { setup: Setup; senders: Sender[]; campaigns: CampaignSummary[] }

export interface MergeTagInfo { tag: string; label: string; hint: string; sample: string; url: boolean }
export interface TemplateInfo {
  id: string; name: string; kind: "blocks" | "raw"; description: string; subject: string;
  subject_fallback: string | null; preheader: string | null; doc: EmailDoc; audience: AudienceSpec;
}
export interface TemplatesResponse {
  templates: TemplateInfo[];
  tags: MergeTagInfo[];
  blocks: { labels: Record<BlockType, string>; fields: Record<BlockType, string[]> };
  default_footer: string;
}

export interface Problem { where: string; raw: string; message: string }
export interface Rendered {
  subject: string; preheader: string; html: string; text: string; unsubscribe_url: string;
  vars: Record<string, string>; as: { email: string; name: string | null; source: "sample" | "account" | "custom" };
  problems: Problem[];
}

export interface RecipientPreview {
  email: string; name: string | null; user_id: string | null; source: "account" | "custom"; meta: string; vars: Record<string, string>;
}

export interface AudienceCount {
  eligible: number; invalid: number; duplicates: number; unsubscribed: number; suppressed: number; already: number; sample: string[];
}
export interface AudienceResponse { count: AudienceCount; presets: Record<string, number>; existing: number }

export interface TickResult {
  campaign: CampaignSummary | null; sent_now: number; failed_now: { email: string; error: string }[];
  skipped_now: number; busy: boolean; done: boolean; transport: string; error: string | null;
}
export interface Progress { campaign: CampaignSummary; lease_held: boolean; worker: boolean; transport: string }

export interface EventRow { at: string; type: "open" | "click" | "unsubscribe" | "bounce" | "complaint" | "delivered"; email: string | null; url: string | null }
export interface Report {
  counts: Counts;
  timeline: { unit: "minute" | "hour" | "day"; points: { t: string; opens: number; clicks: number }[] };
  links: { url: string; clicks: number; people: number }[];
  events: EventRow[];
  webhooks: boolean;
  transport: string;
}

export interface MessageRow {
  id: string; email: string; name: string | null; user_id: string | null; status: MessageStatus; display_status: DisplayStatus;
  error: string | null; sent_at: string | null; delivered_at: string | null; bounced_at: string | null; complained_at: string | null;
  open_count: number; first_open_at: string | null; last_open_at: string | null; click_count: number;
  first_click_at: string | null; last_click_at: string | null; unsubscribed_at: string | null; created_at: string | null;
}
export type RecipientFilter = "all" | "opened" | "unopened" | "clicked" | "failed" | "skipped" | "queued" | "unsubscribed" | "bounced" | "delivered";

export interface Suppression { email: string; reason: "unsubscribed" | "bounced" | "complained" | "manual"; detail: string | null; created_at: string | null; updated_at: string | null }

// ── Transport ─────────────────────────────────────────────────────────────────

/** An API error with the server's extras (`expected` for the typed confirmation, `problems`). */
export class EmailApiError extends ApiError {
  expected?: string;
  problems?: Problem[];
}

async function req<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/admin/email${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new EmailApiError("Couldn't reach the API. Check your connection and retry.", 0);
  }
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { detail?: unknown; expected?: string; problems?: Problem[] } | null;
    const e = new EmailApiError(typeof j?.detail === "string" ? j.detail : `Request failed (${res.status})`, res.status);
    e.expected = j?.expected;
    e.problems = j?.problems;
    throw e;
  }
  return res.json() as Promise<T>;
}

const q = (o: Record<string, string | number | boolean | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const t = s.toString();
  return t ? `?${t}` : "";
};

export const emailApi = {
  info: (t: string) => req<Info>(t, "GET", "/info"),
  templates: (t: string) => req<TemplatesResponse>(t, "GET", "/templates"),
  render: (t: string, draft: Draft, asEmail?: string | null) => req<Rendered>(t, "POST", "/render", { ...draft, as_email: asEmail || null }),
  test: (t: string, draft: Draft, to?: string, asEmail?: string | null) =>
    req<{ ok: true; mode: string; to: string; as: string; from: string; subject: string; provider_id: string | null; bytes: number }>(
      t, "POST", "/test", { ...draft, to: to || null, as_email: asEmail || null }),
  audience: (t: string, audience: AudienceSpec, campaignId?: string | null) =>
    req<AudienceResponse>(t, "POST", "/audience", { audience, campaign_id: campaignId || null }),
  recipients: (t: string, query: string) => req<{ recipients: RecipientPreview[] }>(t, "GET", `/recipients${q({ q: query })}`),

  senders: (t: string, check = false) => req<{ senders: Sender[]; domains: DomainsInfo }>(t, "GET", `/senders${q({ check: check || undefined })}`),
  saveSender: (t: string, id: string | null, body: { label: string; from_name: string; from_email: string; reply_to: string; is_default: boolean }) =>
    req<{ sender: Sender; senders: Sender[] }>(t, id ? "PATCH" : "POST", id ? `/senders/${encodeURIComponent(id)}` : "/senders", body),
  deleteSender: (t: string, id: string) => req<{ ok: true }>(t, "DELETE", `/senders/${encodeURIComponent(id)}`),

  suppressions: (t: string, query = "") =>
    req<{ rows: Suppression[]; by_reason: Record<string, number>; unsubscribed_accounts: number }>(t, "GET", `/suppressions${q({ q: query })}`),
  addSuppressions: (t: string, emails: string) => req<{ added: number; invalid: number }>(t, "POST", "/suppressions", { emails }),
  removeSuppression: (t: string, email: string) => req<{ ok: true }>(t, "DELETE", `/suppressions/${encodeURIComponent(email)}`),

  create: (t: string, draft: Draft) => req<{ campaign: Campaign }>(t, "POST", "/campaigns", draft),
  get: (t: string, id: string) => req<{ campaign: Campaign; events: EventRow[] }>(t, "GET", `/campaigns/${encodeURIComponent(id)}`),
  update: (t: string, id: string, draft: Draft) => req<{ campaign: Campaign }>(t, "PATCH", `/campaigns/${encodeURIComponent(id)}`, draft),
  remove: (t: string, id: string) => req<{ ok: true }>(t, "DELETE", `/campaigns/${encodeURIComponent(id)}`),
  duplicate: (t: string, id: string) => req<{ campaign: Campaign }>(t, "POST", `/campaigns/${encodeURIComponent(id)}/duplicate`),
  queue: (t: string, id: string, confirm: string, scheduledAt?: string | null) =>
    req<{ added: number; campaign: CampaignSummary }>(t, "POST", `/campaigns/${encodeURIComponent(id)}/queue`, { confirm, scheduled_at: scheduledAt || null }),
  action: (t: string, id: string, action: "pause" | "resume" | "cancel" | "unschedule" | "send_now" | "retry", opts?: { failed?: boolean; stuck?: boolean }) =>
    req<{ campaign: CampaignSummary; requeued?: number; skipped?: number; removed?: number }>(
      t, "POST", `/campaigns/${encodeURIComponent(id)}/action`, { action, ...opts }),
  tick: (t: string, id: string) => req<TickResult>(t, "POST", `/campaigns/${encodeURIComponent(id)}/tick`),
  progress: (t: string, id: string) => req<Progress>(t, "GET", `/campaigns/${encodeURIComponent(id)}/progress`),
  report: (t: string, id: string) => req<Report>(t, "GET", `/campaigns/${encodeURIComponent(id)}/report`),
  messages: (t: string, id: string, o: { filter: RecipientFilter; q?: string; offset?: number; limit?: number }) =>
    req<{ rows: MessageRow[]; total: number; offset: number; limit: number }>(
      t, "GET", `/campaigns/${encodeURIComponent(id)}/recipients${q({ filter: o.filter, q: o.q, offset: o.offset, limit: o.limit })}`),
  async csv(t: string, id: string, filter: RecipientFilter, query: string): Promise<{ blob: Blob; filename: string }> {
    const res = await fetch(`${API_BASE}/api/v1/admin/email/campaigns/${encodeURIComponent(id)}/recipients${q({ filter, q: query, format: "csv" })}`, {
      headers: { Authorization: `Bearer ${t}` }, cache: "no-store",
    });
    if (res.status === 401) throw new Error("UNAUTHORIZED");
    if (!res.ok) throw new EmailApiError("Couldn't export the CSV.", res.status);
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename="([^"]+)"/.exec(cd);
    return { blob: await res.blob(), filename: m?.[1] || `recipients-${filter}.csv` };
  },
};

// ── Helpers shared by the screens ─────────────────────────────────────────────

export const newBlockId = () => Math.random().toString(36).slice(2, 10);

export function emptyBlock(type: BlockType, site = "https://markdrop.in"): Block {
  const id = newBlockId();
  switch (type) {
    case "hero": return { id, type, eyebrow: "", title: "A headline" };
    case "text": return { id, type, md: `Write something. **Bold**, *italic*, [links](${site}) and lists work.` };
    case "button": return { id, type, label: "Open your dashboard", url: "{{dashboard_url}}" };
    case "feature": return { id, type, tag: "New", title: "Feature title", md: "One or two sentences about it." };
    case "callout": return { id, type, eyebrow: "Today", title: "A short, punchy line.", label: "Try it", url: site };
    case "image": return { id, type, src: "", alt: "", href: "" };
    case "divider": return { id, type };
    case "html": return { id, type, html: '<p style="margin:0 0 16px">Custom HTML</p>' };
  }
}

export function draftFromTemplate(t: TemplateInfo, senderId: string | null): Draft {
  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return {
    name: `${t.name} · ${date}`,
    subject: t.subject,
    subject_fallback: t.subject_fallback,
    preheader: t.preheader,
    template: t.id,
    doc: JSON.parse(JSON.stringify(t.doc)) as EmailDoc,
    sender_id: senderId,
    audience: { days: 30, min: 1, emails: "", ...t.audience },
    track_opens: true,
    track_clicks: true,
  };
}

export function draftOf(c: Campaign): Draft {
  return {
    name: c.name,
    subject: c.subject,
    subject_fallback: c.subject_fallback ?? null,
    preheader: c.preheader ?? null,
    template: c.template || "newsletter",
    doc: c.doc,
    sender_id: c.sender_id ?? null,
    audience: { days: 30, min: 1, emails: "", ...c.audience } as AudienceSpec,
    track_opens: c.track_opens,
    track_clicks: c.track_clicks,
  };
}
