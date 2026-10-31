"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Alert, Avatar, Button, ConfirmDialog, Drawer, Field, ICONS, Input, Select, Skeleton, Switch } from "@/components/ui";
import { docsErrorMessage, getVersion, listVersions, type Page, type PageVersion } from "@/lib/docsSites";
import { timeAgo, whenShort } from "../format";
import { pathProblem, type PageFields } from "./usePageSession";

/** Icons offered for pages (a curated slice of the design system's set). */
const PAGE_ICONS = [
  "doc", "home", "zap", "bulb", "book", "code", "terminal", "server", "chart", "settings", "key", "lock", "shield", "users", "user",
  "globe", "link", "flag", "calendar", "clock", "layers", "folder", "image", "film", "table", "list", "sparkle", "message", "mail", "bug", "github",
].filter((n) => n in ICONS);

function versionLabel(v: PageVersion): string {
  if (v.kind === "import") return "Imported";
  if (v.kind === "restore") return "Restored an earlier version";
  return "Edited";
}

/**
 * The editor's right panel (Editor board): the page's address, "Show in the sidebar", its icon,
 * and the last few versions with "See all versions" (a drawer where any version can be restored
 * as a new draft).
 */
export function PageSidePanel({ page, fields, readOnly, onChange, onRestore, isHome }: {
  page: Page;
  fields: PageFields;
  readOnly: boolean;
  onChange: (patch: Partial<PageFields>) => void;
  onRestore: (rev: number) => Promise<void>;
  isHome: boolean;
}) {
  const uid = useId();
  const [versions, setVersions] = useState<PageVersion[] | null>(null);
  const [error, setError] = useState("");
  const [all, setAll] = useState(false);
  const [viewing, setViewing] = useState<PageVersion | null>(null);
  const [confirm, setConfirm] = useState<PageVersion | null>(null);

  const load = useCallback(async () => {
    try {
      setVersions(await listVersions(page.site_id, page.id));
      setError("");
    } catch (e) {
      setError(docsErrorMessage(e, "Couldn't load the history."));
    }
  }, [page.site_id, page.id]);

  // Reload the history when the page changes or a new version is saved (rev moves).
  useEffect(() => { void load(); }, [load, page.rev]);

  // The list has no Markdown: open one version, then fetch it.
  const view = async (v: PageVersion) => {
    setViewing(v);
    try {
      const full = await getVersion(page.site_id, page.id, v.rev);
      setViewing((cur) => (cur?.rev === v.rev ? full : cur));
    } catch (e) {
      setError(docsErrorMessage(e, "Couldn't open that version."));
      setViewing(null);
    }
  };

  const bad = pathProblem(fields.path);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-[14px] font-semibold text-text">Page</h2>
      <Field label="Address" htmlFor={`${uid}-path`} error={bad || undefined} hint={isHome ? "The home page is always /." : "Change it and the published address redirects to the new one (Settings › Redirects)."}>
        <Input mono size="sm" value={fields.path} readOnly={readOnly || isHome} spellCheck={false} autoCapitalize="none" onChange={(e) => onChange({ path: e.target.value.toLowerCase() })} />
      </Field>
      <Switch label="Show in the sidebar" checked={!fields.hidden} disabled={readOnly || isHome} onChange={(e) => onChange({ hidden: !e.target.checked })} />
      <Field label="Icon" htmlFor={`${uid}-icon`}>
        <Select
          value={fields.icon ?? ""}
          disabled={readOnly}
          options={[{ value: "", label: "No icon" }, ...PAGE_ICONS.map((n) => ({ value: n, label: n }))]}
          onChange={(e) => onChange({ icon: e.target.value || null })}
        />
      </Field>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <h2 className="text-[14px] font-semibold text-text">History</h2>
        {error && <p className="text-[13px] text-danger">{error}</p>}
        {!versions && !error && <><Skeleton width="80%" /><Skeleton width="70%" /><Skeleton width="75%" /></>}
        {versions?.length === 0 && <p className="text-[13px] text-text-muted">No saved versions yet.</p>}
        {versions?.slice(0, 3).map((v) => (
          <div key={v.rev} className="flex items-center gap-2 text-[13px]">
            <Avatar name={v.by_name || "Someone"} size="sm" />
            <span className="min-w-0 flex-1 truncate text-text">{versionLabel(v)}</span>
            <span className="shrink-0 text-text-muted">{timeAgo(v.at).replace(" ago", "")}</span>
          </div>
        ))}
        {!!versions?.length && (
          <button type="button" className="md-focus self-start rounded text-[13px] text-accent-text underline-offset-2 hover:underline" onClick={() => setAll(true)}>
            See all versions
          </button>
        )}
      </div>

      <Drawer open={all} onClose={() => { setAll(false); setViewing(null); }} title={viewing ? `Version ${viewing.rev}` : "All versions"} description={viewing ? `${versionLabel(viewing)} by ${viewing.by_name || "someone"}, ${whenShort(viewing.at)}` : `The last ${versions?.length ?? 0} saves of “${fields.title}”. Restoring makes a new draft; nothing is lost.`} width={480}>
        {viewing ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" iconLeft="arrowLeft" onClick={() => setViewing(null)}>All versions</Button>
              {!readOnly && viewing.rev !== page.rev && <Button variant="primary" size="sm" iconLeft="rotate" onClick={() => setConfirm(viewing)}>Restore this version</Button>}
            </div>
            <p className="text-body-strong text-text">{viewing.title}</p>
            {viewing.description && <p className="text-[13px] text-text-secondary">{viewing.description}</p>}
            {viewing.markdown === undefined ? (
              <Skeleton variant="rect" height={160} />
            ) : (
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-inset p-3 font-mono text-[12.5px] leading-5 text-text">{viewing.markdown}</pre>
            )}
          </div>
        ) : (
          <ol className="flex flex-col">
            {versions?.map((v, i) => (
              <li key={v.rev} className={`flex items-center gap-3 py-2.5 ${i ? "border-t border-border" : ""}`}>
                <Avatar name={v.by_name || "Someone"} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-text">{versionLabel(v)}{v.rev === page.rev ? " · current" : ""}</span>
                  <span className="block text-[12px] text-text-muted">{v.by_name || "Someone"} · {whenShort(v.at)}</span>
                </span>
                <Button variant="ghost" size="sm" onClick={() => void view(v)}>View</Button>
                {!readOnly && v.rev !== page.rev && <Button variant="ghost" size="sm" iconLeft="rotate" onClick={() => setConfirm(v)}>Restore</Button>}
              </li>
            ))}
          </ol>
        )}
        {readOnly && <Alert tone="neutral" className="mt-3">You can look at earlier versions; restoring one needs the page free to edit.</Alert>}
      </Drawer>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        tone="default"
        title="Restore this version?"
        body={`It becomes the newest draft of “${fields.title}”. The current draft stays in the history, and readers see nothing until you publish.`}
        confirmLabel="Restore"
        onConfirm={async () => {
          if (!confirm) return;
          await onRestore(confirm.rev);
          setConfirm(null);
          setViewing(null);
          setAll(false);
        }}
      />
    </div>
  );
}

export default PageSidePanel;
