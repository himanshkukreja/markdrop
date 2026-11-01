/**
 * Private pages and sections of a guide (backend routers/docs_page_access.py): rules and who they
 * let in, each group's rule, access requests, the audit log, preview-as. Free on every guide.
 */
import { API_BASE, getToken } from "@/lib/api";
import { DocsApiError } from "@/lib/docsSites";

export type RuleKind = "members" | "people" | "password";

export interface AccessRule {
  id: string;
  kind: RuleKind;
  name: string;
  nav: "show" | "hide";
  builtin: boolean;
  /** Pages and sections (drafts) that use it. */
  pages: number;
  emails_count?: number;
  domains_count?: number;
  /** Admins only. */
  emails?: string[];
  domains?: string[];
  has_password?: boolean;
  pv?: number;
}

export interface AccessRequest {
  id: string;
  email: string;
  rule: string | null;
  note: string;
  path: string;
  status: "pending" | "approved" | "declined";
  created_at: string | null;
  decided_at: string | null;
}

export interface PrivateState {
  rules: AccessRule[];
  groups: Record<string, string>;
  /** The edge holds the current who-lists (false for a few seconds after a change). */
  enforced: boolean;
  version: number;
  protected_pages: number;
  private_sections: number;
  warnings: Array<{ from: string; to: string; rule: string }>;
  unknown_rules: string[];
  is_admin: boolean;
  requests_pending: number;
  requests?: AccessRequest[];
}

export interface PreviewRow {
  path: string;
  title: string;
  rule: string | null;
  group: string | null;
  open: boolean;
  unknown_rule: boolean;
  sections: Array<{ rule: string; open: boolean; unknown_rule: boolean }>;
}

export interface Preview {
  as: "public" | "member" | "email" | "password";
  email: string | null;
  pages: PreviewRow[];
  open: number;
  locked: number;
}

export interface AuditEntry {
  at: string;
  actor: string | null;
  actor_name: string | null;
  action: string;
  rule: string | null;
  detail: Record<string, unknown>;
}

async function call<T>(siteId: string, path: string, init?: { method?: string; json?: unknown }): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/docs-sites/${encodeURIComponent(siteId)}/private${path}`, {
      method: init?.method ?? "GET",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
  } catch {
    throw new DocsApiError("Couldn't reach Markdrop. Check your connection and try again.", 0);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const d = body?.detail;
    const msg = typeof d === "string" ? d : typeof d?.message === "string" ? d.message : `Request failed (${res.status})`;
    throw new DocsApiError(msg, res.status, body);
  }
  return body as T;
}

export const getPrivate = (siteId: string) => call<PrivateState>(siteId, "");

export const createRule = (siteId: string, body: { kind: "people" | "password"; name: string; nav?: "show" | "hide"; emails?: string[]; domains?: string[]; password?: string }) =>
  call<{ rule: AccessRule; private: PrivateState }>(siteId, "/rules", { method: "POST", json: body });

export const updateRule = (siteId: string, ruleId: string, body: Partial<{ name: string; nav: "show" | "hide"; emails: string[]; domains: string[]; password: string }>) =>
  call<{ rule: AccessRule; private: PrivateState }>(siteId, `/rules/${encodeURIComponent(ruleId)}`, { method: "PATCH", json: body });

export const deleteRule = (siteId: string, ruleId: string) => call<{ private: PrivateState }>(siteId, `/rules/${encodeURIComponent(ruleId)}`, { method: "DELETE" });

export const putGroups = (siteId: string, groups: Record<string, string | null>) => call<{ private: PrivateState }>(siteId, "/groups", { method: "PUT", json: { groups } });

export const decideRequest = (siteId: string, requestId: string, decision: "approve" | "decline", rule?: string) =>
  call<{ note: string | null; private: PrivateState }>(siteId, `/requests/${encodeURIComponent(requestId)}/${decision}`, { method: "POST", json: rule ? { rule } : {} });

export const signOutReaders = (siteId: string) => call<{ private: PrivateState }>(siteId, "/sign-out-readers", { method: "POST" });

export const previewAs = (siteId: string, as: Preview["as"], opts: { email?: string; rules?: string[] } = {}) => {
  const q = new URLSearchParams({ as, ...(opts.email ? { email: opts.email } : {}), ...(opts.rules?.length ? { rules: opts.rules.join(",") } : {}) });
  return call<Preview>(siteId, `/preview?${q}`);
};

export const getAudit = (siteId: string) => call<{ entries: AuditEntry[] }>(siteId, "/audit");

export { ACTIONS, ruleLabel, ruleWho, splitPeople } from "@/components/docs-sites/privateModel";
