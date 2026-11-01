"use client";

import { ReadMore } from "@/components/ReadMore";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import {
  Alert, Avatar, Button, ConfirmDialog, Dialog, Drawer, EmptyState, Field, Icon, IconButton, Input, Kbd, SegmentedControl, Select, Spinner,
  copyText, cx, useToast,
} from "@/components/ui";
import {
  DocsEditor, preloadDocsEditor, type ApiOperationOption, type AssistFn, type DocsEditorApi, type EditorMode, type TextAnchor, type UploadImage,
} from "@/components/docs-editor";
import { getApiReference } from "@/lib/docsApiReference";
import { useLocationSearch } from "@/components/shell/useLocation";
import { useAuth } from "@/contexts/AuthContext";
import {
  assetPreviewUrl, createPage, deletePage, docsErrorMessage, listPages, saveNav, slugFrom, uploadAsset,
  type NavGroup, type Page, type PageSummary, type PagesResponse, type SaveConflict,
} from "@/lib/docsSites";
import { commentsSummary, editorAiEdit, editorAiStatus, type EditorAiStatus, type PresencePerson } from "@/lib/guideEditor";
import { guideEvents } from "@/lib/guidesEvents";
import { getPrivate, previewAs, ruleLabel, type PreviewRow, type PrivateState } from "@/lib/guidePrivate";
import { settingsHref } from "../settings/sections";
import { firstName, timeAgo } from "../format";
import { usePublishState } from "../PublishState";
import SiteBar, { STUDIO_CHROME_H } from "../SiteBar";
import { useSite } from "../SiteContext";
import { HEADER_SLOT_ID } from "../studio/StudioShell";
import { CommentsTab, usePageComments } from "./CommentsTab";
import { EditorPanel, type PanelTab } from "./EditorPanel";
import { PageTree, groupsOf } from "./PageTree";
import { moveGroup, movePage, pageToGroup, stepPage } from "./navMove";
import { linkProblem, outlineOf, pageChecks, readMinutes, scanPage, type Check, type CheckContext } from "./pageChecks";
import { composeDoc, parseDoc, setDocKeys } from "./pageDoc";
import { RESERVED_FIRST, pathProblem, suggestedPath } from "./pagePath";
import { usePageSession, type LockState, type PageFields, type SaveState } from "./usePageSession";
import { usePresence } from "./usePresence";
import { opensDark } from "../guideTheme";

// The preview draws the page in the guide's saved design (the engine's pipeline and theme tokens); loaded when opened.
const DraftPreview = dynamic(() => import("./DraftPreview").then((m) => m.DraftPreview), { ssr: false });

const MODE_KEY = "md_docs_editor_mode";
const isMac = () => typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform);

/** "Saved", "Saving…", "Unsaved changes", "Not saved · Retry": quiet, beside the mode switch. */
function SaveStatus({ save, lock, onRetry }: { save: SaveState; lock: LockState; onRetry: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);
  // Viewers: the site bar already says "View only".
  if (lock.kind === "readonly") return null;
  const base = "inline-flex shrink-0 items-center gap-1.5 text-[12px] text-text-muted";
  if (lock.kind === "theirs") return <span className={base}><Icon name="lock" size={13} /> Read only</span>;
  if (save.state === "saving") return <span className={base} aria-live="polite"><Spinner size={11} /> Saving…</span>;
  if (save.state === "dirty") return <span className={base}><Icon name="edit" size={13} /> Unsaved changes</span>;
  if (save.state === "error") {
    return (
      <button type="button" onClick={onRetry} className={cx(base, "md-focus rounded font-semibold text-danger")} title={save.message}>
        <Icon name="alertCircle" size={13} /> Not saved · Retry
      </button>
    );
  }
  return (
    <span className={base} title={`Draft saved${save.at ? ` ${timeAgo(save.at)}` : ""}. Readers see it after you publish.`}>
      <Icon name="checkCircle" size={13} /> Saved
    </span>
  );
}

/** Where the sticky studio header and site bar end (the site bar wraps to two or three rows below lg). */
function chromeBottom(): number {
  const bar = document.querySelector<HTMLElement>('nav[aria-label="Guide"]')?.parentElement;
  return bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : STUDIO_CHROME_H;
}

/** The guide's API reference operations, offered by the editor's API endpoint block (none without one). */
function useApiOperations(siteId: string, specId: string | null): ApiOperationOption[] {
  const [ops, setOps] = useState<ApiOperationOption[]>([]);
  useEffect(() => {
    if (!specId) {
      setOps([]);
      return;
    }
    let on = true;
    getApiReference(siteId)
      .then((s) => on && setOps(s.nav.flatMap((g) => g.items.filter((i) => i.method && i.path).map((i) => ({ op: `${i.method} ${i.path}`, summary: i.title })))))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [siteId, specId]);
  return ops;
}

/** Is the window at least `px` wide (the side panels' breakpoints)? */
function useWide(px: number): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${px}px)`);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [px]);
  return wide;
}

/** "Asha is here" with their avatars, in the studio header (each opens the page they're on). */
function PresenceBar({ people, onOpen }: { people: PresencePerson[]; onOpen: (pageId: string) => void }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById(HEADER_SLOT_ID)), []);
  if (!slot || !people.length) return null;
  const names = people.map((p) => firstName(p.name));
  const text = names.length === 1 ? `${names[0]} is here` : names.length === 2 ? `${names[0]} and ${names[1]} are here` : `${names[0]} and ${names.length - 1} others are here`;
  return createPortal(
    <div className="mr-1 flex items-center gap-2" aria-label="Also on this guide">
      <span className="flex -space-x-1.5">
        {people.slice(0, 3).map((p) => {
          const where = p.page_title ? `${p.editing ? "editing" : "on"} “${p.page_title}”` : "on this guide";
          return (
            <button
              key={p.user_id}
              type="button"
              disabled={!p.page_id}
              onClick={() => p.page_id && onOpen(p.page_id)}
              title={`${p.name} · ${where}`}
              className="md-focus rounded-full ring-2 ring-surface disabled:cursor-default"
            >
              <Avatar name={p.name} size="sm" status={p.editing ? "online" : "away"} />
              <span className="md-visually-hidden">{p.name}, {where}</span>
            </button>
          );
        })}
      </span>
      <span className="ph-sensitive ph-mask hidden text-[12px] text-text-muted xl:inline">{text}</span>
    </div>,
    slot,
  );
}

const SHORTCUTS: Array<{ group: string; rows: Array<[string, string[]]> }> = [
  {
    group: "Text",
    rows: [
      ["Bold", ["mod", "B"]],
      ["Italic", ["mod", "I"]],
      ["Strikethrough", ["mod", "⇧", "S"]],
      ["Inline code", ["mod", "E"]],
      ["Link", ["mod", "K"]],
      ["Keyboard key", ["mod", "⇧", "K"]],
    ],
  },
  {
    group: "Blocks",
    rows: [
      ["Block menu", ["/"]],
      ["Heading, subheading", ["mod", "alt", "2 / 3"]],
      ["Bulleted list", ["mod", "⇧", "8"]],
      ["Numbered list", ["mod", "⇧", "7"]],
      ["Quote", ["mod", "⇧", "B"]],
      ["Code block", ["mod", "alt", "C"]],
      ["Move a block", ["alt", "⇧", "↑ / ↓"]],
      ["Move a card (on its grip)", ["alt", "← / →"]],
      ["Line break", ["⇧", "Enter"]],
    ],
  },
  {
    group: "Page",
    rows: [
      ["Find and replace", ["mod", "F"]],
      ["Next / previous match", ["Enter", "⇧ Enter"]],
      ["Undo", ["mod", "Z"]],
      ["Redo", ["mod", "⇧", "Z"]],
      ["Send a comment or reply", ["mod", "Enter"]],
      ["Keyboard shortcuts", ["?"]],
    ],
  },
  {
    group: "Page tree (on a page's grip)",
    rows: [
      ["Pick up / drop", ["Space"]],
      ["Move", ["↑ / ↓"]],
      ["Cancel", ["Esc"]],
    ],
  },
];

function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mac = isMac();
  const key = (k: string) => (k === "mod" ? (mac ? "⌘" : "Ctrl") : k === "alt" ? (mac ? "⌥" : "Alt") : k);
  return (
    <Dialog open={open} onClose={onClose} size="xl" title="Keyboard shortcuts" description="In the page editor. Markdown shortcuts work too: ## for a heading, - for a list, > for a quote, ``` for code.">
      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        {SHORTCUTS.map((g) => (
          <section key={g.group} className={cx("flex flex-col gap-1", g.group === "Blocks" && "sm:row-span-2")}>
            <h3 className="pb-1 text-[12px] font-semibold text-text-muted">{g.group}</h3>
            {g.rows.map(([label, keys]) => (
              <div key={label} className="flex items-center justify-between gap-3 py-1 text-[13px] text-text">
                <span>{label}</span>
                <span className="flex shrink-0 gap-1">{keys.map((k) => <Kbd key={k}>{key(k)}</Kbd>)}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Dialog>
  );
}

/** A check's Fix for an image without a description. */
function AltTextDialog({ src, onClose, onSave }: { src: string | null; onClose: () => void; onSave: (alt: string) => void }) {
  const [alt, setAlt] = useState("");
  const uid = useId();
  useEffect(() => {
    if (!src) return;
    const name = src.split(/[/?#]/).filter(Boolean).pop() ?? "";
    setAlt(name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/, (c) => c.toUpperCase()));
  }, [src]);
  return (
    <Dialog
      open={!!src}
      onClose={onClose}
      title="Describe the image"
      description="A short sentence about what it shows. Screen readers read it out, and search engines use it."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!alt.trim()} onClick={() => onSave(alt.trim())}>Save description</Button>
        </>
      }
    >
      <Field label="Description" htmlFor={`${uid}-alt`}>
        <Input id={`${uid}-alt`} className="ph-no-capture" value={alt} maxLength={250} autoFocus onChange={(e) => setAlt(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && alt.trim()) onSave(alt.trim()); }} />
      </Field>
    </Dialog>
  );
}

/** The bar under the page: words and reading time, Find and replace, Shortcuts. */
function StatusBar({ words, onFind, onShortcuts }: { words: number; onFind: () => void; onShortcuts: () => void }) {
  const mins = readMinutes(words);
  return (
    <div className="sticky bottom-0 z-10 mt-auto flex h-[34px] shrink-0 items-center gap-4 border-t border-border bg-surface px-4 text-[12px] text-text-muted sm:px-5">
      <span aria-live="off">{words.toLocaleString("en")} {words === 1 ? "word" : "words"}{mins ? ` · ${mins} min read` : ""}</span>
      <span className="flex-1" />
      <button type="button" onClick={onFind} className="md-focus inline-flex items-center gap-1.5 rounded hover:text-text">
        <Kbd>{isMac() ? "⌘F" : "Ctrl F"}</Kbd><span className="max-sm:hidden">Find and replace</span><span className="sm:hidden">Find</span>
      </button>
      <button type="button" onClick={onShortcuts} className="md-focus inline-flex items-center gap-1.5 rounded hover:text-text max-sm:hidden">
        <Kbd>?</Kbd>Shortcuts
      </button>
    </div>
  );
}

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

/**
 * /guides/<site>?page=<id> (Editor board): the page tree (search, groups, icons, a dot on what
 * changed since the last publish, locks), the page (breadcrumb, title, description, then the docs
 * editor in Visual or Markdown mode, with Find and replace, Ask AI, comments and inline problems;
 * a status bar under it), and the page panel (Checks with "On this page", Page settings, Comments,
 * History; who else is editing what). Drafts autosave; Publish is in the site bar.
 */
export default function EditorPage() {
  const { site, base, canEdit, isAdmin, reload: reloadSite } = useSite();
  const apiOps = useApiOperations(site.id, site.settings.api?.spec_id ?? null);
  const { user } = useAuth();
  const toast = useToast();
  const search = useLocationSearch();
  const wanted = new URLSearchParams(search).get("page");
  const [tree, setTree] = useState<PagesResponse | null>(null);
  // The tree as it is now, for callbacks that outlive a render (a toast's Undo).
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const [treeError, setTreeError] = useState("");
  const [mode, setModeState] = useState<EditorMode>("visual");
  const [treeOpen, setTreeOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [tab, setTab] = useState<PanelTab>("checks");
  const [preview, setPreview] = useState(false);
  // The preview's light/dark: the guide's own default (a dark-first or dark-only design opens dark).
  const [previewDark, setPreviewDark] = useState(() => opensDark(site.settings.theme));
  useEffect(() => setPreviewDark(opensDark(site.settings.theme)), [site.settings.theme]);
  // Opening the preview re-reads the guide, so a design saved in another tab (or by someone else) shows.
  useEffect(() => {
    if (preview) void reloadSite();
  }, [preview, reloadSite]);
  const [newOpen, setNewOpen] = useState(false);
  const [newInit, setNewInit] = useState<{ title: string; path?: string; stay?: boolean }>({ title: "" });
  const [deleting, setDeleting] = useState<PageSummary | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [altFor, setAltFor] = useState<string | null>(null);
  const editorApi = useRef<DocsEditorApi | null>(null);
  const panelWide = useWide(1280);

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

  // Open comments per page (the tree's count), for the roles that see comments.
  const [talk, setTalk] = useState<Record<string, number>>({});
  const loadTalk = useCallback(() => {
    if (!canEdit) return;
    commentsSummary(site.id).then((r) => setTalk(r.pages)).catch(() => {});
  }, [site.id, canEdit]);
  useEffect(() => { loadTalk(); }, [loadTalk]);

  // Locks and dots move as other people work: refresh the tree every 30 s.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadTree();
      loadTalk();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [loadTree, loadTalk]);

  const groups = useMemo(() => (tree ? groupsOf(tree.nav, tree.pages) : null), [tree]);

  // ── Private pages (Settings › Private pages): the rules for the Page tab and private sections,
  // and which pages are private, for the tree's badges. As of the drafts saved on the server.
  const [priv, setPriv] = useState<PrivateState | null>(null);
  const [privRows, setPrivRows] = useState<PreviewRow[] | null>(null);
  useEffect(() => {
    if (!canEdit) return;
    getPrivate(site.id).then(setPriv).catch(() => setPriv(null));
  }, [site.id, canEdit]);
  useEffect(() => {
    if (!canEdit || !tree) return;
    previewAs(site.id, "public").then((r) => setPrivRows(r.pages)).catch(() => setPrivRows(null));
  }, [site.id, canEdit, tree]);
  const editorRules = useMemo(() => priv?.rules.map((r) => ({ id: r.id, name: r.name, kind: r.kind })), [priv]);
  const privateLabels = useMemo(() => {
    if (!tree || !privRows || !priv) return undefined;
    const byPath = new Map(privRows.filter((r) => r.rule).map((r) => [r.path, r.rule!]));
    const out: Record<string, string> = {};
    for (const p of tree.pages) {
      const rid = byPath.get(p.path);
      if (rid) {
        const r = priv.rules.find((x) => x.id === rid);
        out[p.id] = r ? ruleLabel(r) : rid;
      }
    }
    return out;
  }, [tree, privRows, priv]);
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

  const { refreshSoon } = usePublishState();
  const onSaved = useCallback((p: Page) => {
    // The site bar's "Publish N changes" counts this one too.
    refreshSoon();
    setTree((t) => t && {
      ...t,
      pages: t.pages.map((x) => (x.id === p.id ? { ...x, title: p.title, path: p.path, icon: p.icon ?? null, hidden: p.hidden, has_changes: true, published: p.published ?? x.published } : x)),
    });
  }, [refreshSoon]);

  const session = usePageSession({ siteId: site.id, pageId, canEdit, onSaved });
  const { page, fields, lock, save } = session;
  const editable = lock.kind === "mine";
  const people = usePresence(site.id, pageId);

  // ?preview=1 (the site bar's Preview, Design's "Preview the guide", the Guides home's Preview):
  // open the page's preview once the page is here. Remembered as soon as it's seen: landing without
  // ?page= rewrites the address to the first page's (dropping ?preview=1) before that page loads.
  const wantsPreview = new URLSearchParams(search).get("preview") === "1";
  const [previewPending, setPreviewPending] = useState(false);
  useEffect(() => {
    if (wantsPreview) setPreviewPending(true);
  }, [wantsPreview, search]);
  useEffect(() => {
    if (!previewPending || !fields) return;
    setPreviewPending(false);
    setPreview(true);
  }, [previewPending, fields]);
  // ?new=<title> (Insights › "Write a page"): open New page with the title filled in, once the
  // page tree is here (for its groups), then take it out of the address.
  const askedNew = new URLSearchParams(search).get("new");
  useEffect(() => {
    if (askedNew == null || !tree) return;
    if (canEdit) {
      setNewInit({ title: askedNew.slice(0, 120) });
      setNewOpen(true);
    }
    const p = new URLSearchParams(window.location.search);
    p.delete("new");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${p.size ? `?${p}` : ""}`);
  }, [askedNew, tree, canEdit]);
  const summary = tree?.pages.find((p) => p.id === pageId) ?? null;
  const group = groups?.find((g) => g.pages.some((p) => p.id === pageId));

  /** Saves a new order (the tree shows it at once); `moved` says what moved, with Undo. */
  async function updateNav(next: NavGroup[], moved?: string) {
    const prev = treeRef.current;
    if (!prev || next === prev.nav) return;
    setTree((t) => t && { ...t, nav: next });
    try {
      await saveNav(site.id, next);
    } catch (e) {
      setTree(prev);
      toast.error(docsErrorMessage(e, "The order didn't save."));
      return;
    }
    if (moved) toast.success(moved, { action: { label: "Undo", onClick: () => void updateNav(prev.nav) } });
  }
  const pageTitle = (id: string) => tree?.pages.find((p) => p.id === id)?.title || "Untitled";

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

  // The page panel edits fields; the ones the document carries (icon, description; hidden only when
  // someone typed it into the frontmatter) are written back into it, the editor's way.
  const onPanelChange = useCallback((patch: Partial<PageFields>) => {
    session.update(patch);
    const keys: Record<string, string | null> = {};
    if ("icon" in patch) keys.icon = patch.icon ?? null;
    if ("description" in patch) keys.description = patch.description ?? "";
    if ("hidden" in patch) keys.hidden = null;
    // Who can open the page (PageAccess): the frontmatter's `access` key.
    if (patch.frontmatter_extra && (patch.frontmatter_extra.access ?? null) !== (extraRef.current.access ?? null)) {
      const v = patch.frontmatter_extra.access;
      keys.access = typeof v === "string" && v ? v : null;
    }
    if (Object.keys(keys).length) setEdited({ seq: seqRef.current, doc: setDocKeys(docRef.current, keys) });
  }, [session.update]); // eslint-disable-line react-hooks/exhaustive-deps

  // Images: an upload goes to the site's files; a dark-theme version is stored where the engine
  // looks for it (x.png → x.dark.png). In the editor, /docs-assets/… addresses load through the API.
  const onUploadImage = useCallback<UploadImage>(async (file, info) => (
    await uploadAsset(site.id, file, info.variant === "dark" ? { variant: "dark", for: info.for } : undefined)
  ).url, [site.id]);
  const resolveAssetUrl = useCallback((src: string) => assetPreviewUrl(site.id, src) ?? src, [site.id]);

  // ── Ask AI ──
  const [ai, setAi] = useState<EditorAiStatus | null>(null);
  useEffect(() => {
    if (!canEdit) return;
    editorAiStatus(site.id).then(setAi).catch(() => setAi(null));
  }, [site.id, canEdit]);
  const aiOn = !!ai && ai.reason !== "disabled" && ai.reason !== "not_configured";
  const assist = useMemo<AssistFn | undefined>(() => (aiOn ? async (req) => {
    const r = await editorAiEdit(site.id, { ...req, page_id: pageId ?? undefined });
    setAi((a) => a && { ...a, used_today: r.used_today, limit_today: r.limit_today });
    return r.markdown;
  } : undefined), [aiOn, site.id, pageId]);

  // ── Checks, outline, words ──
  const scan = useMemo(() => (fields ? scanPage(fields.markdown) : null), [fields?.markdown]); // eslint-disable-line react-hooks/exhaustive-deps
  const checkCtx = useMemo<CheckContext>(() => ({
    path: fields?.path ?? summary?.path ?? "/",
    pages: (tree?.pages ?? []).map((p) => ({ id: p.id, path: p.id === pageId && fields ? fields.path : p.path, title: p.title, published: p.published ?? true })),
    redirects: (site.settings.redirects ?? []).map((r) => r.from),
    reserved: (s) => RESERVED_FIRST.has(s),
  }), [fields?.path, summary?.path, tree, pageId, site.settings.redirects]); // eslint-disable-line react-hooks/exhaustive-deps
  const checks = useMemo(() => (scan ? pageChecks(scan, checkCtx) : []), [scan, checkCtx]);
  const checkLink = useCallback((href: string) => {
    const p = linkProblem(href, checkCtx);
    return p ? { message: p.message } : null;
  }, [checkCtx]);
  const outline = useMemo(() => (scan ? outlineOf(scan) : []), [scan]);

  // The section you're reading (visual mode): the last outline heading above the fold.
  const [activeHeading, setActiveHeading] = useState(0);
  const headingEls = () => Array.from(document.querySelectorAll<HTMLElement>(".dxe-content > h2, .dxe-content > h3")).filter((h) => h.textContent?.trim());
  useEffect(() => {
    if (mode !== "visual") return;
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const line = chromeBottom() + 96;
        let i = 0;
        headingEls().forEach((h, k) => { if (h.getBoundingClientRect().top <= line) i = k; });
        setActiveHeading(i);
      });
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", on);
    };
  }, [mode, outline.length, page?.id]);
  const onOutline = (i: number) => {
    const o = outline[i];
    if (!o) return;
    if (!panelWide) setPanelOpen(false);
    const el = mode === "visual" ? headingEls()[i] : null;
    if (el) {
      window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - chromeBottom() - 24, behavior: "smooth" });
      setActiveHeading(i);
    } else {
      editorApi.current?.reveal({ kind: "heading", text: o.text, level: o.level, nth: o.nth });
    }
  };

  const onShow = (c: Check) => {
    if (!c.target) return;
    if (!panelWide) setPanelOpen(false);
    // After the drawer has gone (its focus return would take the selection away).
    window.setTimeout(() => {
      if (!editorApi.current?.reveal(c.target!)) toast.info("That isn't on the page any more.");
    }, panelWide ? 0 : 220);
  };
  const onFix = (c: Check) => {
    if (!c.fix || !editable) return;
    if (c.fix.kind === "create_page") {
      setNewInit({ title: c.fix.title, path: c.fix.path, stay: true });
      setNewOpen(true);
    } else if (c.fix.kind === "image_alt") {
      setAltFor(c.fix.src);
    } else if (editorApi.current?.removeEmptyHeadings()) {
      guideEvents.checkFixed("heading_empty");
      toast.success("Empty headings removed.");
    }
  };

  // ── Comments ──
  const comments = usePageComments(site.id, pageId, canEdit);
  const [draft, setDraft] = useState<TextAnchor | null>(null);
  const [activeComment, setActiveComment] = useState<string | null>(null);
  useEffect(() => {
    setDraft(null);
    setActiveComment(null);
  }, [pageId]);
  const showPanel = useCallback((t: PanelTab) => {
    setTab(t);
    if (!window.matchMedia("(min-width: 1280px)").matches) setPanelOpen(true);
  }, []);
  const onComment = useCallback((a: TextAnchor) => {
    setDraft(a);
    showPanel("comments");
  }, [showPanel]);
  const onCommentClick = useCallback((id: string) => {
    setActiveComment(id);
    showPanel("comments");
  }, [showPanel]);
  const highlights = useMemo(
    () => (comments.comments ?? []).filter((c) => !c.resolved).map((c) => ({ id: c.id, quote: c.quote, prefix: c.prefix ?? undefined, active: c.id === activeComment })),
    [comments.comments, activeComment],
  );
  // The last text selected in the page (any mode, read only too): "Comment on selection" uses it.
  const lastSelection = useRef<TextAnchor | null>(null);
  useEffect(() => {
    const on = () => {
      const ta = document.activeElement as HTMLTextAreaElement | null;
      if (ta?.classList?.contains("dxe-source__text")) {
        const q = ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
        if (q) lastSelection.current = { quote: q.slice(0, 500), prefix: ta.value.slice(Math.max(0, ta.selectionStart - 40), ta.selectionStart), suffix: ta.value.slice(ta.selectionEnd, ta.selectionEnd + 40) };
        return;
      }
      const sel = window.getSelection();
      const root = document.querySelector(".dxe-content");
      if (!sel || sel.isCollapsed || !root || !sel.anchorNode || !root.contains(sel.anchorNode)) return;
      const quote = sel.toString().trim();
      if (!quote) return;
      const range = sel.getRangeAt(0);
      const block = (range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement)?.closest("p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote");
      let prefix = "";
      if (block) {
        const r = document.createRange();
        r.setStart(block, 0);
        r.setEnd(range.startContainer, range.startOffset);
        prefix = r.toString().slice(-40);
      }
      lastSelection.current = { quote: quote.slice(0, 500), prefix, suffix: "" };
    };
    document.addEventListener("selectionchange", on);
    return () => document.removeEventListener("selectionchange", on);
  }, []);
  const commentOnSelection = () => {
    const s = lastSelection.current;
    if (!s) return toast.info("Select some text in the page first, then press Comment.");
    setDraft(s);
    lastSelection.current = null;
  };

  // ── Keys: ⌘F anywhere on the editor screen, ? for the shortcuts ──
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const mod = isMac() ? e.metaKey : e.ctrlKey;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f" && editorApi.current) {
        e.preventDefault();
        editorApi.current.openFind();
      } else if ((e.key === "?" && !mod && !typing(e.target)) || (mod && e.key === "/")) {
        e.preventDefault();
        setShortcuts(true);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

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
        You can read it{canEdit ? " and comment on it" : ""}. It opens for editing when {firstName(who)} is done{isAdmin ? ", or take over now (their unsaved typing is lost)" : ""}.{" "}
        <ReadMore topic="studioLocks" />
      </Alert>
    );
  })();

  const isHome = page?.path === "/";
  const groupName = group && !group.hidden ? group.group : null;
  const title = fields?.title || summary?.title || "";
  const crumb = (
    <nav aria-label="Breadcrumb" className="ph-no-capture flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 pb-1 text-[12px] text-text-muted">
      {groupName && <><span className="truncate">{groupName}</span><Icon name="chevronRight" size={11} /></>}
      <span className="truncate">{title || "Untitled"}</span>
      {fields && <span className="ml-1.5 truncate font-mono" title={fields.path}>{fields.path}</span>}
    </nav>
  );

  // Other people editing pages of this guide right now (the page locks), for the panel's footer.
  const editingNow = useMemo(() => (tree?.pages ?? [])
    .filter((p) => p.lock && p.lock.user_id !== user?.id)
    .map((p) => ({ name: p.lock!.name, title: p.title || p.path, here: people.some((x) => x.user_id === p.lock!.user_id) })), [tree, user?.id, people]);

  const panel = page && fields ? (
    <EditorPanel
      tab={tab}
      onTab={setTab}
      page={page}
      fields={fields}
      readOnly={!editable}
      isHome={isHome}
      onChange={onPanelChange}
      onRestore={session.restore}
      checks={checks}
      onShow={onShow}
      onFix={onFix}
      outline={outline}
      activeHeading={activeHeading}
      onOutline={onOutline}
      mode={mode}
      commentCount={comments.open}
      comments={canEdit ? (
        <CommentsTab
          api={comments}
          draft={draft}
          onDraftDone={() => { setDraft(null); loadTalk(); }}
          active={activeComment}
          onActive={setActiveComment}
          onShow={(c) => {
            if (!panelWide) setPanelOpen(false);
            window.setTimeout(() => editorApi.current?.reveal({ kind: "quote", quote: c.quote, prefix: c.prefix ?? undefined }), panelWide ? 0 : 220);
          }}
          onCommentSelection={commentOnSelection}
        />
      ) : null}
      footer={{ editedBy: page.updated_by_name ?? null, editedAt: page.updated_at ?? null, editing: editingNow }}
      access={priv ? (() => {
        const group = tree?.nav.find((g) => g.pages.includes(page.id))?.group ?? null;
        return { rules: priv.rules, group, groupRule: group ? priv.groups[group] ?? null : null, settingsHref: settingsHref(base, "private"), guidePrivate: site.settings.access.level !== "public" };
      })() : undefined}
    />
  ) : null;

  const treeEl = (
    <>
      {treeError && <Alert tone="danger" className="mb-2">{treeError}</Alert>}
      <PageTree
        siteId={site.id}
        groups={groups}
        currentId={pageId}
        myId={user?.id ?? null}
        hrefFor={hrefFor}
        onOpen={open}
        canEdit={canEdit}
        loading={!tree}
        comments={talk}
        privateLabels={privateLabels}
        onNewPage={() => { setNewInit({ title: "" }); setNewOpen(true); }}
        onMove={(id, dir) => tree && void updateNav(stepPage(tree.nav, id, dir))}
        onMoveToGroup={(id, g) => tree && void updateNav(pageToGroup(tree.nav, id, g), `Moved “${pageTitle(id)}” to ${g}.`)}
        onDropPage={(id, g, beforeId) => {
          if (!tree) return;
          const pages = tree.nav.find((x) => x.group === g)?.pages ?? [];
          const at = beforeId ? pages.indexOf(beforeId) : -1;
          const from = tree.nav.find((x) => x.pages.includes(id))?.group;
          void updateNav(movePage(tree.nav, id, g, at < 0 ? pages.length : at), from === g ? `Moved “${pageTitle(id)}”.` : `Moved “${pageTitle(id)}” to ${g}.`);
        }}
        onDropGroup={(from, to) => tree && void updateNav(moveGroup(tree.nav, from, to), `Moved the group ${tree.nav[from]?.group ?? ""}.`)}
        onDelete={setDeleting}
      />
    </>
  );

  const problems = checks.filter((c) => c.kind !== "ok").length;
  const sideH = { top: STUDIO_CHROME_H, height: `calc(100dvh - ${STUDIO_CHROME_H}px)` };

  return (
    <>
      <SiteBar
        section="pages"
        preview={false}
        status={pageId && fields ? <SaveStatus save={save} lock={lock} onRetry={session.retry} /> : null}
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
            <Button variant="ghost" size="sm" iconLeft="eye" className="max-xl:hidden" disabled={!fields} onClick={() => setPreview(true)}>Preview</Button>
            <IconButton icon="eye" label="Preview" size="sm" className="xl:hidden" disabled={!fields} onClick={() => setPreview(true)} />
            {fields && (
              <Button variant="ghost" size="sm" iconLeft="columns" className="xl:hidden" title="Checks, page settings, comments and history" onClick={() => setPanelOpen(true)}>
                Page{problems ? <span className="ml-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-warning-soft px-1 text-[10px] font-bold text-warning">{problems}</span> : null}
              </Button>
            )}
          </>
        }
      />
      <PresenceBar people={people} onOpen={open} />

      <div className="flex min-h-0 min-w-0 flex-1 bg-surface">
        <aside
          aria-label="Pages"
          className="sticky hidden w-[248px] shrink-0 overflow-y-auto border-r border-border bg-surface px-2.5 pt-3 lg:block"
          style={sideH}
          onPointerEnter={preloadDocsEditor}
        >
          {treeEl}
        </aside>

        <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none" style={{ minHeight: `calc(100dvh - ${STUDIO_CHROME_H}px)` }}>
          <div className="flex flex-1 justify-center px-4 pb-20 pt-6 sm:px-8 sm:pt-11 xl:px-10">
            <div className="flex w-full min-w-0 max-w-[756px] flex-col gap-4">
              {session.loadError && (
                <EmptyState icon="alertCircle" title={session.loadError.status === 404 ? "This page doesn't exist any more" : "We couldn't open this page"} description={session.loadError.message}
                  actions={<>
                    {session.loadError.status !== 404 && <Button variant="primary" iconLeft="refresh" onClick={session.reload}>Try again</Button>}
                    {firstPage && firstPage !== pageId && <Button variant="secondary" onClick={() => open(firstPage)}>Open the first page</Button>}
                  </>} />
              )}
              {tree && tree.pages.length === 0 && (
                <EmptyState icon="doc" title="No pages yet" description="Add the first page of your guide." actions={canEdit ? <Button variant="primary" iconLeft="plus" onClick={() => { setNewInit({ title: "" }); setNewOpen(true); }}>New page</Button> : undefined} />
              )}
              {pageId && !fields && !session.loadError && (
                <div className="flex min-h-[40vh] items-center justify-center" aria-busy="true"><Spinner size={20} label="Loading the page" /></div>
              )}
              <div className={cx(mode === "visual" && "sm:pl-14")}>{lockBanner}</div>
              {lock.kind === "acquiring" && <p className={cx("flex items-center gap-2 text-[13px] text-text-muted", mode === "visual" && "sm:pl-14")}><Spinner size={12} /> Opening for editing…</p>}

              {fields && page && (
                <DocsEditor
                  key={page.id}
                  // Not recorded, clicks not autocaptured: both modes hold the customer's own words.
                  className="ph-no-capture dxe-root--guides"
                  aria-label={`Content of ${fields.title || "this page"}`}
                  value={doc}
                  onChange={onDocChange}
                  mode={mode}
                  onModeChange={setMode}
                  showModeSwitch={false}
                  headerIcon={false}
                  headerTop={crumb}
                  onUploadImage={onUploadImage}
                  resolveAssetUrl={resolveAssetUrl}
                  readOnly={!editable}
                  placeholder="Type / for blocks: callouts, steps, tabs, code, images…"
                  operations={apiOps}
                  accessRules={editorRules}
                  stickyTop={chromeBottom}
                  apiRef={editorApi}
                  assist={editable ? assist : undefined}
                  assistLanguages={ai?.languages}
                  onComment={canEdit ? onComment : undefined}
                  comments={canEdit ? highlights : undefined}
                  onCommentClick={onCommentClick}
                  checkLink={checkLink}
                  flagImages
                  onFindOpen={guideEvents.findReplace}
                />
              )}
            </div>
          </div>
          {fields && <StatusBar words={scan?.words ?? 0} onFind={() => editorApi.current?.openFind()} onShortcuts={() => setShortcuts(true)} />}
        </main>

        <aside aria-label="Page panel" className="sticky hidden w-[288px] shrink-0 border-l border-border bg-surface xl:block" style={sideH}>
          {panelWide && panel}
        </aside>
      </div>

      <Drawer open={treeOpen} onClose={() => setTreeOpen(false)} side="left" width={300} title={<span className="ph-sensitive ph-mask">{site.name}</span>}>
        {treeEl}
      </Drawer>
      <Drawer open={panelOpen && !panelWide} onClose={() => setPanelOpen(false)} title={<span className="ph-sensitive ph-mask">{title || "Page"}</span>} width={360}>
        <div className="-mx-5 -my-4 flex min-h-full flex-col">{!panelWide && panel}</div>
      </Drawer>

      <Drawer open={preview} onClose={() => setPreview(false)} title={fields?.title ? <span className="ph-sensitive ph-mask">{fields.title}</span> : "Preview"} description="The draft as readers will see it, in the guide's saved design. Links to other pages open them here." width={820}>
        {fields && (
          <DraftPreview
            theme={site.settings.theme}
            title={fields.title}
            description={fields.description}
            markdown={fields.markdown}
            dark={previewDark}
            onDark={setPreviewDark}
            resolveAsset={resolveAssetUrl}
            onOpenPath={(path) => {
              const to = tree?.pages.find((p) => p.path === path);
              if (to) open(to.id);
              else toast.error(`There's no page at ${path} in this guide.`);
            }}
          />
        )}
      </Drawer>

      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
      <AltTextDialog
        src={altFor}
        onClose={() => setAltFor(null)}
        onSave={(alt) => {
          const n = altFor ? editorApi.current?.setImageAlt(altFor, alt) ?? 0 : 0;
          setAltFor(null);
          if (n) {
            guideEvents.checkFixed("image_alt");
            toast.success(n === 1 ? "Description added." : `Description added to ${n} images.`);
          }
        }}
      />

      <ConflictDialog
        conflict={session.conflict}
        mine={doc}
        onResolve={(c) => void session.resolveConflict(c)}
      />

      <NewPageDialog
        open={newOpen}
        onClose={() => { setNewOpen(false); setNewInit({ title: "" }); }}
        initialTitle={newInit.title}
        initialPath={newInit.path}
        groups={tree?.nav.map((g) => g.group) ?? []}
        currentGroup={group && !group.hidden ? group.group : undefined}
        afterId={group && !group.hidden ? pageId : null}
        onCreate={async (input) => {
          const p = await createPage(site.id, input);
          await loadTree();
          const stay = newInit.stay;
          setNewOpen(false);
          setNewInit({ title: "" });
          if (stay) {
            guideEvents.checkFixed("link_missing");
            toast.success(<><span className="ph-sensitive ph-mask">{p.title}</span> added as a draft. The link works once it's published.</>, { action: { label: "Open it", onClick: () => open(p.id) } });
          } else {
            open(p.id);
            toast.success(<><span className="ph-sensitive ph-mask">{p.title}</span> added as a draft.</>);
          }
        }}
      />

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={<>Delete “<span className="ph-sensitive ph-mask">{deleting?.title ?? ""}</span>”?</>}
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

function NewPageDialog({ open, onClose, initialTitle = "", initialPath, groups, currentGroup, afterId, onCreate }: {
  open: boolean;
  onClose: () => void;
  /** A title to start from (Insights › "Write a page", a check's "create it"). */
  initialTitle?: string;
  /** An address to start from (a check: the address a link points at). */
  initialPath?: string;
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

  const autoPath = (t: string, g: string) => suggestedPath(slugFrom(t), g ? slugFrom(g) : "");
  useEffect(() => {
    if (!open) return;
    const g = currentGroup ?? groups[0] ?? "__new";
    setTitle(initialTitle);
    setPath(initialPath ?? (initialTitle ? autoPath(initialTitle, g === "__new" ? "" : g) : ""));
    pathEdited.current = !!initialPath; setNewGroup(""); setError(""); setBusy(false);
    setGroup(g);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const groupName = group === "__new" ? newGroup.trim() : group;
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

