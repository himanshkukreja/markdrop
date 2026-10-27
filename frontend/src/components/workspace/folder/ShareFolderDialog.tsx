"use client";

/**
 * Share a folder (D2): one link to a page that lists the folder. The link never grants access:
 * each visitor sees only what they could already open. So the dialog's job is to make the gap
 * visible ("4 of 12 items won't appear for people outside the workspace") and to offer the one fix
 * the person can make themselves: open up the documents they own.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Badge, Button, ConfirmDialog, CopyButton, Dialog, Disclosure, Icon, Input, RadioGroup, Skeleton, useToast,
} from "@/components/ui";
import { plural } from "@/components/dashboard/format";
import {
  errorStatus, getFolderShare, listWorkspaceItems, openUpToLink, shareFolder, unshareFolder,
  type FolderShare, type FolderShareLevel, type TreeFolder, type WorkspaceItem,
} from "@/lib/workspaces";
import { workspaceChanged } from "@/lib/workspaceStore";

type Level = "off" | FolderShareLevel;

const ACCESS_LABEL: Record<string, string> = {
  private: "Only people they choose",
  workspace: "Members only",
  link: "Anyone with the link",
};

export default function ShareFolderDialog({
  workspaceId, workspaceName, folder, onClose,
}: {
  workspaceId: string;
  workspaceName: string;
  folder: TreeFolder | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const [share, setShare] = useState<FolderShare | null>(null);
  const [level, setLevel] = useState<Level>("off");
  const [state, setState] = useState<"idle" | "loading" | "saving">("idle");
  const [error, setError] = useState("");
  const [owned, setOwned] = useState<Set<string> | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const lastFolder = useRef<TreeFolder | null>(folder);
  if (folder) lastFolder.current = folder;
  const f = folder ?? lastFolder.current;

  const apply = useCallback(async (next: Level, quiet = false) => {
    if (!folder) return;
    setState(quiet ? "loading" : "saving");
    setError("");
    try {
      if (next === "off") {
        await unshareFolder(workspaceId, folder.id);
        setShare(null);
        if (!quiet) toast.success(`“${folder.name}” is no longer shared`);
      } else {
        const s = await shareFolder(workspaceId, folder.id, next);
        setShare(s);
        if (!quiet) toast.success(next === "link" ? "Folder link is on" : `Shared with ${workspaceName}`);
      }
      setLevel(next);
      workspaceChanged(workspaceId);
    } catch (e) {
      const s = errorStatus(e);
      setError(
        s === 403 ? "Only admins can share folders in this workspace."
          : s === 404 || s === 405 || s === 501 ? "Folder sharing isn't available on this server yet."
            : e instanceof Error && e.message ? e.message : "That didn't save. Try again.",
      );
    } finally {
      setState("idle");
    }
  }, [folder, workspaceId, workspaceName, toast]);

  // Re-read the current share (link + hidden items) without changing it: GET, never a PUT, which
  // would rewrite the share and purge every cached page of it.
  const reload = useCallback(async () => {
    if (!folder) return;
    setState("loading");
    setError("");
    try {
      const s = await getFolderShare(workspaceId, folder.id);
      setShare(s);
      setLevel(s ? s.level : "off");
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Couldn't load the folder's link. Try again.");
    } finally {
      setState("idle");
    }
  }, [folder, workspaceId]);

  // Opening the dialog on a folder that is already shared reads its link and hidden items.
  useEffect(() => {
    if (!folder) return;
    setShare(null);
    setOwned(null);
    setError("");
    const current = folder.share?.level ?? null;
    setLevel(current ?? "off");
    if (current) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder?.id]);

  // Which hidden items are yours: the share response may say so; otherwise ask the items list.
  useEffect(() => {
    if (!share || share.level !== "link" || !share.hidden.length) { setOwned(new Set()); return; }
    if (share.hidden.every((h) => typeof h.is_yours === "boolean")) {
      setOwned(new Set(share.hidden.filter((h) => h.is_yours).map((h) => h.slug)));
      return;
    }
    let live = true;
    const want = new Set(share.hidden.map((h) => h.slug));
    (async () => {
      const mine = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const r: { items: WorkspaceItem[]; next_cursor: string | null } = await listWorkspaceItems(workspaceId, { folder: "all", cursor, limit: 100 });
        for (const it of r.items) if (want.has(it.slug) && it.owner.is_you) mine.add(it.slug);
        cursor = r.next_cursor;
        if (!cursor) break;
      }
      if (live) setOwned(mine);
    })().catch(() => { if (live) setOwned(new Set()); });
    return () => { live = false; };
  }, [share, workspaceId]);

  const hidden = share?.level === "link" ? share.hidden : [];
  // Only what "open to anyone with the link" would actually reveal: a password-protected link
  // document stays hidden after it (the password is the reason), so it isn't offered.
  const mineHidden = useMemo(
    () => hidden.filter((h) => owned?.has(h.slug) && !(h.has_password && h.access === "link")),
    [hidden, owned],
  );
  const total = share?.total_count ?? (f ? f.total_count : undefined);

  async function openUp() {
    const failed = await openUpToLink(mineHidden.map((h) => h.slug));
    setConfirmOpen(false);
    if (failed.length) toast.error(`${plural(failed.length, "item")} couldn't be changed. Try again.`);
    else toast.success(`${plural(mineHidden.length, "item")} now open to anyone with the link`);
    await reload();
  }

  const busy = state !== "idle";

  return (
    <>
      <Dialog
        open={!!folder}
        onClose={onClose}
        size="md"
        title={f ? `Share “${f.name}”` : "Share folder"}
        description="A folder link shows a page listing the folder. It never opens anything by itself: each person sees only what they could already open."
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <span className="text-caption text-text-muted">Changes save as you make them.</span>
            <Button variant="secondary" onClick={onClose}>Done</Button>
          </div>
        }
      >
        <div className="flex min-w-0 flex-col gap-5">
          {error && <Alert tone="danger">{error}</Alert>}

          <div className="flex flex-col gap-2">
            <p id="md-folder-share-level" className="text-eyebrow text-text-muted">Who can see this folder&apos;s page</p>
            <div aria-busy={state === "saving" || undefined}>
              <RadioGroup
                name="md-folder-share-level"
                aria-labelledby="md-folder-share-level"
                value={level}
                onChange={(v) => { if (!busy && v !== level) void apply(v as Level); }}
                options={[
                  { value: "off", label: "Not shared", description: `Only people in ${workspaceName} see it, here in Markdrop.`, disabled: state === "saving" },
                  { value: "workspace", label: `Members of ${workspaceName}`, description: "A link for teammates. They sign in to see it.", disabled: state === "saving" },
                  { value: "link", label: "Anyone with the link", description: "No sign-in. Visitors see only the items that are open to anyone.", disabled: state === "saving" },
                ]}
              />
            </div>
          </div>

          {level !== "off" && (
            state === "loading" && !share ? (
              <div className="flex flex-col gap-2" aria-busy="true">
                <span className="md-visually-hidden">Loading the folder link</span>
                <Skeleton height={40} />
                <Skeleton width="70%" />
              </div>
            ) : share ? (
              <div className="flex min-w-0 flex-col gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Input readOnly mono value={share.url} aria-label="Folder link" wrapClassName="min-w-0 flex-1" className="min-w-0 flex-1" onFocus={(e) => e.currentTarget.select()} />
                  <CopyButton text={share.url} label="Copy link" variant="primary" size="md" announceText="Folder link copied" />
                </div>

                {share.level === "link" && share.hidden_count > 0 && (
                  <Alert
                    tone="warning"
                    title={total !== undefined && total >= share.hidden_count
                      ? `${share.hidden_count} of ${plural(total, "item")} won't appear`
                      : `${plural(share.hidden_count, "item")} won't appear`}
                    actions={mineHidden.length > 0 ? (
                      <Button size="sm" variant="secondary" iconLeft="globe" onClick={() => setConfirmOpen(true)}>
                        Open up the {mineHidden.length} you own
                      </Button>
                    ) : undefined}
                  >
                    They&apos;re members-only or private, so people without access won&apos;t see them on the folder page.
                    {owned !== null && mineHidden.length === 0 && " None of them are yours; ask their owners to change who can open them."}
                  </Alert>
                )}
                {share.level === "link" && share.hidden_count > 0 && (
                  <Disclosure summary={`Show the ${plural(share.hidden_count, "hidden item")}`}>
                    <ul className="flex min-w-0 flex-col divide-y divide-border rounded-lg border border-border">
                      {share.hidden.map((h) => (
                        <li key={h.slug} className="flex min-h-11 min-w-0 items-center gap-3 px-3 py-2">
                          <Icon name={h.access === "private" ? "lock" : "users"} size={16} className="shrink-0 text-text-muted" />
                          <span className="min-w-0 flex-1 truncate text-body text-text" dir="auto">{h.title || h.slug}</span>
                          {owned?.has(h.slug) && <Badge size="sm" variant="outline">Yours</Badge>}
                          <span className="shrink-0 text-caption text-text-muted">
                            {h.has_password && h.access === "link" ? "Password-protected" : ACCESS_LABEL[h.access] ?? h.access}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Disclosure>
                )}
                {share.level === "link" && share.hidden_count === 0 && (
                  <p className="flex items-center gap-1.5 text-caption text-text-secondary">
                    <Icon name="checkCircle" size={14} className="text-success" /> Everything in it is open to anyone with the link.
                  </p>
                )}
                {share.level === "workspace" && (
                  <p className="text-caption text-text-secondary">
                    Members see what they can open. People outside {workspaceName} get a sign-in page, then nothing.
                  </p>
                )}
              </div>
            ) : null
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        tone="default"
        title={`Open up ${plural(mineHidden.length, "item")} to anyone with the link?`}
        body={
          <div className="flex flex-col gap-3">
            <p className="text-body text-text-secondary">
              Anyone with the folder link, or the item&apos;s own link, will be able to open {mineHidden.length === 1 ? "it" : "them"}, everywhere it opens. People you named keep their access.
            </p>
            <ul className="flex flex-col gap-1 text-body text-text">
              {mineHidden.slice(0, 6).map((h) => <li key={h.slug} className="truncate" dir="auto">· {h.title || h.slug}</li>)}
              {mineHidden.length > 6 && <li className="text-text-muted">and {mineHidden.length - 6} more</li>}
            </ul>
          </div>
        }
        confirmLabel="Open them up"
        onConfirm={openUp}
      />
    </>
  );
}
