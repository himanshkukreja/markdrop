"use client";

/**
 * "Who can open this page" in the editor's Page tab: Inherit (its group's rule, else everyone who
 * can read the guide) · Public · one of the guide's rules (team, people and domains, a password).
 * It is the page's frontmatter `access` (frontend/src/docs/access.mjs), so it reaches readers with
 * the next publish, like every other edit; who a rule lets in is managed in Settings › Private pages
 * and changes within a minute.
 */
import { useId } from "react";
import { Badge, Icon, Select } from "@/components/ui";
import { ruleLabel, ruleWho, type AccessRule } from "@/lib/guidePrivate";

export interface PageAccessInfo {
  rules: AccessRule[];
  /** The page's sidebar group and that group's rule, if any. */
  group: string | null;
  groupRule: string | null;
  /** Settings › Private pages. */
  settingsHref: string;
  /** The guide is password or members-only as a whole: a page can't be made public in it. */
  guidePrivate: boolean;
}

export function PageAccess({ value, info, readOnly, isHome, onChange }: {
  value: string | null;
  info: PageAccessInfo;
  readOnly: boolean;
  isHome: boolean;
  onChange: (access: string | null) => void;
}) {
  const uid = useId();
  const byId = (id: string | null) => (id ? info.rules.find((r) => r.id === id) : undefined);
  const effective = value === "public" ? null : value || info.groupRule;
  const rule = byId(effective);
  const unknown = !!effective && !rule;
  const groupLabel = info.groupRule ? ruleLabel(byId(info.groupRule) ?? { kind: "people", name: info.groupRule }) : null;
  const options = [
    { value: "", label: groupLabel ? `Inherit: ${groupLabel}` : info.guidePrivate ? "Inherit (the guide's readers)" : "Inherit: anyone (public)" },
    ...(info.guidePrivate ? [] : [{ value: "public", label: "Public: anyone" }]),
    ...info.rules.map((r) => ({ value: r.id, label: ruleLabel(r) })),
    ...(value && value !== "public" && !byId(value) ? [{ value, label: `${value} (not a rule on this guide)` }] : []),
  ];
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3" data-testid="page-access">
      <label htmlFor={`${uid}-access`} className="flex items-center gap-1.5 text-[13px] font-medium text-text">
        <Icon name="eyeOff" size={13} className="text-text-muted" />
        Who can open this page
      </label>
      <Select
        id={`${uid}-access`}
        value={value ?? ""}
        disabled={readOnly || isHome}
        onChange={(e) => onChange(e.target.value || null)}
        options={options}
      />
      {isHome ? (
        <p className="text-[12px] text-text-muted">The home page is always open to the guide&apos;s readers. Use a private section for part of it.</p>
      ) : unknown ? (
        <p className="text-[12px] text-danger">No rule {effective} on this guide: the page stays locked for everyone. Pick another.</p>
      ) : rule ? (
        <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-text-muted">
          <Badge size="sm" icon="lock">{ruleLabel(rule)}</Badge>
          {!value && info.groupRule ? `From the ${info.group} group. ` : ""}{ruleWho(rule)} {rule.nav === "show" ? "Listed in the navigation with a lock." : "Hidden from the navigation."}
        </p>
      ) : (
        <p className="text-[12px] text-text-muted">Everyone who can read the guide. In search, llms.txt and Ask AI.</p>
      )}
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
        <span className="text-text-muted">Applies when you publish.</span>
        <a className="md-focus rounded font-semibold text-accent-text hover:underline" href={`${info.settingsHref}#preview`}>Preview as</a>
        <a className="md-focus rounded font-semibold text-accent-text hover:underline" href={info.settingsHref}>Manage rules</a>
      </p>
    </div>
  );
}
