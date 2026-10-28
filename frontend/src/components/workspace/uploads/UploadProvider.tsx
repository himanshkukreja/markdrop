"use client";

/**
 * Drop to upload (simpler UI, Main + NewWorkspace boards). Files dropped on a folder page, on a
 * folder in the rail, or picked with "Upload to …" become items in that folder, starting with the
 * folder's effective default ("New items here start as …"):
 *
 *   - `.md` / `.markdown` files are read and published as documents;
 *   - everything else goes through the existing artifact upload (presigned PUT → confirm);
 *   - both are created with `workspace` + `folder` and no access level, so the server applies the
 *     folder's effective default; a `workspace_error` (created but not filed) is shown on the row.
 *
 * Progress shows as a small list in the corner (a polite live region). Nothing here decides who may
 * do what: the server refuses what the caller can't do, and the row says why.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Anchor, Button, FileIcon, Icon, IconButton, Progress, cx } from "@/components/ui";
import { createDocument, uploadArtifact } from "@/lib/api";
import type { ItemAccess } from "@/lib/workspaces";
import { documentsChanged, workspaceChanged } from "@/lib/workspaceStore";

export interface UploadTarget {
  workspaceId: string;
  folderId: string | null;
  /** "Guides", or the workspace name at its top level. */
  label: string;
  /** What the new items start as (the folder's effective default). */
  access: ItemAccess;
}

type State = "queued" | "uploading" | "finishing" | "done" | "error";
interface Entry {
  id: number;
  file: File;
  target: UploadTarget;
  state: State;
  pct: number;
  slug?: string;
  error?: string;
}

interface Ctx {
  /** Upload these files into `target`. */
  upload: (files: File[], target: UploadTarget) => void;
  /** Open the file picker, then upload what was chosen into `target`. */
  pick: (target: UploadTarget) => void;
  /** Where a drop on a workspace folder (the rail) should land, with its effective default. */
  resolve: (workspaceId: string, folderId: string | null, label: string) => UploadTarget;
}

const UploadCtx = createContext<Ctx | null>(null);

/** The upload manager (null outside the app shell: callers then hide their drop affordances). */
export const useUploads = () => useContext(UploadCtx);

const MD = /\.(md|markdown|mdown|mkd)$/i;
const isMarkdown = (f: File) => MD.test(f.name) || f.type === "text/markdown";
const stem = (name: string) => name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || name;

/** The first "# Heading" of a markdown file, else its file name. */
function titleOf(markdown: string, name: string) {
  const m = markdown.match(/^#\s+(.+?)\s*#*\s*$/m);
  return (m?.[1] ?? stem(name)).slice(0, 200);
}

/** True while files (not text or a row) are being dragged. */
export function hasFiles(e: { dataTransfer: DataTransfer | null }) {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
}

export function UploadProvider({
  children, resolveAccess,
}: {
  children: React.ReactNode;
  /** The effective default for a folder (or a workspace's top level). */
  resolveAccess: (workspaceId: string, folderId: string | null) => ItemAccess;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const seq = useRef(0);
  const running = useRef(false);
  const queue = useRef<Entry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickTarget = useRef<UploadTarget | null>(null);

  const patch = useCallback((id: number, p: Partial<Entry>) => {
    setEntries((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));
  }, []);

  const runOne = useCallback(async (e: Entry) => {
    const { file, target } = e;
    patch(e.id, { state: "uploading", pct: 0, error: undefined });
    try {
      // Created straight into the folder with no access level, so the server applies the folder's
      // effective default ("New items here start as …") — the same rule as every other create path.
      const where = { workspace: target.workspaceId, folder: target.folderId };
      let doc: { slug: string; id?: string | null; workspace_error?: string | null };
      if (isMarkdown(file)) {
        const text = await file.text();
        patch(e.id, { pct: 60 });
        doc = await createDocument(titleOf(text, file.name), text, where);
      } else {
        doc = await uploadArtifact(file, stem(file.name), {
          ...where,
          onProgress: (pct) => patch(e.id, { pct, state: pct >= 100 ? "finishing" : "uploading" }),
        });
      }
      patch(e.id, { state: "finishing", pct: 100, slug: doc.slug });
      if (doc.workspace_error) {
        // Published, but not filed: say so rather than pretend (it's in My files).
        patch(e.id, { state: "error", error: `Uploaded to My files, but not into ${target.label}: ${doc.workspace_error}` });
        documentsChanged();
        return;
      }
      patch(e.id, { state: "done" });
      workspaceChanged(target.workspaceId);
      documentsChanged();
    } catch (err) {
      patch(e.id, { state: "error", error: err instanceof Error && err.message ? err.message : "Upload failed" });
    }
  }, [patch]);

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (queue.current.length) {
        const next = queue.current.shift()!;
        await runOne(next);
      }
    } finally {
      running.current = false;
    }
  }, [runOne]);

  const upload = useCallback((files: File[], target: UploadTarget) => {
    const list = files.filter((f) => f.size > 0 || isMarkdown(f));
    if (!list.length) return;
    const added = list.map((file) => ({ id: ++seq.current, file, target, state: "queued" as State, pct: 0 }));
    setEntries((xs) => [...xs, ...added]);
    setCollapsed(false);
    queue.current.push(...added);
    void pump();
  }, [pump]);

  const retry = (e: Entry) => {
    patch(e.id, { state: "queued", pct: 0, error: undefined });
    queue.current.push(e);
    void pump();
  };

  const pick = useCallback((target: UploadTarget) => {
    pickTarget.current = target;
    inputRef.current?.click();
  }, []);

  const resolve = useCallback(
    (workspaceId: string, folderId: string | null, label: string): UploadTarget => ({
      workspaceId, folderId, label, access: resolveAccess(workspaceId, folderId),
    }),
    [resolveAccess],
  );

  const value = useMemo<Ctx>(() => ({ upload, pick, resolve }), [upload, pick, resolve]);

  const active = entries.filter((e) => e.state !== "done" && e.state !== "error").length;
  const failed = entries.filter((e) => e.state === "error").length;
  const labels = [...new Set(entries.map((e) => e.target.label))];
  const where = labels.length === 1 ? labels[0] : `${labels.length} folders`;
  const summary = active
    ? `Uploading ${entries.length - active + 1} of ${entries.length} to ${where}`
    : failed
      ? `${failed} of ${entries.length} didn't upload`
      : `${entries.length === 1 ? "1 file" : `${entries.length} files`} added to ${where}`;

  // A finished, error-free batch tidies itself away after a while.
  useEffect(() => {
    if (!entries.length || active || failed) return;
    const t = setTimeout(() => setEntries([]), 12_000);
    return () => clearTimeout(t);
  }, [entries.length, active, failed]);

  return (
    <UploadCtx.Provider value={value}>
      {children}
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (pickTarget.current && files.length) upload(files, pickTarget.current);
        }}
      />
      {entries.length > 0 && (
        <section
          aria-label="Uploads"
          className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] z-(--z-toast) flex w-[min(360px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-surface-raised shadow-lg"
        >
          <div className="flex min-h-11 items-center gap-2 border-b border-border px-3 py-2">
            <Icon name={active ? "upload" : failed ? "alertCircle" : "checkCircle"} size={16} className={cx("shrink-0", active ? "text-accent-text" : failed ? "text-danger" : "text-success")} />
            <p className="min-w-0 flex-1 truncate text-body-strong text-text" role="status" aria-live="polite">{summary}</p>
            <IconButton icon={collapsed ? "chevronUp" : "chevronDown"} label={collapsed ? "Show uploads" : "Hide uploads"} size="sm" aria-expanded={!collapsed} onClick={() => setCollapsed((c) => !c)} />
            {!active && <IconButton icon="x" label="Dismiss uploads" size="sm" onClick={() => setEntries([])} />}
          </div>
          {!collapsed && (
            <ul className="flex max-h-72 flex-col overflow-y-auto">
              {entries.map((e) => (
                <li key={e.id} className="flex min-w-0 flex-col gap-1.5 border-b border-border px-3 py-2.5 last:border-b-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-text-secondary"><FileIcon name={e.file.name} mime={e.file.type} size={16} /></span>
                    <span className="min-w-0 flex-1 truncate text-body text-text" dir="auto" title={e.file.name}>{e.file.name}</span>
                    {e.state === "done" && e.slug ? (
                      <Anchor href={`/${e.slug}`} className="md-focus shrink-0 rounded-sm text-caption font-semibold text-accent-text">Open</Anchor>
                    ) : e.state === "error" ? (
                      <Button size="sm" variant="ghost" onClick={() => retry(e)}>Retry</Button>
                    ) : (
                      <span className="shrink-0 text-caption text-text-muted tabular-nums">
                        {e.state === "queued" ? "Waiting" : e.state === "finishing" ? "Finishing" : `${e.pct}%`}
                      </span>
                    )}
                  </div>
                  {(e.state === "uploading" || e.state === "finishing" || e.state === "queued") && (
                    <Progress
                      size="sm"
                      value={e.pct}
                      indeterminate={e.state === "finishing"}
                      aria-label={`Uploading ${e.file.name}`}
                    />
                  )}
                  {e.state === "error" && <p className="text-caption text-danger">{e.error}</p>}
                  {e.state === "done" && <p className="text-caption text-text-muted">In {e.target.label}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </UploadCtx.Provider>
  );
}
