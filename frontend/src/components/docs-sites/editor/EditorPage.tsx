"use client";

import { ReadMore } from "@/components/ReadMore";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  Alert, Badge, Button, ConfirmDialog, Dialog, Drawer, EmptyState, Field, IconButton, Input, SegmentedControl, Select, Spinner,
  copyText, useToast,
} from "@/components/ui";
import { DocsEditor, preloadDocsEditor, type EditorMode, type UploadImage } from "@/components/docs-editor";
import { useLocationSearch } from "@/components/shell/useLocation";
import { useAuth } from "@/contexts/AuthContext";
import {
  assetPreviewUrl, createPage, deletePage, docsErrorMessage, listPages, saveNav, slugFrom, uploadAsset,
  type NavGroup, type Page, type PageSummary, type PagesResponse, type SaveConflict,
} from "@/lib/docsSites";
import { firstName, timeAgo } from "../format";
import SiteBar, { STUDIO_CHROME_H } from "../SiteBar";
import { useSite } from "../SiteContext";
import PageSidePanel from "./PageSidePanel";
import { PageTree, groupsOf } from "./PageTree";
import { composeDoc, parseDoc, setDocKeys } from "./pageDoc";
import { pathProblem, suggestedPath } from "./pagePath";
import { usePageSession, type LockState, type PageFields, type SaveState } from "./usePageSession";

const MarkdownPreview = dynamic(() => import("@/components/MarkdownPreview"), { ssr: false });

const MODE_KEY = "md_docs_editor_mode";

/** "Draft · saved just now", re-rendered every 30 s so the time stays honest. */
function SaveBadge({ save, lock, onRetry }: { save: SaveState; lock: LockState; onRetry: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);
  // Viewers: the site bar already says "View only".
  if (lock.kind === "readonly") return null;
  if (lock.kind === "theirs") return <Badge size="sm" icon="lock">Read only</Badge>;
  if (save.state === "saving") return <Badge size="sm" aria-live="polite"><Spinner size={11} /> Saving…</Badge>;
  if (save.state === "dirty") return <Badge size="sm" icon="edit">Draft · editing</Badge>;
  if (save.state === "error") {
    return (
      <button type="button" onClick={onRetry} className="md-focus rounded-full" title="Try saving again">
        <Badge size="sm" tone="danger" icon="alertCircle">Not saved · retry</Badge>
      </button>
    );
  }
  return <Badge size="sm" icon="clock">Draft · saved {save.at ? timeAgo(save.at) : "just now"}</Badge>;
}

function moveIn(nav: NavGroup[], id: string, dir: -1 | 1): NavGroup[] {
  return nav.map((g) => {
    const i = g.pages.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= g.pages.length) return g;
    const pages = [...g.pages];
    [pages[i], pages[j]] = [pages[j]!, pages[i]!];
    return { ...g, pages };
  });
}

function moveTo(nav: NavGroup[], id: string, group: string): NavGroup[] {
  return nav.map((g) => (g.group === group ? { ...g, pages: [...g.pages.filter((x) => x !== id), id] } : { ...g, pages: g.pages.filter((x) => x !== id) }));
}

/**
 * /guides/<site>?page=<id> (Editor board): the page tree (locks, unpublished dots, new page,
 * move, delete), the page itself (title, description, then the docs editor in Visual or Markdown
 * mode), and the page panel (address, sidebar, icon, history). Drafts autosave; the top bar says
 * where the draft stands, and Publish… goes to the Publish screen.
 */
export default function EditorPage() {
  const { site, base, canEdit, isAdmin } = useSite();
  const { user } = useAuth();
  const toast = useToast();
  const search = useLocationSearch();
  const wanted = new URLSearchParams(search).get("page");
  const [tree, setTree] = useState<PagesResponse | null>(null);
  const [treeError, setTreeError] = useState("");
  const [mode, setModeState] = useState<EditorMode>("visual");
  const [treeOpen, setTreeOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [deleting, setDeleting] = useState<PageSummary | null>(null);

  // The editor's chunk: start loading it now, while the page tree and the page load.
  useEffect(() => { preloadDocsEditor(); }, []);

  useEffect(() => {
    try {
      const m = localStorage.getItem(MODE_KEY);
      if (m === "visual" || m === "markdown") setModeState(m);
    } catch { /* ignore */ }
  }, []);
  const setMode = (m: EditorMode) => {
    setModeState(m);
    try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ }
  };

  const loadTree = useCallback(async () => {
    try {
      setTree(await listPages(site.id));
      setTreeError("");
    } catch (e) {
      setTreeError(docsErrorMessage(e, "Couldn't load the pages."));
    }
  }, [site.id]);
  useEffect(() => { void loadTree(); }, [loadTree]);
  // Locks and dots move as other people work: refresh the tree every 30 s.
  useEffect(() => {
    const id = window.setInterval(() => { if (document.visibilityState === "visible") void loadTree(); }, 30_000);
    return () => window.clearInterval(id);
  }, [loadTree]);

  const groups = useMemo(() => (tree ? groupsOf(tree.nav, tree.pages) : null), [tree]);
  const firstPage = groups?.find((g) => !g.hidden)?.pages[0]?.id ?? groups?.[0]?.pages[0]?.id ?? null;
  const pageId = wanted && tree?.pages.some((p) => p.id === wanted) ? wanted : wanted && !tree ? wanted : firstPage;

  const hrefFor = useCallback((id: string) => `${base}?page=${encodeURIComponent(id)}`, [base]);
  const open = useCallback((id: string) => {
    window.history.pushState(window.history.state, "", hrefFor(id));
    setTreeOpen(false);
  }, [hrefFor]);

  // The page we land on without ?page= goes into the URL (so reload and share keep it).
  useEffect(() => {
    if (!wanted && firstPage) window.history.replaceState(window.history.state, "", hrefFor(firstPage));
  }, [wanted, firstPage, hrefFor]);

  const onSaved = useCallback((p: Page) => {
    setTree((t) => t && {
      ...t,
      pages: t.pages.map((x) => (x.id === p.id ? { ...x, title: p.title, path: p.path, icon: p.icon ?? null, hidden: p.hidden, has_changes: true } : x)),
    });
  }, []);

  const session = usePageSession({ siteId: site.id, pageId, canEdit, onSaved });
  const { page, fields, lock, save } = session;
  const editable = lock.kind === "mine";
  const summary = tree?.pages.find((p) => p.id === pageId) ?? null;
  const group = groups?.find((g) => g.pages.some((p) => p.id === pageId));

  async function updateNav(next: NavGroup[]) {
    const prev = tree;
    setTree((t) => t && { ...t, nav: next });
    try {
      await saveNav(site.id, next);
    } catch (e) {
      setTree(prev);
      toast.error(docsErrorMessage(e, "The order didn't save."));
    }
  }

  /**
   * The page as one document for the editor (header in the frontmatter, see pageDoc.ts), rebuilt
   * from the fields each time a version is loaded from the server, then the editor's own text.
   */
  const loadedDoc = useMemo(() => (fields ? composeDoc(fields) : ""), [session.loadSeq, page?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [edited, setEdited] = useState<{ seq: number; doc: string } | null>(null);
  const doc = edited && edited.seq === session.loadSeq ? edited.doc : loadedDoc;
  const docRef = useRef(doc);
  docRef.current = doc;
  const seqRef = useRef(session.loadSeq);
  seqRef.current = session.loadSeq;
  const extraRef = useRef<Record<string, unknown>>({});
  extraRef.current = fields?.frontmatter_extra ?? {};

  const onDocChange = useCallback((md: string) => {
    setEdited({ seq: seqRef.current, doc: md });
    session.update(parseDoc(md, extraRef.current));
  }, [session.update]); // eslint-disable-line react-hooks/exhaustive-deps

  // The page panel edits fields; the ones the document carries (icon; hidden only when someone
  // typed it into the frontmatter) are written back into it, the editor's way.
  const onPanelChange = useCallback((patch: Partial<PageFields>) => {
    session.update(patch);
    const keys: Record<string, string | null> = {};
    if ("icon" in patch) keys.icon = patch.icon ?? null;
    if ("hidden" in patch) keys.hidden = null;
    if (Object.keys(keys).length) setEdited({ seq: seqRef.current, doc: setDocKeys(docRef.current, keys) });
  }, [session.update]); // eslint-disable-line react-hooks/exhaustive-deps

  // Images: an upload goes to the site's files; a dark-theme version is stored where the engine
  // looks for it (x.png → x.dark.png). In the editor, /docs-assets/… addresses load through the API.
  const onUploadImage = useCallback<UploadImage>(async (file, info) => (
    await uploadAsset(site.id, file, info.variant === "dark" ? { variant: "dark", for: info.for } : undefined)
  ).url, [site.id]);
  const resolveAssetUrl = useCallback((src: string) => assetPreviewUrl(site.id, src) ?? src, [site.id]);

  const lockBanner = (() => {
    if (lock.kind !== "theirs") return null;
    const who = lock.lock?.name ?? "Someone";
    if (lock.lost) {
      return (
        <Alert
          tone="warning"
          title={`${who} took over this page`}
          actions={
            <>
              {fields && <Button size="sm" variant="secondary" iconLeft="copy" onClick={async () => { if (await copyText(doc)) toast.success("Your text is on the clipboard."); }}>Copy my text</Button>}
              <Button size="sm" variant="secondary" onClick={() => void session.reloadLatest()}>Load their version</Button>
              {isAdmin && <Button size="sm" variant="primary" onClick={() => void session.takeOver().catch((e) => toast.error(docsErrorMessage(e)))}>Take it back</Button>}
            </>
          }
        >
          Your last changes may not be saved. Copy them before loading the latest version.
        </Alert>
      );
    }
    return (
      <Alert
        tone="warning"
        icon="lock"
        title={`${who} is editing this page`}
        actions={isAdmin ? <Button size="sm" variant="secondary" onClick={() => void session.takeOver().catch((e) => toast.error(docsErrorMessage(e)))}>Take over</Button> : undefined}
      >
        You can read it. It opens for editing when {firstName(who)} is done{isAdmin ? ", or take over now (their unsaved typing is lost)" : ""}.{" "}
        <ReadMore topic="studioLocks" />
      </Alert>
    );
  })();

  const crumb = [group && !group.hidden ? group.group : null, fields?.title || summary?.title].filter(Boolean).join(" / ");
  const isHome = page?.path === "/";

  const panel = page && fields ? (
    <PageSidePanel page={page} fields={fields} readOnly={!editable} isHome={isHome} onChange={onPanelChange} onRestore={session.restore} />
  ) : null;

  const treeEl = (
    <>
      {treeError && <Alert tone="danger" className="mb-2">{treeError}</Alert>}
      <PageTree
        groups={groups}
        currentId={pageId}
        myId={user?.id ?? null}
        hrefFor={hrefFor}
        onOpen={open}
        canEdit={canEdit}
        loading={!tree}
        onNewPage={() => setNewOpen(true)}
        onMove={(id, dir) => tree && void updateNav(moveIn(tree.nav, id, dir))}
        onMoveToGroup={(id, g) => tree && void updateNav(moveTo(tree.nav, id, g))}
        onDelete={setDeleting}
      />
    </>
  );

  return (
    <>
      <SiteBar
        section="pages"
        crumb={crumb ? `/ ${crumb}` : undefined}
        status={pageId && fields ? <SaveBadge save={save} lock={lock} onRetry={session.retry} /> : null}
        actions={
          <>
            <Button variant="ghost" size="sm" iconLeft="listTree" className="lg:hidden" onClick={() => setTreeOpen(true)}>Pages</Button>
            <SegmentedControl
              aria-label="Editor mode"
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: "visual", label: "Visual" },
                { value: "markdown", label: "Markdown" },
              ]}
            />
            <Button variant="ghost" size="sm" iconLeft="eye" className="max-sm:hidden" disabled={!fields} onClick={() => setPreview(true)}>Preview</Button>
            <IconButton icon="eye" label="Preview" size="sm" className="sm:hidden" disabled={!fields} onClick={() => setPreview(true)} />
            {canEdit && <Button variant="primary" size="sm" iconLeft="send" href={`${base}/publish`}>Publish…</Button>}
          </>
        }
      />

      <div className="flex min-h-0 min-w-0 flex-1">
        <aside
          className="sticky hidden w-[250px] shrink-0 overflow-y-auto border-r border-border bg-surface px-2.5 py-4 lg:block"
          style={{ top: STUDIO_CHROME_H, height: `calc(100dvh - ${STUDIO_CHROME_H}px)` }}
          onPointerEnter={preloadDocsEditor}
        >
          {treeEl}
        </aside>

        <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 justify-center px-4 pb-16 pt-6 outline-none sm:px-8 sm:pt-10 xl:px-12">
          <div className="flex w-full min-w-0 max-w-[720px] flex-col gap-4">
            {session.loadError && (
              <EmptyState icon="alertCircle" title={session.loadError.status === 404 ? "This page doesn't exist any more" : "We couldn't open this page"} description={session.loadError.message}
                actions={firstPage ? <Button variant="secondary" onClick={() => open(firstPage)}>Open the first page</Button> : undefined} />
            )}
            {tree && tree.pages.length === 0 && (
              <EmptyState icon="doc" title="No pages yet" description="Add the first page of your guide." actions={canEdit ? <Button variant="primary" iconLeft="plus" onClick={() => setNewOpen(true)}>New page</Button> : undefined} />
            )}
            {pageId && !fields && !session.loadError && (
              <div className="flex min-h-[40vh] items-center justify-center" aria-busy="true"><Spinner size={20} label="Loading the page" /></div>
            )}
            {lockBanner}
            {lock.kind === "acquiring" && <p className="flex items-center gap-2 text-[13px] text-text-muted"><Spinner size={12} /> Opening for editing…</p>}

            {fields && page && (
              <>
                <div className="flex items-center justify-between gap-2 lg:hidden">
                  <span className="text-[13px] text-text-muted">{page.path}</span>
                  <Button variant="ghost" size="sm" iconLeft="settings" onClick={() => setPanelOpen(true)}>Page settings</Button>
                </div>
                <DocsEditor
                  key={page.id}
                  aria-label={`Content of ${fields.title || "this page"}`}
                  value={doc}
                  onChange={onDocChange}
                  mode={mode}
                  onModeChange={setMode}
                  showModeSwitch={false}
                  onUploadImage={onUploadImage}
                  resolveAssetUrl={resolveAssetUrl}
                  readOnly={!editable}
                  placeholder="Type / for blocks: callouts, steps, tabs, code, images…"
                />
              </>
            )}
          </div>
        </main>

        <aside aria-label="Page settings" className="sticky hidden w-[300px] shrink-0 overflow-y-auto border-l border-border bg-surface p-5 xl:block" style={{ top: STUDIO_CHROME_H, height: `calc(100dvh - ${STUDIO_CHROME_H}px)` }}>
          {panel}
        </aside>
      </div>

      <Drawer open={treeOpen} onClose={() => setTreeOpen(false)} side="left" width={300} title={site.name}>
        {treeEl}
      </Drawer>
      <Drawer open={panelOpen} onClose={() => setPanelOpen(false)} title="Page settings" width={340}>
        {panel}
      </Drawer>
      {/* Between lg and xl the panel isn't on screen: the same button opens it. */}
      {fields && (
        <div className="fixed bottom-4 right-4 z-20 hidden lg:block xl:hidden">
          <Button variant="secondary" size="sm" iconLeft="settings" onClick={() => setPanelOpen(true)}>Page settings</Button>
        </div>
      )}

      <Drawer open={preview} onClose={() => setPreview(false)} title={fields?.title || "Preview"} description="A quick look at the draft. Callouts, steps and tabs render fully on the published guide." width={760}>
        {fields && (
          <div className="flex flex-col gap-3">
            {fields.description && <p className="text-[16px] text-text-secondary">{fields.description}</p>}
            <MarkdownPreview content={fields.markdown} size="reading" />
          </div>
        )}
      </Drawer>

      <ConflictDialog
        conflict={session.conflict}
        mine={doc}
        onResolve={(c) => void session.resolveConflict(c)}
      />

      <NewPageDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        groups={tree?.nav.map((g) => g.group) ?? []}
        currentGroup={group && !group.hidden ? group.group : undefined}
        afterId={group && !group.hidden ? pageId : null}
        onCreate={async (input) => {
          const p = await createPage(site.id, input);
          await loadTree();
          open(p.id);
          setNewOpen(false);
          toast.success(`${p.title} added as a draft.`);
        }}
      />

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete “${deleting?.title ?? ""}”?`}
        body="If it's on the published guide, it disappears at the next publish. Old links to it stop working."
        confirmLabel="Delete page"
        onConfirm={async () => {
          if (!deleting) return;
          await deletePage(site.id, deleting.id);
          const was = deleting.id;
          setDeleting(null);
          await loadTree();
          if (was === pageId && firstPage && firstPage !== was) open(firstPage);
          toast.success("Page deleted.");
        }}
      />
    </>
  );
}

/** 409 on save: someone saved a newer version since this draft was loaded. */
function ConflictDialog({ conflict, mine, onResolve }: { conflict: SaveConflict | null; mine: string; onResolve: (c: "mine" | "theirs") => void }) {
  const toast = useToast();
  const who = conflict?.updated_by_name ?? "Someone";
  return (
    <Dialog
      open={!!conflict}
      onClose={() => { /* a choice is needed */ }}
      dismissible={false}
      hideClose
      title="Someone saved a newer version"
      description={`${who} saved this page ${conflict?.updated_at ? timeAgo(conflict.updated_at) : "just now"} while you were editing. Your latest changes aren't saved yet.`}
      footer={
        <>
          <Button variant="ghost" iconLeft="copy" onClick={async () => { if (await copyText(mine)) toast.success("Your text is on the clipboard."); }}>Copy my text</Button>
          <Button variant="secondary" onClick={() => onResolve("theirs")}>Use their version</Button>
          <Button variant="primary" onClick={() => onResolve("mine")}>Keep mine</Button>
        </>
      }
    >
      <p className="text-body text-text-secondary">
        <strong className="text-text">Keep mine</strong> saves your text as the newest version; theirs stays in the history.{" "}
        <strong className="text-text">Use their version</strong> drops your unsaved changes (copy them first if you need them).
      </p>
    </Dialog>
  );
}

function NewPageDialog({ open, onClose, groups, currentGroup, afterId, onCreate }: {
  open: boolean;
  onClose: () => void;
  groups: string[];
  currentGroup?: string;
  afterId: string | null;
  onCreate: (input: { title: string; path: string; group?: string; after_page_id?: string }) => Promise<void>;
}) {
  const uid = useId();
  const [title, setTitle] = useState("");
  const [path, setPath] = useState("");
  const pathEdited = useRef(false);
  const [group, setGroup] = useState<string>("");
  const [newGroup, setNewGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setTitle(""); setPath(""); pathEdited.current = false; setNewGroup(""); setError(""); setBusy(false);
    setGroup(currentGroup ?? groups[0] ?? "__new");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const groupName = group === "__new" ? newGroup.trim() : group;
  const autoPath = (t: string, g: string) => suggestedPath(slugFrom(t), g ? slugFrom(g) : "");
  const bad = path && path !== "/" ? pathProblem(path) : "";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New page"
      description={<>It starts as a draft. Readers see it after the next publish. <ReadMore topic="studioPages" /></>}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!title.trim() || !path.startsWith("/") || !!bad || (group === "__new" && !newGroup.trim())}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await onCreate({ title: title.trim(), path, group: groupName || undefined, after_page_id: group === currentGroup && afterId ? afterId : undefined });
              } catch (e) {
                setError(docsErrorMessage(e, "The page wasn't created."));
                setBusy(false);
              }
            }}
          >
            Create page
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Title" htmlFor={`${uid}-t`}>
          <Input value={title} maxLength={120} placeholder="Alert rules" onChange={(e) => { setTitle(e.target.value); if (!pathEdited.current) setPath(autoPath(e.target.value, groupName)); }} />
        </Field>
        <Field label="Group in the sidebar" htmlFor={`${uid}-g`}>
          <Select
            value={group}
            options={[...groups.map((g) => ({ value: g, label: g })), { value: "__new", label: "New group…" }]}
            onChange={(e) => { setGroup(e.target.value); if (!pathEdited.current) setPath(autoPath(title, e.target.value === "__new" ? newGroup : e.target.value)); }}
          />
        </Field>
        {group === "__new" && (
          <Field label="Group name" htmlFor={`${uid}-ng`}>
            <Input value={newGroup} maxLength={60} placeholder="Guides" onChange={(e) => { setNewGroup(e.target.value); if (!pathEdited.current) setPath(autoPath(title, e.target.value)); }} />
          </Field>
        )}
        <Field label="Address" htmlFor={`${uid}-p`} hint="Where the page lives in the guide." error={bad || undefined}>
          <Input mono value={path} spellCheck={false} autoCapitalize="none" onChange={(e) => { pathEdited.current = true; setPath(e.target.value.toLowerCase()); }} />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}
