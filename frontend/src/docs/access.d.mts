/** Types for access.mjs. */
export type RuleKind = "members" | "people" | "password" | "encrypted";
export interface AccessRule {
  id: string;
  kind: RuleKind | "unknown";
  name: string;
  nav: "show" | "hide";
}
export interface SiteAccess {
  rules: Map<string, AccessRule>;
}
export declare const RULE_ID: RegExp;
export declare const KINDS: RuleKind[];
export declare const MEMBERS: "members";
export declare const PUBLIC: "public";
export declare const VARIANT_SEGMENT: "x-access";
export declare const LOCKED: "private-locked";
export declare const PRIVATE: "private";
export declare const MAX_SECTION_RULES: number;
export declare function readAccess(site: unknown): SiteAccess;
export declare function ruleOf(access: SiteAccess, id: string): AccessRule;
export declare function accessValue(v: unknown): string | undefined;
export declare function effectiveRule(pageValue: unknown, groupValue: unknown): string | undefined;
export declare function sectionRule(attrs: Record<string, string>): string;
export declare function splitPrivate(body: string, reveal?: Set<string> | null, key?: string): { body: string; rules: string[]; hidden: number };
export declare function hasPrivate(body: string): boolean;
export declare function ruleSets(rules: string[]): string[][];
export declare function ruleSetKey(set: Iterable<string>): string;
export declare function parseVariant(segments: string[]): { rules: string[]; path: string } | null;
export declare function lockText(rule: AccessRule): { title: string; body: string };
