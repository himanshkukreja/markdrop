"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Skeleton } from "@/components/ui";
import { docsErrorMessage, getSiteTeam, roleSourceLabel, type SiteTeamResponse } from "@/lib/docsSites";
import { plural } from "../format";
import { useSite } from "../SiteContext";
import { PersonFace } from "./PeopleStack";
import { RoleBadge } from "./roles";

/**
 * Settings › People for someone who can't change roles: who works on this guide (everyone with a
 * Guides role on it, admins first), each with their role and where it comes from. Names and photos
 * only. A Guides admin changes roles.
 */
export function SiteTeam() {
  const { site } = useSite();
  const [data, setData] = useState<SiteTeamResponse | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await getSiteTeam(site.id));
      setError("");
    } catch (e) {
      setError(docsErrorMessage(e, "Couldn't load who works on this guide."));
    }
  }, [site.id]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <Alert tone="danger" actions={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>{error}</Alert>;
  if (!data) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading people">
        <Skeleton variant="rect" height={40} /><Skeleton variant="rect" height={40} />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-body-strong text-text">{plural(data.count, "person", "people")} {data.count === 1 ? "works" : "work"} on this guide</h3>
      <ul className="m-0 flex list-none flex-col rounded-lg border border-border px-3" aria-label="People on this guide">
        {data.people.map((p) => (
          <li key={p.user_id} className="flex min-w-0 items-center gap-3 border-t border-border py-2.5 first:border-t-0">
            <PersonFace person={p} size={28} />
            <div className="min-w-0 flex-1">
              <div className="ph-sensitive ph-mask truncate text-body-strong text-text" dir="auto" title={p.name}>
                {p.name}{p.you && <span className="font-normal text-text-muted"> (you)</span>}
              </div>
              <div className="text-[12.5px] text-text-muted">{roleSourceLabel(p.source)}</div>
            </div>
            <RoleBadge role={p.role} size="md" />
          </li>
        ))}
      </ul>
    </div>
  );
}

export default SiteTeam;
