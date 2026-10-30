"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, ConfirmDialog, IconButton, Skeleton } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { useToast } from "@/components/Toast";
import { formatBytes } from "@/components/ArtifactBadge";
import { fullDate, relativeTime } from "@/components/dashboard/format";
import { deleteFileVersion, listFileVersions, restoreFileVersion, type FileVersion } from "@/lib/api";

/**
 * The Versions section of the artifact settings drawer (and the Replace file drawer): the kept
 * versions of a single-file artifact, newest first, from `GET /api/v1/files/{slug}/versions`.
 * Anyone who may replace the file may restore an old version (the server allows editors too);
 * deleting one is the owner's alone (`canDelete`), since it can't be undone and frees their storage.
 *
 * `refreshKey` reloads the list (a replace just made a new version). `onRestored` lets the view
 * re-read the document so the page shows the restored file.
 */
export function ArtifactVersions({
  slug,
  canDelete,
  disabled = false,
  refreshKey = 0,
  onRestored,
}: {
  slug: string;
  canDelete: boolean;
  disabled?: boolean;
  refreshKey?: number;
  onRestored: (version: number) => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState<FileVersion | null>(null);
  const [deleting, setDeleting] = useState<FileVersion | null>(null);

  const load = useCallback(() => {
    setError("");
    listFileVersions(slug)
      .then(setVersions)
      .catch((e) => {
        setVersions(null);
        setError(e instanceof Error ? e.message : "Couldn't load the versions.");
      });
  }, [slug]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function restore(v: FileVersion) {
    const next = await restoreFileVersion(slug, v.version);
    setRestoring(null);
    toast(`Version ${v.version} restored. It's the current file now, as version ${next}.`, "success");
    load();
    await onRestored(next);
  }

  async function remove(v: FileVersion) {
    await deleteFileVersion(slug, v.version);
    setDeleting(null);
    toast(`Version ${v.version} deleted.`, "success");
    load();
  }

  return (
    <section aria-labelledby="artifact-versions" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="artifact-versions" className="m-0 text-body-strong text-text">
          Versions
        </h3>
        <ReadMore topic="versions" className="text-caption" />
      </div>
      <p className="m-0 text-caption text-text-secondary">
        Replacing the file keeps the last five versions. Restore one to make it current again at the same link.
      </p>

      {error ? (
        <Alert tone="danger" actions={<Button size="sm" variant="secondary" onClick={load}>Try again</Button>}>
          {error}
        </Alert>
      ) : versions === null ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton height={44} variant="rect" />
          <Skeleton height={44} variant="rect" />
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border rounded-lg border border-border p-0">
          {versions.map((v) => (
            <li key={v.version} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2 text-body text-text">
                  Version {v.version}
                  {v.current && <Badge tone="success" size="sm">Current</Badge>}
                </span>
                <span className="truncate text-caption text-text-muted" title={fullDate(v.created_at)}>
                  {[formatBytes(v.size_bytes), relativeTime(v.created_at), v.filename].filter(Boolean).join(" · ")}
                </span>
              </div>
              {!v.current && (
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="secondary" onClick={() => setRestoring(v)} disabled={disabled}>
                    Restore
                  </Button>
                  {canDelete && (
                    <IconButton
                      icon="trash"
                      size="sm"
                      label={`Delete version ${v.version}`}
                      onClick={() => setDeleting(v)}
                      disabled={disabled}
                    />
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!restoring}
        onClose={() => setRestoring(null)}
        onConfirm={() => (restoring ? restore(restoring) : undefined)}
        tone="default"
        title={`Restore version ${restoring?.version ?? ""}?`}
        body="It becomes the current file at the same link, as a new version. The file there now is kept as an earlier version."
        confirmLabel="Restore"
      />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
        title={`Delete version ${deleting?.version ?? ""}?`}
        body="This version is removed for good and its space comes back to your storage. The current file doesn't change. This can't be undone."
        confirmLabel="Delete version"
      />
    </section>
  );
}

export default ArtifactVersions;
