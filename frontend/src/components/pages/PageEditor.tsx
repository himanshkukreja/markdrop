"use client";

/**
 * A page open in the block editor (a document with `editor: "blocks"`): the Guides editor
 * (components/docs-editor) hosted by a document, with a Notion-style head (cover, icon, title) and
 * the page's options.
 *
 *   upload       → POST /documents/{slug}/assets, written as ![alt](asset:<id>)
 *   resolveAsset → the page's per-viewer asset URLs (a just-uploaded image shows from memory)
 *   pages        → the embed / mention picker (your files, the page's workspace) and the preview,
 *                  resolved for the author through POST /documents/{slug}/embeds
 *   readOnly     → while someone else holds the edit lock, or the page is locked
 *
 * One editor at a time: the lock is taken on open and heartbeated (usePageEditSession); autosave
 * runs 2 s after the last change with `base_rev`, and every change is kept in this browser until the
 * server has it (restored after a crash or a reload); an AI app's append_blocks arrives live and
 * goes in at the end without disturbing the caret.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Dropdown, Icon, IconButton, Spinner, copyText, useToast, type MenuEntry } from "@/components/ui";
import { DocsEditor } from "@/components/docs-editor";
import { PAGE_BLOCKS } from "@/components/docs-editor/blocks";
import { splitFrontmatter } from "@/components/docs-editor/core/frontmatter.mjs";
import type { DocsEditorApi, EditorMode, PagesEditorHost } from "@/components/docs-editor/types";
import { getWorkspace } from "@/lib/workspaces";
import { assetId, fillTemplate, pagePath } from "@/lib/pageBlocks.mjs";
import { rememberSecret } from "./TemplateGallery";
import { PAGE_IMAGE_MAX, createPage, linkPreview, listPageTemplates, resolveEmbeds, searchPeople, searchMine, searchWorkspace, setEditor, uploadPageAsset, type AssetUrl, type Crumb, type PageDocument, type PageTemplate } from "@/lib/pages";
import { PageEmbed, PageMention } from "./PageEmbed";
import { PageBreadcrumbs, type PageAddressing } from "./PageChrome";
import { PageHead } from "./PageHead";
import { readPageProps, type PageFont, type PageProps } from "./pageProps";
import { writePageProps } from "./pagePropsWrite";
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
  /** The owner (may lock and unlock the page). */
  isOwner?: boolean;
  /** The page's address (Copy link). */
  url?: string;
  updatedAt?: string | null;
  /** The document's live socket (useDocumentViewer): `changed` / `appended`. */
  subscribeLive?: (fn: (msg: Record<string, unknown>) => void) => () => void;
  /** Saved: the viewer shows this version when the editor closes. */
  onSaved?: (doc: PageDocument) => void;
  /** Back to reading, with what's on screen. */
  onDone: (latest: { title: string; content: string }) => void;
  /** "Add a sub-page" (signed-in editors). */
  onAddSubPage?: (() => void) | null;
  /** Delete the page (the viewer asks what happens to its sub-pages). */
  onDelete?: (() => void) | null;
  /** Sticky bars above the editor, in px (the site header). */
  stickyTop?: () => number;
}

function SaveStatus({ save, online }: { save: SaveState; online: boolean }) {
  if (!online) return <span className="pb-editor__status" role="status"><Icon name="wifiOff" size={14} aria-hidden /> Offline, retrying</span>;
  if (save.state === "saving") return <span className="pb-editor__status"><Spinner size={12} /> Saving…</span>;
  if (save.state === "dirty") return <span className="pb-editor__status">Unsaved</span>;
  if (save.state === "error") return <span className="pb-editor__status text-danger" role="status">Not saved</span>;
  return <span className="pb-editor__status"><Icon name="check" size={14} aria-hidden /> Saved</span>;
}

function words(md: string): number {
  const body = splitFrontmatter(md).body.replace(/```[\s\S]*?```/g, " ").replace(/[#>*_`~\-[\]()!|:{}=]/g, " ");
  return body.split(/\s+/).filter((w) => /\w/.test(w)).length;
}

function useOnline() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const up = () => setOn(navigator.onLine);
    up();
    window.addEventListener("online", up);
    window.addEventListener("offline", up);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", up);
    };
  }, []);
  return on;
}

const DRAFT = (slug: string) => `md_page_draft:${slug}`;
interface Draft { title: string; content: string; rev: number | null; at: number }

function readDraft(slug: string): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT(slug));
    const d = raw ? (JSON.parse(raw) as Draft) : null;
    return d && typeof d.content === "string" ? d : null;
  } catch {
    return null;
  }
}

export function PageEditor({ slug, title: initialTitle, content: initialContent, rev, secret = null, workspaceId, crumbs, assets: initialAssets, addressing, isOwner = false, url, updatedAt, subscribeLive, onSaved, onDone, onAddSubPage, onDelete, stickyTop }: PageEditorProps) {
  const toast = useToast();
  const online = useOnline();
  const [title, setTitle] = useState(initialTitle ?? "");
  const [content, setContent] = useState(initialContent);
  const [mode, setMode] = useState<EditorMode>("visual");
  const api = useRef<DocsEditorApi | null>(null);
  const local = useRef(new Map<string, string>());
  const [, setLocalTick] = useState(0);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [templates, setTemplates] = useState<PageTemplate[]>([]);
  // What this browser kept from an earlier visit that the server never confirmed.
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    const d = readDraft(slug);
    if (d && (d.content !== initialContent || d.title !== (initialTitle ?? ""))) setDraft(d);
    else if (d) localStorage.removeItem(DRAFT(slug));
  }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  const session = usePageEditSession({
    slug,
    secret,
    initial: { title: initialTitle ?? "", content: initialContent, rev },
    onSaved: (doc) => {
      onSaved?.(doc);
      // The server has it: the local copy can go (unless more was typed meanwhile).
      const d = readDraft(slug);
      if (d && d.content === doc.content && d.title === (doc.title ?? "")) {
        try { localStorage.removeItem(DRAFT(slug)); } catch { /* ignore */ }
      }
    },
    onAppend: (md) => api.current?.append(md),
    onRemote: (doc) => {
      setTitle(doc.title);
      setContent(doc.content);
    },
    subscribeLive,
  });
  const props = useMemo(() => readPageProps(content), [content]);
  const lockedForMe = props.locked && !isOwner;
  const readOnly = session.lock.kind !== "mine" || lockedForMe;

  const keepDraft = useCallback((next: { title?: string; content?: string }) => {
    try {
      const prev = readDraft(slug);
      const d: Draft = { title: next.title ?? prev?.title ?? title, content: next.content ?? prev?.content ?? content, rev, at: Date.now() };
      localStorage.setItem(DRAFT(slug), JSON.stringify(d));
    } catch { /* storage full or blocked: the server copy still saves */ }
  }, [slug, title, content, rev]);

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

  const empty = !splitFrontmatter(content).body.trim();
  useEffect(() => {
    if (!empty || templates.length) return;
    listPageTemplates().then((t) => setTemplates(t.filter((x) => x.id !== "blank" && x.content.trim()))).catch(() => {});
  }, [empty, templates.length]);

  // Blob URLs of images uploaded here: shown until the page's own URLs know them.
  useEffect(() => () => local.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const upload = useCallback(
    async (file: File) => {
      if (file.size > PAGE_IMAGE_MAX) throw new Error("Images can be up to 10 MB.");
      if (!file.type.startsWith("image/")) throw new Error("Choose an image file (PNG, JPG, WebP or GIF).");
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
      linkPreview: (u) => linkPreview(u),
      people: workspaceId ? (q) => searchPeople(workspaceId, q) : undefined,
      createSubPage: async (t) => {
        const created = await createPage({ title: t, parent: slug });
        rememberSecret(created);
        return { slug: created.document.slug, title: created.document.title ?? t };
      },
      crumbs,
      pageTitle: title,
      href: (s, ancestors) => pagePath(s, { tenant: addressing.tenant, folderPath: addressing.folderPath, ancestors }),
    }),
    [slug, workspaceId, workspaceName, crumbs, title, addressing.tenant, addressing.folderPath],
  );

  const setBody = useCallback(
    (md: string) => {
      setContent(md);
      session.update({ content: md });
      keepDraft({ content: md });
    },
    [session, keepDraft],
  );
  const setProps = (patch: Partial<PageProps>) => setBody(writePageProps(content, patch));

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

  const fontItem = (f: PageFont, label: string): MenuEntry => ({ label: `${props.font === f ? "✓ " : ""}${label}`, onClick: () => setProps({ font: f }), disabled: readOnly });
  const menu: MenuEntry[] = [
    { label: props.fullWidth ? "Full width: on" : "Full width: off", icon: "expand", onClick: () => setProps({ fullWidth: !props.fullWidth }), disabled: readOnly },
    { label: props.smallText ? "Small text: on" : "Small text: off", icon: "type", onClick: () => setProps({ smallText: !props.smallText }), disabled: readOnly },
    { header: "Font", separated: true },
    fontItem("default", "Default"),
    fontItem("serif", "Serif"),
    fontItem("mono", "Mono"),
    ...(isOwner ? [{ label: props.locked ? "Unlock page" : "Lock page", icon: "lock", description: props.locked ? "Anyone who can edit can change it again" : "Only you and workspace admins can edit", onClick: () => setProps({ locked: !props.locked }), separated: true }] : []),
    { label: "Copy link", icon: "link", separated: !isOwner, onClick: () => void copyText(url ?? window.location.href.split("?")[0]).then((ok) => (ok ? toast.success("Link copied") : toast.error("Couldn't copy"))) },
    ...(onAddSubPage ? [{ label: "Add a sub-page", icon: "plus", onClick: onAddSubPage }] : []),
    { label: mode === "visual" ? "Edit as Markdown" : "Edit with blocks", icon: "code", onClick: () => setMode(mode === "visual" ? "markdown" : "visual") },
    { label: "Open in the classic editor", icon: "lines", description: "The same Markdown, in a text editor", onClick: () => void toClassic(), disabled: switching || readOnly },
    ...(onDelete ? [{ label: "Delete page", icon: "trash", danger: true, separated: true, onClick: onDelete }] : []),
    { header: <span className="pb-meta">{words(content).toLocaleString()} words{updatedAt ? ` · edited ${new Date(updatedAt).toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}</span>, separated: true },
  ];

  const lock = session.lock;
  const layout = [props.smallText && "pb-small", props.font !== "default" && `pb-font-${props.font}`].filter(Boolean).join(" ");
  return (
    <div className={`pb-editor ${layout}`} data-full={props.fullWidth ? "" : undefined}>
      <div className="pb-editor__bar no-print">
        <PageBreadcrumbs crumbs={crumbs} title={title || initialTitle} addressing={addressing} className="min-w-0 flex-1" />
        {!crumbs.length && <span className="flex-1" />}
        {props.locked && <span className="pb-editor__status"><Icon name="lock" size={14} aria-hidden /> Locked</span>}
        {lock.kind === "mine" && !lockedForMe ? <SaveStatus save={session.save} online={online} /> : lock.kind === "acquiring" ? <span className="pb-editor__status"><Spinner size={12} /> Opening…</span> : null}
        <Dropdown aria-label="Page options" align="right" minWidth={280} trigger={<IconButton icon="more" label="Page options" size="sm" variant="ghost" />} items={menu} />
        <Button variant="primary" size="sm" iconLeft="check" onClick={() => void done()}>
          Done
        </Button>
      </div>

      {draft && (
        <Alert
          tone="info"
          title="Unsaved changes from this browser"
          actions={
            <>
              <Button size="sm" variant="secondary" onClick={() => { setTitle(draft.title); session.update({ title: draft.title }); setBody(draft.content); setDraft(null); }}>Restore them</Button>
              <Button size="sm" variant="ghost" onClick={() => { try { localStorage.removeItem(DRAFT(slug)); } catch { /* ignore */ } setDraft(null); }}>Discard</Button>
            </>
          }
        >
          This page was being edited here on {new Date(draft.at).toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} and the server never confirmed those changes.
        </Alert>
      )}
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
      {lockedForMe && lock.kind === "mine" && (
        <Alert tone="info" icon="lock" title="This page is locked">
          Its owner locked it, so it can't be edited. Ask them to unlock it.
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
      {session.save.state === "error" && !session.conflict && lock.kind === "mine" && online && (
        <Alert tone="danger" actions={<Button size="sm" variant="secondary" onClick={session.retry}>Try again</Button>}>
          {session.save.message} Your changes are kept in this browser until they're saved.
        </Alert>
      )}

      <PageHead
        title={title}
        props={props}
        resolve={resolveAsset}
        edit={{
          readOnly,
          upload,
          onProps: setProps,
          onTitle: (t) => {
            setTitle(t);
            session.update({ title: t });
            keepDraft({ title: t });
          },
          onEnter: () => api.current?.focusStart(),
        }}
      />
      {empty && !readOnly && mode === "visual" && (
        <div className="pb-empty no-print" aria-label="Start this page">
          <span>Press “/” for commands, or start with</span>
          {templates.slice(0, 4).map((t) => (
            <button key={t.id} type="button" className="pb-empty__chip md-focus" onClick={() => setBody(splitFrontmatter(content).front + fillTemplate(t.content, { title }))}>
              {t.name}
            </button>
          ))}
        </div>
      )}
      {/* ph-no-capture: the page being written is never recorded (the editor masks itself too). */}
      <div className="ph-no-capture">
        <DocsEditor
          value={content}
          onChange={setBody}
          readOnly={readOnly}
          showHeader={false}
          showModeSwitch={false}
          mode={mode}
          onModeChange={setMode}
          placeholder="Type '/' for commands"
          onUploadImage={readOnly ? undefined : upload}
          resolveAssetUrl={resolveAsset}
          blocks={PAGE_BLOCKS}
          pages={pages}
          darkImages={false}
          apiRef={api}
          stickyTop={stickyTop}
          aria-label="Page content"
          autoFocus={empty}
        />
      </div>
    </div>
  );
}

export default PageEditor;
