"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Button, Icon } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { getImportedRedirects } from "@/lib/guideDomains";
import { num, plural } from "../format";
import RedirectsEditor from "../RedirectsEditor";
import { useSite } from "../SiteContext";
import { LockedNote, SectionHeader, SettingsCard } from "./SettingsShell";
import { SECTIONS } from "./sections";
import usePatch from "./usePatch";

const SHOWN = 10;

/**
 * Settings › Redirects: the guide's own (edited as rows, each with why it's there: a page moved, or
 * added here) and, for an imported guide, the old GitBook addresses the import brought (read-only;
 * the build writes both, the guide's own winning on the same address).
 */
export default function RedirectsSection() {
  const { site } = useSite();
  const { patch, saving, error, setError, locked } = usePatch();
  const redirects = site.settings.redirects ?? [];
  const [imported, setImported] = useState<{ count: number; redirects: Array<{ from: string; to: string }> } | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    if (site.source.kind !== "gitbook") return;
    getImportedRedirects(site.id).then(setImported).catch(() => setImported(null));
  }, [site.id, site.source.kind]);

  const shown = imported ? (all ? imported.redirects : imported.redirects.slice(0, SHOWN)) : [];

  return (
    <>
      <SectionHeader title="Redirects" description={SECTIONS[5].blurb} />
      <LockedNote />
      {error && <Alert tone="danger" onDismiss={() => setError("")}>{error}</Alert>}

      <SettingsCard
        id="redirects"
        title="Your redirects"
        description={<>Moved or renamed a page? Send its old address to the new one, so links people saved keep working. Changes go live at the next publish. <ReadMore topic="studioRedirects" /></>}
        aside={redirects.length ? <Badge size="sm">{num(redirects.length)}</Badge> : null}
      >
        <RedirectsEditor
          siteId={site.id}
          value={redirects}
          locked={locked}
          saving={saving === "redirects"}
          onSave={(rows) => patch("redirects", { settings: { redirects: rows } }, rows.length ? `${plural(rows.length, "redirect")} saved. They go live at the next publish.` : "Redirects removed.")}
        />
        {redirects.length === 0 && locked && <p className="text-[13px] text-text-muted">No redirects yet.</p>}
      </SettingsCard>

      {site.source.kind === "gitbook" && imported && imported.count > 0 && (
        <SettingsCard
          id="imported-redirects"
          title="From the GitBook import"
          description="The old GitBook addresses the import found. They keep working on their own; a redirect of yours for the same address wins."
          aside={<Badge size="sm">{num(imported.count)}</Badge>}
        >
          <ul className="ph-no-capture m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Redirects from the import">
            {shown.map((r) => (
              <li key={r.from} className="flex min-w-0 items-center gap-2.5 rounded-lg border border-border px-3 py-2 font-mono text-[13px]">
                <span className="min-w-0 flex-1 truncate" title={r.from}>{r.from}</span>
                <Icon name="arrowRight" size={14} className="shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1 truncate" title={r.to}>{r.to}</span>
                <span className="hidden shrink-0 font-sans text-caption text-text-muted sm:inline">From GitBook</span>
              </li>
            ))}
          </ul>
          {imported.redirects.length > SHOWN && !all && (
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setAll(true)}>Show all {num(imported.redirects.length)}</Button>
          )}
          {imported.count > imported.redirects.length && all && (
            <p className="text-[13px] text-text-muted">Showing the first {num(imported.redirects.length)} of {num(imported.count)}.</p>
          )}
        </SettingsCard>
      )}
    </>
  );
}
