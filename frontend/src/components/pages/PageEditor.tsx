"use client";

/**
 * A page for the people who can edit it (a document with `editor: "blocks"`): always editable, no
 * Edit / Done. The Guides editor (components/docs-editor) in the page's frame (PageChrome
 * PageFrame): the sticky top bar (breadcrumbs, who's viewing, Saved / Saving…, Share, ⋯), the head
 * (cover, icon, title) and the body, laid out exactly like the reader's page.
 *
 *   upload       → POST /documents/{slug}/assets, written as ![alt](asset:<id>)
 *   resolveAsset → the page's per-viewer asset URLs (a just-uploaded image shows from memory)
 *   pages        → the embed / mention picker (your files, the page's workspace) and the preview,
 *                  resolved for the author through POST /documents/{slug}/embeds
 *   read only    → while someone else holds the edit lock, or the page is locked
 *
 * One editor at a time (usePageEditSession): the lock is taken on the first key, click or change
 * and let go of after a few idle minutes; autosave runs 2 s after the last change with `base_rev`,
 * and every change is kept in this browser until the server has it (restored after a crash or a
 * reload); an AI app's append_blocks arrives live and goes in at the end without disturbing the
 * caret. On phones, a bottom toolbar (PagePhoneBar) and bottom sheets.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import type { Heading } from "@/components/reading";
import { Alert, Badge, Button, Icon, Switch, copyText, useToast, type MenuEntry } from "@/components/ui";
import { DocsEditor } from "@/components/docs-editor";
import { PAGE_BLOCKS } from "@/components/docs-editor/blocks";
import { splitFrontmatter, writeFrontmatter } from "@/components/docs-editor/core/frontmatter.mjs";
import type { DocsEditorApi, EditorMode, PagesEditorHost } from "@/components/docs-editor/types";
import { getWorkspace } from "@/lib/workspaces";
import { uploadArtifact } from "@/lib/api";
import { assetId, fillTemplate, pagePath } from "@/lib/pageBlocks.mjs";
import { rememberSecret } from "./TemplateGallery";
import { PAGE_IMAGE_MAX, createPage, linkPreview, listPageTemplates, resolveEmbeds, searchPeople, searchMine, searchWorkspace, setEditor, uploadPageAsset, type AssetUrl, type Crumb, type PageDocument, type PageTemplate } from "@/lib/pages";
import { PageEmbed, PageMention } from "./PageEmbed";
import { PageBanner, PageFrame, PageTopBar, SaveIndicator, usePhone, type PageAddressing } from "./PageChrome";
import { PageHead } from "./PageHead";
import { PagePhoneBar } from "./PagePhoneBar";
import { readPageProps, type PageFont, type PageProps } from "./pageProps";
import { writePageProps } from "./pagePropsWrite";
import { usePageEditSession } from "./usePageEditSession";
import { pageEditorAi, suggestPageMeta, usePagesAiStatus, type PageMeta } from "@/lib/pages-ai/client";
import { MetaChip, type MetaState } from "./ai/MetaChip";
import "./ai/pageAi.css";
import { usePageAssets } from "./usePageEmbeds";
import { usePageSignoffs } from "./signoff/store";
import { SignoffSummary } from "./signoff/SignoffSummary";
import { clearPageDraft, dropLegacyPageDraft, readPageDraft, writePageDraft, type PageDraft } from "@/lib/pageDrafts.mjs";
import "./pages.css";
import "./page-blocks.css";

/** What the document view puts around the page (the same for readers). */
export interface PageChromeSlots {
  /** Who's viewing (DocPresence). */
  presence?: ReactNode;
  /** Share (owners and resharers); without it, Copy link. */
  onShare?: (() => void) | null;
  shareUrl?: string;
  onCopied?: () => void;
  /** The document's own ⋯ entries (Export PDF, Details, …), after the page's. */
  menu?: MenuEntry[];
  /** Under the title (backlinks). */
  below?: ReactNode;
  /** Under the body (Pages inside, the colophon). */
  footer?: ReactNode;
  /** Notices at the top of the column (Save to account, …). */
  notices?: ReactNode;
}

export interface PageEditorProps {
  slug: string;
  /** The signed-in account (null: editing with the edit secret alone). Local drafts are its own. */
  userId?: string | null;
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
  /** May edit (and lock / unlock) a locked page: its owner and the workspace's admins (server's `can.edit_locked`). */
  mayEditLocked?: boolean;
  /** The page's address (Copy link). */
  url?: string;
  updatedAt?: string | null;
  /** The document's live socket (useDocumentViewer): `changed` / `appended`. */
  subscribeLive?: (fn: (msg: Record<string, unknown>) => void) => () => void;
  /** Saved: the viewer keeps this version (the tab title, a reader's view if editing stops). */
  onSaved?: (doc: PageDocument) => void;
  /** The editor is on screen (the server-rendered page can go). */
  onReady?: () => void;
  /** Someone else holds the edit lock, as who's viewing says (their name): read only at once. */
  othersEditing?: string | null;
  /** "Add a sub-page" (signed-in editors). */
  onAddSubPage?: (() => void) | null;
  /** Delete the page (the viewer asks what happens to its sub-pages). */
  onDelete?: (() => void) | null;
  /** "Move to…" (under another page, to the top level, or another folder). */
  onMoveTo?: (() => void) | null;
  /** "Duplicate" (after the latest edits are saved). */
  onDuplicate?: (() => void) | null;
  chrome?: PageChromeSlots;
  /**
   * The page's headings as they stand in the editor (for the rail's Contents), with ids
   * `pb-eh-<n>`: the n-th heading in the editor.
   */
  onHeadings?: (headings: Heading[]) => void;
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

// Local drafts are this account's own (lib/pageDrafts.mjs): never offered to anyone else.
type Draft = PageDraft;
const store = () => (typeof window === "undefined" ? null : (() => { try { return window.localStorage; } catch { return null; } })());

/** The Markdown with `description:` in its front matter (AI's suggestion, accepted). */
function writeDescription(md: string, description: string): string {
  const { front, body } = splitFrontmatter(md);
  return writeFrontmatter(front, { description: description.replace(/\s+/g, " ").trim().slice(0, 300) }) + body;
}

/** An untitled page gets a title suggestion once, at about this many words. */
const META_WORDS = 80;

const when = (t: string | number) => new Date(t).toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Default / Serif / Mono, as three "Ag" tiles (the ⋯ menu's first row). */
function FontTiles({ value, onChange, disabled }: { value: PageFont; onChange: (f: PageFont) => void; disabled?: boolean }) {
  const fonts: Array<[PageFont, string]> = [["default", "Default"], ["serif", "Serif"], ["mono", "Mono"]];
  return (
    <div className="pb-fonts" role="radiogroup" aria-label="Font">
      {fonts.map(([f, label]) => (
        <button key={f} type="button" role="radio" aria-checked={value === f} disabled={disabled} className={`pb-fonts__tile pb-fonts__tile--${f} md-focus`} onClick={() => onChange(f)}>
          <span className="pb-fonts__ag" aria-hidden>Ag</span>
          <span className="pb-fonts__name">{label}</span>
        </button>
      ))}
    </div>
  );
}

export function PageEditor({ slug, userId = null, title: initialTitle, content: initialContent, rev, secret = null, workspaceId, crumbs, assets: initialAssets, addressing, isOwner = false, mayEditLocked = false, url, updatedAt, subscribeLive, onSaved, onReady, othersEditing = null, onAddSubPage, onDelete, onMoveTo, onDuplicate, chrome = {}, onHeadings }: PageEditorProps) {
  const toast = useToast();
  const online = useOnline();
  const phone = usePhone();
  const [title, setTitle] = useState(initialTitle ?? "");
  const [content, setContent] = useState(initialContent);
  const [mode, setMode] = useState<EditorMode>("visual");
  const api = useRef<DocsEditorApi | null>(null);
  const [editor, setEditorInstance] = useState<Editor | null>(null);
  const local = useRef(new Map<string, string>());
  const [, setLocalTick] = useState(0);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [templates, setTemplates] = useState<PageTemplate[]>([]);
  // What this browser kept from an earlier visit that the server never confirmed.
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    dropLegacyPageDraft(store(), slug);
    const d = readPageDraft(store(), slug, userId);
    if (d && (d.content !== initialContent || d.title !== (initialTitle ?? ""))) setDraft(d);
    else {
      setDraft(null);
      if (d) clearPageDraft(store(), slug, userId);
    }
  }, [slug, userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const session = usePageEditSession({
    slug,
    secret,
    initial: { title: initialTitle ?? "", content: initialContent, rev },
    onSaved: (doc) => {
      onSaved?.(doc);
      // The server has it: the local copy can go (unless more was typed meanwhile).
      const d = readPageDraft(store(), slug, userId);
      if (d && d.content === doc.content && d.title === (doc.title ?? "")) clearPageDraft(store(), slug, userId);
    },
    onAppend: (md) => api.current?.append(md),
    onRemote: (doc) => {
      setTitle(doc.title);
      setContent(doc.content);
    },
    subscribeLive,
  });
  const props = useMemo(() => readPageProps(content), [content]);
  const lockedForMe = props.locked && !isOwner && !mayEditLocked;
  // Who's viewing already says someone else is editing: read only before anyone clicks.
  const lock = session.lock.kind === "idle" && othersEditing ? { kind: "theirs" as const, name: othersEditing, lost: false } : session.lock;
  const readOnly = lock.kind === "theirs" || lock.kind === "readonly" || lockedForMe;

  // ── AI (lib/pages-ai): the editor's AI for people who can write here; the menu says so when
  // the workspace turned it off.
  const aiStatus = usePagesAiStatus({ slug });
  const ai = useMemo(() => pageEditorAi(slug, aiStatus, secret), [slug, aiStatus, secret]);
  const aiUsable = !!ai && !ai.off;

  const keepDraft = useCallback((next: { title?: string; content?: string }) => {
    // Storage full or blocked: the server copy still saves.
    const prev = readPageDraft(store(), slug, userId);
    writePageDraft(store(), slug, userId, { title: next.title ?? prev?.title ?? title, content: next.content ?? prev?.content ?? content, rev, at: Date.now() });
  }, [slug, userId, title, content, rev]);

  const assets = usePageAssets(slug, initialAssets, content);
  // Sign-offs (components/pages/signoff): their state, the lock on signed blocks, the summary.
  const signoffs = usePageSignoffs(slug, content, { viewer: userId, subscribeLive });

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
  const emptyRef = useRef(empty);
  emptyRef.current = empty;
  const frameRef = useRef<HTMLDivElement>(null);
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
      signoffs,
      // Video, audio and other files: a Markdrop item beside the page (its workspace and folder),
      // embedded with ::markdrop (page assets are images only; DEVIATIONS "Frontend → backend").
      uploadFile: async (file, onProgress) => {
        const r = await uploadArtifact(file, file.name.replace(/\.[a-z0-9]+$/i, ""), {
          onProgress,
          ...(workspaceId ? { workspace: workspaceId, folder: addressing.folderPath.length ? addressing.folderPath.join("/") : null } : { accessLevel: "link" as const }),
        });
        return { slug: r.slug, title: r.title ?? file.name };
      },
      createSubPage: async (t) => {
        const created = await createPage({ title: t, parent: slug });
        rememberSecret(created);
        return { slug: created.document.slug, title: created.document.title ?? t };
      },
      crumbs,
      pageTitle: title,
      href: (s, ancestors) => pagePath(s, { tenant: addressing.tenant, folderPath: addressing.folderPath, ancestors }),
    }),
    [slug, workspaceId, workspaceName, crumbs, title, addressing.tenant, addressing.folderPath, signoffs],
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
  // Nothing left to save and the local copy is what's on screen: the server has it, so it goes (an
  // AI app's append changes the page with no save of ours, so onSaved never drops that copy).
  useEffect(() => {
    if (session.save.state !== "saved") return;
    const d = readPageDraft(store(), slug, userId);
    if (d && d.content === content && d.title === title) clearPageDraft(store(), slug, userId);
  }, [session.save.state, content, title, slug, userId]);

  // AI's commands from the ⋯ menu and the empty page (DocsEditorApi.runAi).
  const runAi = (command: "summary" | "actions" | "write") => {
    if (api.current?.runAi(command)) return;
    toast.info(mode === "markdown" ? "Switch to editing with blocks to use AI." : "Finish the open AI suggestion first.");
  };

  // ── Title, icon and description: AI's suggestion as a chip under the title (never applied by
  // itself). From the ⋯ menu, or once on its own when an untitled page reaches about 80 words.
  const [meta, setMeta] = useState<MetaState | null>(null);
  const metaSeq = useRef(0);
  const askMeta = useCallback(
    (auto: boolean) => {
      if (!aiUsable) return;
      const seq = ++metaSeq.current;
      if (!auto) setMeta({ phase: "loading" });
      suggestPageMeta(slug, secret).then(
        (m) => seq === metaSeq.current && setMeta(m && (m.title || m.icon || m.description) ? { phase: "ready", meta: m } : auto ? null : { phase: "error", message: "No suggestion this time. Write a little more and try again." }),
        (e: unknown) => seq === metaSeq.current && setMeta(auto ? null : { phase: "error", message: e instanceof Error && e.message ? e.message : "AI couldn't suggest a title just now." }),
      );
    },
    [aiUsable, slug, secret],
  );
  // (A page made without a title is called "Untitled".)
  const untitled = !title.trim() || title.trim() === "Untitled";
  const longEnough = untitled && aiUsable && !readOnly ? words(content) >= META_WORDS : false;
  useEffect(() => {
    if (!longEnough || meta) return;
    const key = `md_ai_meta:${slug}`;
    try {
      if (localStorage.getItem(key)) return;
    } catch {
      return;
    }
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(key, "1");
      } catch { /* blocked: asked this once anyway */ }
      askMeta(true);
    }, 1500);
    return () => window.clearTimeout(t);
  }, [longEnough, meta, slug, askMeta]);
  const applyMeta = (m: PageMeta) => {
    metaSeq.current++;
    setMeta(null);
    if (m.title) {
      setTitle(m.title);
      session.update({ title: m.title });
      keepDraft({ title: m.title });
    }
    let next = content;
    if (m.icon && !props.icon) next = writePageProps(next, { icon: m.icon });
    if (m.description) next = writeDescription(next, m.description);
    if (next !== content) setBody(next);
  };

  // The editor is on screen: tell the view once (it drops the server-rendered page).
  const readyOnce = useRef(false);
  const onEditor = useCallback(
    (e: Editor | null) => {
      setEditorInstance(e);
      if (e && !readyOnce.current) {
        readyOnce.current = true;
        onReady?.();
        // A new, empty page: the caret goes to the title (or the body when it has one), once the
        // editor is on screen.
        if (emptyRef.current) {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const t = frameRef.current?.querySelector<HTMLTextAreaElement>("textarea.pb-title");
              if (t && !t.value) t.focus();
              else api.current?.focus();
            }),
          );
        }
      }
    },
    [onReady],
  );
  // The headings as they stand (for the rail's Contents), a moment after the text settles.
  const onHeadingsRef = useRef(onHeadings);
  onHeadingsRef.current = onHeadings;
  useEffect(() => {
    if (!editor || !onHeadingsRef.current) return;
    const t = window.setTimeout(() => {
      const hs = Array.from(frameRef.current?.querySelectorAll<HTMLElement>(".ProseMirror :is(h1, h2, h3, h4)") ?? []);
      onHeadingsRef.current?.(hs.map((h, i) => ({ id: `pb-eh-${i}`, text: (h.textContent ?? "").trim(), depth: Number(h.tagName.slice(1)) })).filter((h) => h.text));
    }, 400);
    return () => window.clearTimeout(t);
  }, [editor, content]);

  // Markdown mode has no visual editor to wait for.
  useEffect(() => {
    if (mode === "markdown" && !readyOnce.current) {
      readyOnce.current = true;
      onReady?.();
    }
  }, [mode, onReady]);

  // A key, a click or a focus in the head or the body takes the edit lock (not the top bar).
  const onActivity = (e: React.SyntheticEvent) => {
    // Read only because who's viewing says someone else is editing: a click still asks (it may be free).
    if (readOnly && !(session.lock.kind === "idle" && othersEditing)) return;
    const t = e.target as Element | null;
    if (!t || t.closest(".pb-barwrap")) return;
    session.activity();
  };

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
    { custom: <FontTiles value={props.font} onChange={(f) => setProps({ font: f })} disabled={readOnly} /> },
    {
      custom: (
        <div className="pb-toggles">
          <Switch label="Small text" checked={props.smallText} disabled={readOnly} onChange={() => setProps({ smallText: !props.smallText })} />
          <Switch label="Full width" checked={props.fullWidth} disabled={readOnly} onChange={() => setProps({ fullWidth: !props.fullWidth })} />
          <Switch label="Readers can export" checked={props.allowExport} disabled={readOnly} onChange={() => setProps({ allowExport: !props.allowExport })} />
        </div>
      ),
      separated: true,
    },
    ...(aiUsable
      ? [
          { label: "Summarize page", icon: "sparkle", description: "A short summary at the top, to accept or discard", separated: true, disabled: readOnly, onClick: () => runAi("summary") },
          { label: "Find action items", icon: "checkSquare", description: "To-dos with owners and dates", disabled: readOnly, onClick: () => runAi("actions") },
          { label: "Suggest title & icon", icon: "type", disabled: readOnly, onClick: () => askMeta(false) },
        ]
      : ai?.off
        ? [{ label: "AI", icon: "sparkle", description: ai.off, disabled: true, separated: true, onClick: () => {} }]
        : []),
    ...(isOwner || mayEditLocked ? [{ label: props.locked ? "Unlock page" : "Lock page", icon: "lock", description: props.locked ? "Anyone who can edit can change it again" : "Only you and workspace admins can edit", onClick: () => setProps({ locked: !props.locked }), separated: true }] : []),
    { label: "Copy link", icon: "link", separated: !(isOwner || mayEditLocked), onClick: () => void copyText(url ?? window.location.href.split("?")[0]).then((ok) => (ok ? toast.success("Link copied") : toast.error("Couldn't copy"))) },
    ...(onAddSubPage ? [{ label: "Add a sub-page", icon: "plus", onClick: onAddSubPage }] : []),
    ...(onMoveTo ? [{ label: "Move to…", icon: "arrowRight", onClick: onMoveTo }] : []),
    ...(onDuplicate ? [{ label: "Duplicate", icon: "copy", description: "A copy beside it, with its sub-pages", onClick: () => void session.flush().then(onDuplicate, onDuplicate) }] : []),
    { label: mode === "visual" ? "Edit as Markdown" : "Edit with blocks", icon: "code", onClick: () => setMode(mode === "visual" ? "markdown" : "visual"), separated: true },
    { label: "Open in the classic editor", icon: "lines", description: "The same Markdown, in a text editor", onClick: () => void toClassic(), disabled: switching || readOnly },
    ...(chrome.menu ?? []),
    ...(onDelete ? [{ label: "Delete page", icon: "trash", danger: true, separated: true, onClick: onDelete }] : []),
    // The footer: the word count, and that pages are in beta.
    {
      header: (
        <span className="pb-meta pb-meta--foot">
          <span>{words(content).toLocaleString()} words{updatedAt ? ` · edited ${when(updatedAt)}` : ""}</span>
          <Badge tone="info" size="sm" upper>Beta</Badge>
        </span>
      ),
      separated: true,
    },
  ];

  const layout = [props.smallText && "pb-small", props.font !== "default" && `pb-font-${props.font}`].filter(Boolean).join(" ");

  const banner =
    lock.kind === "theirs" ? (
      <PageBanner icon="edit">
        <strong className="ph-mask">{lock.name ?? "Someone else"}</strong> is editing — you&apos;ll be able to edit when they&apos;re done.
        {lock.lost ? " What you typed is still on screen and saves once it's yours again." : ""}
      </PageBanner>
    ) : lock.kind === "readonly" ? (
      <PageBanner icon="lock">{lock.message}</PageBanner>
    ) : lockedForMe ? (
      <PageBanner icon="lock">This page is locked by its owner, so it can&apos;t be edited.</PageBanner>
    ) : session.conflict ? (
      <PageBanner
        icon="alert"
        tone="warn"
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={() => void session.resolveConflict("theirs")}>Load the latest</Button>
            <Button size="sm" variant="ghost" onClick={() => void session.resolveConflict("mine")}>Keep mine</Button>
          </>
        }
      >
        Someone saved a newer version while you were editing. Load theirs (your unsaved changes are dropped) or keep yours.
      </PageBanner>
    ) : session.save.state === "error" && online ? (
      <PageBanner icon="alert" tone="warn" actions={<Button size="sm" variant="secondary" onClick={session.retry}>Try again</Button>}>
        {session.save.message} Your changes are kept in this browser until they&apos;re saved.
      </PageBanner>
    ) : null;

  const status = lock.kind === "theirs" || lock.kind === "readonly" || lockedForMe ? null : <SaveIndicator save={session.save} online={online} />;

  return (
    <PageFrame
      layout={layout}
      full={props.fullWidth}
      onKeyDownCapture={onActivity}
      onPointerDownCapture={onActivity}
      onFocusCapture={onActivity}
      bar={
        <PageTopBar
          crumbs={crumbs}
          title={title || initialTitle}
          icon={props.icon}
          resolve={resolveAsset}
          addressing={addressing}
          presence={chrome.presence}
          status={status}
          onShare={chrome.onShare}
          shareUrl={chrome.shareUrl ?? url}
          onCopied={chrome.onCopied}
          menu={menu}
          banner={banner}
        />
      }
      head={
        <PageHead
          title={title}
          props={props}
          resolve={resolveAsset}
          below={
            meta || chrome.below || signoffs?.all().length ? (
              <>
                {meta && !readOnly && <MetaChip state={meta} hasIcon={!!props.icon} onUse={applyMeta} onDismiss={() => { metaSeq.current++; setMeta(null); }} />}
                <SignoffSummary store={signoffs} />
                {chrome.below}
              </>
            ) : undefined
          }
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
      }
      footer={chrome.footer}
      frameRef={frameRef}
      data-editing=""
    >
      {chrome.notices}
      {draft && !readOnly && (
        <Alert
          tone="info"
          title="Unsaved changes from this browser"
          className="pb-notice"
          actions={
            <>
              <Button size="sm" variant="secondary" onClick={() => { setTitle(draft.title); session.update({ title: draft.title }); setBody(draft.content); setDraft(null); }}>Restore them</Button>
              <Button size="sm" variant="ghost" onClick={() => { clearPageDraft(store(), slug, userId); setDraft(null); }}>Discard</Button>
            </>
          }
        >
          This page was being edited here on {when(draft.at)} and the server never confirmed those changes.
        </Alert>
      )}
      {empty && !readOnly && mode === "visual" && (
        <div className="pb-empty no-print" aria-label="Start this page">
          <span>Press “/” for commands, or start with</span>
          {aiUsable && (
            <button type="button" className="pb-empty__chip pb-empty__chip--ai md-focus" onClick={() => runAi("write")}>
              <Icon name="sparkle" size={14} aria-hidden />Write with AI
            </button>
          )}
          {templates.slice(0, aiUsable ? 3 : 4).map((t) => (
            <button key={t.id} type="button" className="pb-empty__chip md-focus" onClick={() => setBody(splitFrontmatter(content).front + fillTemplate(t.content, { title }))}>
              {t.name}
            </button>
          ))}
        </div>
      )}
      {/* ph-no-capture: the page being written is never recorded (the editor masks itself too). */}
      <div className="ph-no-capture pb-editor">
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
          ai={readOnly ? null : ai}
          apiRef={api}
          onEditor={onEditor}
          stickyTop={() => document.querySelector(".pb-barwrap")?.getBoundingClientRect().bottom ?? 44}
          aria-label="Page content"
          autoFocus={false}
        />
      </div>
      {phone && <PagePhoneBar editor={editor} readOnly={readOnly} ai={aiUsable} />}
    </PageFrame>
  );
}

export default PageEditor;
