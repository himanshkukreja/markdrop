"use client";

/**
 * A page open in the block editor (a document with `editor: "blocks"`): the Guides editor
 * (components/docs-editor) hosted by a document.
 *
 *   upload       → POST /documents/{slug}/assets, written as ![alt](asset:<id>)
 *   resolveAsset → the page's per-viewer asset URLs (a just-uploaded image shows from memory)
 *   pages        → the embed / mention picker (your files, the page's workspace) and the preview,
 *                  resolved for the author through POST /documents/{slug}/embeds
 *   readOnly     → while someone else holds the edit lock
 *
 * One editor at a time: the lock is taken on open and heartbeated (usePageEditSession); autosave
 * runs 2 s after the last change with `base_rev`; an AI app's append_blocks arrives live and goes
 * in at the end without disturbing the caret.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Dropdown, Icon, IconButton, Spinner, useToast, type MenuEntry } from "@/components/ui";
import { DocsEditor } from "@/components/docs-editor";
import { PAGE_BLOCKS } from "@/components/docs-editor/blocks";
import type { DocsEditorApi, PagesEditorHost } from "@/components/docs-editor/types";
import { getWorkspace } from "@/lib/workspaces";
import { assetId } from "@/lib/pageBlocks.mjs";
import { PAGE_IMAGE_MAX, resolveEmbeds, searchMine, searchWorkspace, setEditor, uploadPageAsset, type AssetUrl, type Crumb, type PageDocument } from "@/lib/pages";
import { PageEmbed, PageMention } from "./PageEmbed";
import { PageBreadcrumbs, type PageAddressing } from "./PageChrome";
import { usePageEditSession, type SaveState } from "./usePageEditSession";
import { usePageAssets } from "./usePageEmbeds";
import "./pages.css";

export interface PageEditorProps {
  slug: string;
  title: string | null;
  content: string;
  rev: number | null;
  /** The edit secret, when that's how this person edits (owners and members use their session). */
  secret?: string | null;
  workspaceId?: string | null;
  crumbs: Crumb[];
  assets?: Record<string, AssetUrl> | null;
  addressing: PageAddressing;
  /** The document's live socket (useDocumentViewer): `changed` / `appended`. */
  subscribeLive?: (fn: (msg: Record<string, unknown>) => void) => () => void;
  /** Saved: the viewer shows this version when the editor closes. */
  onSaved?: (doc: PageDocument) => void;
  /** Back to reading, with what's on screen. */
  onDone: (latest: { title: string; content: string }) => void;
  /** "Add a sub-page" (signed-in editors). */
  onAddSubPage?: (() => void) | null;
  /** Sticky bars above the editor, in px (the site header). */
  stickyTop?: () => number;
}

function SaveStatus({ save }: { save: SaveState }) {
  if (save.state === "saving") return <span className="pb-editor__status"><Spinner size={12} /> Saving…</span>;
  if (save.state === "dirty") return <span className="pb-editor__status">Unsaved changes</span>;
  if (save.state === "error") return <span className="pb-editor__status text-danger" role="status">{save.message}</span>;
  return <span className="pb-editor__status"><Icon name="check" size={14} aria-hidden /> {save.at ? "Saved" : "All changes saved"}</span>;
}

export function PageEditor({ slug, title: initialTitle, content: initialContent, rev, secret = null, workspaceId, crumbs, assets: initialAssets, addressing, subscribeLive, onSaved, onDone, onAddSubPage, stickyTop }: PageEditorProps) {
  const toast = useToast();
  const [title, setTitle] = useState(initialTitle ?? "");
  const [content, setContent] = useState(initialContent);
  const api = useRef<DocsEditorApi | null>(null);
  const local = useRef(new Map<string, string>());
  const [, setLocalTick] = useState(0);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const session = usePageEditSession({
    slug,
    secret,
    initial: { title: initialTitle ?? "", content: initialContent, rev },
    onSaved,
    onAppend: (md) => api.current?.append(md),
    onRemote: (doc) => {
      setTitle(doc.title);
      setContent(doc.content);
    },
    subscribeLive,
  });
  const readOnly = session.lock.kind !== "mine";

  const assets = usePageAssets(slug, initialAssets, content);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    getWorkspace(workspaceId)
      .then((w) => live && setWorkspaceName(w.name))
      .catch(() => live && setWorkspaceName("Workspace"));
    return () => {
      live = false;
    };
  }, [workspaceId]);

  // Blob URLs of images uploaded here: shown until the page's own URLs know them.
  useEffect(() => () => local.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const upload = useCallback(
    async (file: File) => {
      if (file.size > PAGE_IMAGE_MAX) throw new Error("Images can be up to 10 MB.");
      if (!file.type.startsWith("image/")) throw new Error("Choose an image file (PNG, JPG, WebP, GIF or SVG).");
      const a = await uploadPageAsset(slug, file, secret);
      local.current.set(a.id, URL.createObjectURL(file));
      setLocalTick((n) => n + 1);
      return `asset:${a.id}`;
    },
    [slug, secret],
  );

  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  const resolveAsset = useCallback((src: string) => {
    const id = assetId(src);
    if (!id) return src;
    return local.current.get(id) ?? assetsRef.current[id]?.url ?? "";
  }, []);

  const pages = useMemo<PagesEditorHost>(
    () => ({
      workspaceName: workspaceId ? workspaceName ?? "Workspace" : null,
      async search(scope, q, cursor) {
        if (scope === "workspace" && workspaceId) return searchWorkspace(workspaceId, q, cursor);
        const page = cursor ? Number(cursor) : 1;
        const r = await searchMine(q, page);
        return { items: r.items, cursor: r.more ? String(page + 1) : null };
      },
      resolve: (slugs) => resolveEmbeds(slug, slugs),
      renderEmbed: (p) => <PageEmbed slug={p.slug} mode={p.mode} label={p.label} resolved={p.resolved as never} />,
      renderMention: (p) => <PageMention slug={p.slug} resolved={p.resolved as never} />,
    }),
    [slug, workspaceId, workspaceName],
  );

  const onChange = useCallback(
    (md: string) => {
      setContent(md);
      session.update({ content: md });
    },
    [session],
  );

  async function done() {
    await session.flush();
    onDone({ title, content });
  }

  async function toClassic() {
    setSwitching(true);
    try {
      await session.flush();
      await setEditor(slug, "classic", secret);
      toast.success("Switched to the classic editor. The Markdown is unchanged.");
      window.location.assign(`${window.location.pathname}?edit=1`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't switch editors.");
      setSwitching(false);
    }
  }

  const menu: MenuEntry[] = [
    ...(onAddSubPage ? [{ label: "Add a sub-page", icon: "plus", onClick: onAddSubPage }] : []),
    { label: "Open in the classic editor", icon: "code", description: "The same Markdown, in a text editor", onClick: () => void toClassic(), disabled: switching || readOnly, separated: !!onAddSubPage },
  ];

  const lock = session.lock;
  return (
    <div className="pb-editor">
      <div className="pb-editor__bar no-print">
        <PageBreadcrumbs crumbs={crumbs} title={title || initialTitle} addressing={addressing} className="min-w-0 flex-1" />
        {!crumbs.length && <span className="flex-1" />}
        {lock.kind === "mine" ? <SaveStatus save={session.save} /> : lock.kind === "acquiring" ? <span className="pb-editor__status"><Spinner size={12} /> Opening…</span> : null}
        <Dropdown aria-label="Page actions" align="right" minWidth={260} trigger={<IconButton icon="more" label="Page actions" size="sm" variant="ghost" />} items={menu} />
        <Button variant="primary" size="sm" iconLeft="check" onClick={() => void done()}>
          Done
        </Button>
      </div>

      {lock.kind === "theirs" && (
        <Alert tone="warning" icon="lock" title={`${lock.name ?? "Someone"} is editing — read only`} live>
          {lock.lost ? "They took over this page; what you typed is still on screen. " : ""}
          You see their changes as they save. You can edit again when they finish.
        </Alert>
      )}
      {lock.kind === "readonly" && (
        <Alert tone="warning" icon="lock" title="Read only">
          {lock.message}
        </Alert>
      )}
      {session.conflict && (
        <Alert
          tone="warning"
          title="This page changed"
          actions={
            <>
              <Button size="sm" variant="secondary" onClick={() => void session.resolveConflict("theirs")}>Load the latest</Button>
              <Button size="sm" variant="ghost" onClick={() => void session.resolveConflict("mine")}>Keep mine</Button>
            </>
          }
        >
          Someone saved a newer version while you were editing. Load theirs (your unsaved changes are dropped) or keep yours (theirs is replaced).
        </Alert>
      )}
      {session.save.state === "error" && !session.conflict && lock.kind === "mine" && (
        <Alert tone="danger" actions={<Button size="sm" variant="secondary" onClick={session.retry}>Try again</Button>}>
          {session.save.message}
        </Alert>
      )}

      <input
        className="pb-editor__title ph-mask"
        value={title}
        placeholder="Untitled"
        aria-label="Page title"
        readOnly={readOnly}
        maxLength={200}
        dir="auto"
        onChange={(e) => {
          setTitle(e.target.value);
          session.update({ title: e.target.value });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            api.current?.focus();
          }
        }}
      />
      {/* ph-no-capture: the page being written is never recorded (the editor masks itself too). */}
      <div className="ph-no-capture">
        <DocsEditor
          value={content}
          onChange={onChange}
          readOnly={readOnly}
          showHeader={false}
          placeholder="Start writing, or type / for blocks"
          onUploadImage={readOnly ? undefined : upload}
          resolveAssetUrl={resolveAsset}
          blocks={PAGE_BLOCKS}
          pages={pages}
          darkImages={false}
          apiRef={api}
          stickyTop={stickyTop}
          aria-label="Page content"
          autoFocus={!content.trim()}
        />
      </div>
    </div>
  );
}

export default PageEditor;
