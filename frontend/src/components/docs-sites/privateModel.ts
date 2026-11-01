/**
 * The pure half of private pages in the studio (lib/guidePrivate.ts, settings/PrivateSection.tsx,
 * editor/PageAccess.tsx): how a rule reads, what one box of emails and @domains holds.
 * No imports, so node's type stripping can test it (privateModel.test.mjs).
 */

export interface RuleLike {
  kind: "members" | "people" | "password";
  name: string;
  emails_count?: number;
  domains_count?: number;
  domains?: string[];
  has_password?: boolean;
}

/** "Team members", "Northwind", "Partners (password)". */
export function ruleLabel(r: Pick<RuleLike, "kind" | "name">): string {
  if (r.kind === "members") return "Team members";
  if (r.kind === "password") return `${r.name} (password)`;
  return r.name;
}

/** Who a rule lets in, in a sentence. */
export function ruleWho(r: RuleLike): string {
  if (r.kind === "members") return "Everyone on this guide's team (any Guides role). Team members also open every other private page.";
  if (r.kind === "password") return r.has_password ? "Anyone with the password." : "Set a password.";
  const parts: string[] = [];
  if (r.domains_count) parts.push(`anyone at ${r.domains?.length ? r.domains.map((d) => `@${d}`).join(", ") : `${r.domains_count} domain${r.domains_count === 1 ? "" : "s"}`}`);
  if (r.emails_count) parts.push(`${r.emails_count} ${r.emails_count === 1 ? "person" : "people"}`);
  return parts.length ? `${parts.join(" and ")}, signing in with their email.` : "Nobody yet: add people or a domain.";
}

/** Emails and @domains typed into one box: "jane@x.com, @northwind.com" (a bare domain counts too). */
export function splitPeople(text: string): { emails: string[]; domains: string[] } {
  const emails: string[] = [];
  const domains: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if (t.startsWith("@")) domains.push(t.slice(1));
    else if (t.includes("@")) emails.push(t);
    else domains.push(t);
  }
  return { emails: [...new Set(emails)], domains: [...new Set(domains)] };
}

/** The audit log's verbs. */
export const ACTIONS: Record<string, string> = {
  rule_created: "created the rule",
  rule_updated: "changed the rule",
  rule_deleted: "deleted the rule",
  groups_updated: "changed group access",
  request_approved: "approved a request",
  request_declined: "declined a request",
  readers_signed_out: "signed every reader out",
};
