"use client";

/**
 * After an import: a page that reads as dated release notes ("Changelog", "Release notes",
 * "What's new" with a dated heading per release) can become changelog entries in one click (backend
 * services/docs_site_changelog.py parse_release_notes; nothing changes until it's pressed, and the
 * page itself stays).
 */
import { useEffect, useState } from "react";
import { ReadMore } from "@/components/ReadMore";
import { Alert, Button, Icon } from "@/components/ui";
import { importReleaseNotes, releaseNotesCandidates, type ReleaseNotesCandidate } from "@/lib/docsChangelog";
import { docsErrorMessage } from "@/lib/docsSites";
import { plural } from "../format";
import { usePublishState } from "../PublishState";
import { longDate } from "./model";

export function ReleaseNotesOffer({ siteId, base, canEdit, ready }: { siteId: string; base: string; canEdit: boolean; ready: boolean }) {
  const { refreshSoon } = usePublishState();
  const [pages, setPages] = useState<ReleaseNotesCandidate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [made, setMade] = useState<Record<string, number>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    if (!ready || !canEdit) return;
    releaseNotesCandidates(siteId).then((r) => setPages(r.pages)).catch(() => setPages([]));
  }, [siteId, ready, canEdit]);

  if (!pages.length) return null;
  const turn = async (c: ReleaseNotesCandidate) => {
    setBusy(c.page_id);
    setError("");
    try {
      const r = await importReleaseNotes(siteId, c.page_id);
      setMade((m) => ({ ...m, [c.page_id]: r.created }));
      refreshSoon();
    } catch (e) {
      setError(docsErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="release-notes-h" className="flex flex-col gap-3 rounded-xl border border-accent bg-accent-soft p-4">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 id="release-notes-h" className="flex items-center gap-2 text-[16px] font-semibold text-text"><Icon name="megaphone" size={16} /> Release notes found</h2>
        <ReadMore topic="studioChangelogImport" className="text-[13px]" />
      </div>
      {error && <Alert tone="danger" onDismiss={() => setError("")}>{error}</Alert>}
      {pages.map((c) => (
        <div key={c.page_id} className="flex flex-wrap items-center gap-3">
          <span className="flex min-w-0 flex-1 flex-col">
            <strong className="text-text"><span className="ph-sensitive ph-mask">“{c.title}”</span> has {plural(c.entries, "dated release")}</strong>
            <span className="text-[13px] text-text-secondary">
              {made[c.page_id] !== undefined
                ? `${plural(made[c.page_id]!, "changelog entry", "changelog entries")} added as drafts. Check them, then publish. The page is still in your guide.`
                : `${longDate(c.oldest)} to ${longDate(c.newest)}. Each dated heading becomes a changelog entry: your guide gets a /changelog page with an RSS feed.`}
            </span>
          </span>
          {made[c.page_id] !== undefined ? (
            <Button variant="secondary" size="sm" iconRight="arrowRight" href={`${base}/changelog`}>Open the changelog</Button>
          ) : (
            <Button variant="primary" size="sm" iconLeft="megaphone" loading={busy === c.page_id} onClick={() => void turn(c)}>
              Turn into {plural(c.entries, "entry", "entries")}
            </Button>
          )}
        </div>
      ))}
    </section>
  );
}

export default ReleaseNotesOffer;
