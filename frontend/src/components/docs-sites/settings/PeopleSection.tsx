"use client";

import { Alert, Switch } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { roleLabel, roleSourceLabel } from "@/lib/docsSites";
import { aRole, RoleBadge } from "../people/roles";
import SitePeople from "../people/SitePeople";
import { useSite } from "../SiteContext";
import { LockedNote, SectionHeader, SettingsCard, SwitchRow, useWorkspaceName } from "./SettingsShell";
import { blurbOf } from "./sections";
import usePatch from "./usePatch";

/**
 * Settings › People and reviews: roles on this guide (admins give someone a different role here;
 * everyone else sees their own and where it comes from), and whether changes need a review.
 */
export default function PeopleSection() {
  const { site, canManagePeople, role } = useSite();
  const { patch, saving, error, setError, locked } = usePatch();
  const ws = useWorkspaceName();
  const s = site.settings;

  return (
    <>
      <SectionHeader title="People and reviews" description={blurbOf("people")} />
      <LockedNote />
      {error && <Alert tone="danger" onDismiss={() => setError("")}>{error}</Alert>}

      {canManagePeople ? (
        <SettingsCard
          id="people"
          title="People"
          description={site.workspace_id ? "Roles come from the workspace unless you change them here." : undefined}
          aside={<RoleBadge role={role} title={`Your role: ${roleSourceLabel(site.your_role_source) || roleLabel(role)}`} />}
        >
          <SitePeople />
        </SettingsCard>
      ) : (
        <SettingsCard id="people" title="Your role" aside={<RoleBadge role={role} size="md" />}>
          <p className="text-body text-text-secondary">
            {site.your_role_source === "site"
              ? `You're ${aRole(role)} on this guide only.`
              : `You're ${aRole(role)} on ${ws ?? "this workspace"}'s guides.`}{" "}
            A Guides admin gives people their roles.
          </p>
        </SettingsCard>
      )}

      <SettingsCard id="review" title="Reviews">
        <SwitchRow
          title="Require a review before publishing"
          hint={<>Editors send changes to a reviewer; admins can still publish. Reviewers approve other people&apos;s changes, never their own. <ReadMore topic="studioReviews" /></>}
        >
          <Switch
            aria-label="Require a review before publishing"
            checked={s.review.required}
            disabled={locked || saving === "review"}
            onChange={(e) => void patch("review", { settings: { review: { required: e.target.checked } } }, e.target.checked ? "Editors' changes now need an approval." : "Editors publish directly now.")}
          />
        </SwitchRow>
      </SettingsCard>
    </>
  );
}
