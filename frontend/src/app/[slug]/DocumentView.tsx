"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import MarkdownPreview from "@/components/MarkdownPreview";
import ImmersiveExit from "@/components/ImmersiveExit";
import AccessGate from "@/components/access/AccessGate";
import { RequestEditDialog, useEditRequest } from "@/components/access/RequestEditAccess";
import { PRIMARY_HOST } from "@/lib/hosts";
import { Alert, Button, ConfirmDialog, CopyButton, Drawer, EmptyState, Skeleton, useToast, type MenuEntry } from "@/components/ui";
import { useTenant } from "@/components/tenant";
import { PHONE_QUERY, useMediaQuery } from "@/components/kit/publish-utils";
import { ReadingProgress, Toc, TocTicks, tocHeadings, useActiveHeading, useReadingProgress, type Heading } from "@/components/reading";
import { DocPresence } from "@/components/presence/DocPresence";
import { PresenceMargin } from "@/components/presence/PresenceMargin";
import { sectionMarkers, viewerColor } from "@/lib/presence";
import { removePerson } from "@/lib/access";
import { recordEvent } from "@/lib/api";
import { engageMark } from "@/lib/engage";
import { track } from "@/lib/track";
import { singleKeyAllowed } from "@/lib/shortcuts";
import { useAnalyticsDoc } from "@/lib/useAnalyticsDoc";
import { useDocumentViewer } from "./doc/useDocumentViewer";
import { pageFieldsOf, type DocumentViewProps } from "./doc/types";
import { DocumentActionBar } from "./doc/DocumentBar";
import type { DocumentTopBarProps } from "./doc/DocumentTopBar";
import { DetailsPanel, readingMinutes } from "./doc/DetailsPanel";
import { DeviceKeyNotice, EncryptionState, RotatedNotice } from "./doc/EncryptionState";
import { LeaveGuard } from "./doc/LeaveGuard";
import { LiveUpdatePill, useLiveUpdate } from "./doc/LiveUpdate";
import { Colophon } from "./doc/Colophon";
import { OpeningCover } from "./doc/OpeningCover";
import { ready as preloaded } from "./doc/preload";
import { noteViewKind } from "@/lib/opening";
import vs from "./doc/viewer.module.css";
import type { PageActionRequest } from "@/components/pages/PageActions";
import { hasPageProps, readPageProps, withoutFrontMatter } from "@/components/pages/pageProps";
import { assetId, pagePath } from "@/lib/pageAddress.mjs";
import { fetchPageAiStatus, type PageAiStatus } from "@/lib/pages-ai/ask";
import { useAssistantEditor, useAssistantHere } from "@/components/assistant/store";
import { headingInView, useDocReader } from "@/components/assistant/reader";
import { insertAfterSection } from "@/components/assistant/assistantCore.mjs";

// Code that only runs after an interaction or in a specific state loads on demand, so a reader's first
// load carries the reading view only (REVAMP_BUILD §8.5 budget for /[slug]). Each still renders on the
// server when the state calls for it (dynamic() keeps SSR), so artifact pages and gates are unchanged.
const ArtifactView = dynamic(() => import("./ArtifactView"));
// The parts below load on first use with their own (empty) placeholder: without one, the first
// render of a lazy part suspends up to the page's Suspense and the whole view flashes the
// page loader (e.g. between Publish and the Published panel).
const ShareDialog = dynamic(() => import("@/components/access/ShareDialog"), { loading: () => null });
const PublishedPanel = dynamic(() => import("@/components/kit/PublishedPanel").then((m) => m.PublishedPanel), { loading: () => null });
const GoogleDocsCard = dynamic(() => import("./doc/GoogleDocsCard").then((m) => m.GoogleDocsCard), { loading: () => null });
const EditorScreen = dynamic(() => import("./doc/EditorScreen").then((m) => m.EditorScreen), { loading: () => null });
const SecretUnlock = dynamic(() => import("./doc/EditorScreen").then((m) => m.SecretUnlock), { loading: () => null });
const ReportDialog = dynamic(() => import("./doc/ReportDialog").then((m) => m.ReportDialog), { loading: () => null });
const SaveCopyDialog = dynamic(() => import("./doc/SaveCopyDialog").then((m) => m.SaveCopyDialog), { loading: () => null });
const EncryptedCopyDialog = dynamic(() => import("./doc/SaveCopyDialog").then((m) => m.EncryptedCopyDialog), { loading: () => null });
const ProtectionDialog = dynamic(() => import("./doc/ProtectionDialog").then((m) => m.ProtectionDialog), { loading: () => null });
// The framed view's one top bar (a page's bar, components/pages/PageChrome, with the document's
// actions). Full screen has none, so it loads when the reader is idle (below) or the view is framed.
const docTopBar = () => import("./doc/DocumentTopBar");
const DocumentTopBar = dynamic(() => docTopBar().then((m) => m.DocumentTopBar), { loading: () => null });
// Pages (documents in the block editor): the renderer ships with a page; the editor and the
// template gallery load when used.
const PageRenderer = dynamic(() => import("@/components/pages/PageRenderer").then((m) => m.PageRenderer));
// Sign-offs under a page's title (the reader's page fills the store: components/pages/signoff).
const SignoffSummary = dynamic(() => import("@/components/pages/signoff/SignoffSummary").then((m) => m.SignoffSummary), { loading: () => null });
const PageEditor = dynamic(() => import("@/components/pages/PageEditor").then((m) => m.PageEditor), { loading: () => null });
const PageModeButton = dynamic(() => import("@/components/pages/PageModeButton").then((m) => m.PageModeButton), { loading: () => null });
const focusPageMode = (which: "edit" | "done") => void import("@/components/pages/PageModeButton").then((m) => m.focusPageMode(which));
// Drag and drop, Move to and Duplicate load only for pages.
const PageTree = dynamic(() => import("@/components/pages/PageTree").then((m) => m.PageTree), { loading: () => null });
const PageActions = dynamic(() => import("@/components/pages/PageActions").then((m) => m.PageActions), { loading: () => null });
const PageHistory = dynamic(() => import("@/components/pages/history/PageHistory").then((m) => m.PageHistory), { loading: () => null });
const TemplateGallery = dynamic(() => import("@/components/pages/TemplateGallery").then((m) => m.TemplateGallery), { loading: () => null });
// A page's chrome (frame, top bar, head, sub-pages, backlinks) and the pages API ship only with a
// page: a classic document's reader never loads them. Still rendered on the server for a page.
const PageFrame = dynamic(() => import("@/components/pages/PageChrome").then((m) => m.PageFrame), { loading: () => null });
const PageTopBar = dynamic(() => import("@/components/pages/PageChrome").then((m) => m.PageTopBar), { loading: () => null });
const PageRailHead = dynamic(() => import("@/components/pages/PageChrome").then((m) => m.PageRailHead), { loading: () => null });
const SubPages = dynamic(() => import("@/components/pages/PageChrome").then((m) => m.SubPages), { loading: () => null });
const Backlinks = dynamic(() => import("@/components/pages/PageChrome").then((m) => m.Backlinks), { loading: () => null });
// Typed page properties (components/pages/props): loads only for a page in a folder with a schema.
const PropertiesPanel = dynamic(() => import("@/components/pages/props/PropertiesPanel").then((m) => m.PropertiesPanel), { loading: () => null });
const PageHead = dynamic(() => import("@/components/pages/PageHead").then((m) => m.PageHead), { loading: () => null });
const TemplateNotice = dynamic(() => import("@/components/pages/templates/TemplateNotice").then((m) => m.TemplateNotice), { loading: () => null });
const DeletePageDialog = dynamic(() => import("@/components/pages/DeletePageDialog").then((m) => m.DeletePageDialog), { loading: () => null });
const ExportDialog = dynamic(() => import("@/components/pages/export/ExportDialog").then((m) => m.ExportDialog), { loading: () => null });
const ChangeLinkDialog = dynamic(() => import("@/components/pages/slug/ChangeLinkDialog").then((m) => m.ChangeLinkDialog), { loading: () => null });
const pagesApi = () => import("@/lib/pages");
// Page AI (reader side): the Ask pill for signed-in readers, and Translate… for editors. Both load on demand.
// Meetings (components/meetings): a meeting page's own pill and panel (Ask this meeting, details).
const MeetingLauncher = dynamic(() => import("@/components/meetings/MeetingPanel").then((m) => m.MeetingLauncher), { ssr: false, loading: () => null });
const MeetingHeader = dynamic(() => import("@/components/meetings/MeetingPanel").then((m) => m.MeetingHeader), { ssr: false, loading: () => null });
import { usePageJira } from "@/components/jira/usePageJira";
import { CommentsHost, CommentsButton, CommentsPanel, CommentLayer } from "@/components/comments";
// From meetings (components/pages/memory) in View mode: the bar's button and the same panel as in Edit.
const MeetingMemory = dynamic(() => import("@/components/pages/memory/MeetingMemory").then((m) => m.MeetingMemory), { ssr: false, loading: () => null });
const TranslateDialog = dynamic(() => import("@/components/pages/ai/TranslateDialog").then((m) => m.TranslateDialog), { ssr: false, loading: () => null });

/**
 * Does the document already open with its own title?
 *
 * Full screen hides the chrome, so the stored title has to be drawn into the
 * reading column or a document whose markdown starts with prose loses it
 * entirely. But most documents lead with their own heading, and printing ours
 * above it says the same thing twice in two sizes. A leading H1 is the author's
 * title whatever it says; a leading H2 or H3 counts only when it matches ours
 * (ignoring emphasis, code marks and link syntax).
 */
function opensWithOwnTitle(content: string, title: string | null): boolean {
  if (!title) return true;
  const lines = content.replace(/^\uFEFF/, "").split("\n");
  const i = lines.findIndex((l) => l.trim());
  if (i < 0) return false;
  const first = lines[i] ?? "";
  let depth = 0, text = "";
  const atx = first.match(/^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/);
  // An underlined (setext) heading: a plain line, then === (H1) or --- (H2). Not a list, quote, table or fence.
  const plain = !/^\s{0,3}([-*+>|#]|\d+[.)]|```|~~~)/.test(first);
  if (atx) [depth, text] = [atx[1].length, atx[2]];
  else if (plain && /^\s{0,3}=+\s*$/.test(lines[i + 1] ?? "")) [depth, text] = [1, first];
  else if (plain && /^\s{0,3}-+\s*$/.test(lines[i + 1] ?? "")) [depth, text] = [2, first];
  if (!depth) return false;
  if (depth === 1) return true;
  const norm = (v: string) =>
    v
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/[*_`~]/g, "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  return norm(text) === norm(title);
}

/**
 * The document viewer (REVAMP_PLAN 7.6; REVAMP_BUILD R12/R13).
 *
 * All state, effects and handlers live in `useDocumentViewer` (moved there
 * verbatim in R12); this file only lays the screens out:
 *
 *  - **Immersive** (the default for a readable document): the reading column
 *    alone on `bg`, ReadingProgress, TocTicks, the colophon and ImmersiveExit.
 *    No header — the server HTML of an immersive document has none (§4.1).
 *  - **Framed** ("Show details"): one top bar, DocumentTopBar (a page's bar: the
 *    logo, or the workspace's on its domain, the title, the actions and the
 *    account; no app header above it), Contents rail · reading column · Details
 *    rail at ≥1280px (the bar's sidebar toggle, ⌘\, hides both); a Contents
 *    dropdown and a Details drawer below that; bottom sheets and a bottom action
 *    bar on phones. The editor and the gates have the same bar.
 *  - **Gates**, **encryption states**, **edit flow**, **?new=1** PublishedPanel.
 *
 * One content element serves both reading modes — immersive only swaps its
 * classes. Rendering a second copy into an overlay would tear the subtree down
 * and remount it on every toggle, re-running every Mermaid diagram and KaTeX
 * block inside it. Everything around it sits in fixed slots so React never
 * re-parents it.
 */
export default function DocumentView(props: DocumentViewProps) {
  const { slug, url, isPasswordProtected = false, gate = null, isOwned = false, viewerChrome = "full" } = props;
  const v = useDocumentViewer(props);
  // Live: a gated document can turn out to be encrypted only once a client read opens it.
  const encrypted = v.encrypted;
  const {
    accessDenied, artifactDoc, claimed, claimMsg, claimSecret, decryptState, deviceKeySaved,
    displayContent, displayCreatedAt, displayExpiresAt, displayTitle, displayViews, editing, gConnected,
    handleClaim, handleEditClick, handleGoogleExport, handleGoogleReconnect, handlePasswordUnlock, isNew,
    isOwner, keyFragment, keySource, pwdError, pwdFetching, pwdInput, pwdLocked, pwdUnlocking, pwdVisible,
    readable, readRef, requestCopy, rotated, secretUnlocked, setDeviceKeySaved, setEditing, setPwdInput,
    setPwdVisible, setShowCopy, setShowRaw, setShowReport, setShowShare, setReportDone, setReportReason,
    shareUrl, showCopy, showImmersive, showRaw, showReport, showShare, signInHref, user, vscodeSynced,
    readTicket,
  } = v;

  const tenant = useTenant();
  const router = useRouter();
  const toast = useToast();
  const [leaving, setLeaving] = useState(false);
  // The opening cover (lib/opening) stays up through the read and, for a page, until the page's
  // frame (its own code, loaded on demand) is on screen, so nothing paints in between.
  const [opened, setOpened] = useState(false);
  if (pwdFetching && !opened) setOpened(true);
  const [pageFramed, setPageFramed] = useState(false);
  const onPageFrame = useCallback((el: HTMLDivElement | null) => { if (el) setPageFramed(true); }, []);
  const phone = useMediaQuery(PHONE_QUERY);
  const layerRef = useRef<HTMLDivElement>(null);
  // Comments (components/comments): the element whose text the threads point into — the reader's, or the
  // editor's while a page is being edited.
  const [readEl, setReadEl] = useState<HTMLElement | null>(null);
  useEffect(() => { if (readRef.current !== readEl) setReadEl(readRef.current); });
  const [editEl, setEditEl] = useState<HTMLElement | null>(null);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [contentsOpen, setContentsOpen] = useState(false);
  const [panelDismissed, setPanelDismissed] = useState(false);
  const [secretCopied, setSecretCopied] = useState(false);
  const [wsShareFailed, setWsShareFailed] = useState(false);
  const [newSubPage, setNewSubPage] = useState(false);
  const [toBlocks, setToBlocks] = useState(false);
  const [toBlocksBusy, setToBlocksBusy] = useState(false);
  // A page: a document in the block editor (never an encrypted one).
  const page = v.page;
  const isPage = !encrypted && page?.editor === "blocks";
  // The next item opened in this tab opens on this kind's look (lib/opening).
  useEffect(() => {
    if (v.artifactDoc) noteViewKind("file");
    else if (v.readable && !pwdFetching && !v.pwdLocked) noteViewKind(isPage ? "page" : "doc");
  }, [v.artifactDoc, v.readable, pwdFetching, v.pwdLocked, isPage]);
  // A classic document that was a page (its front matter, its place among pages): its editors get a
  // clear way back to the page editor, on markdrop.in and on the workspace's own domain.
  const wasPage = !isPage && !encrypted && !!page && (hasPageProps(displayContent) || (page.children_count ?? 0) > 0 || !!page.parent || (page.page_path?.length ?? 0) > 0);
  const addressing = { tenant: !!tenant, folderPath: page?.folder_path ?? [], workspaceId: page?.workspace_id ?? null };
  const crumbs = isPage ? page?.breadcrumbs ?? [] : [];
  // Sub-pages, history: signed-in editors, here or on a workspace's own domain. Moving, duplicating,
  // templates and translating stay on markdrop.in (the domain edits pages, it doesn't rearrange them).
  const canAddSubPage = isPage && !!user && v.secretUnlocked;
  const canManagePage = canAddSubPage && !tenant;
  // On a workspace's domain: what stays on markdrop.in opens the same page there.
  const onMarkdrop = `https://${PRIMARY_HOST}/${encodeURIComponent(slug)}`;
  const domainOwner = !!tenant && !!user && isOwner;
  // "Request edit access": a signed-in reader of this page who may not edit it.
  const [requestingEdit, setRequestingEdit] = useState(false);
  const [editReq, setEditReq] = useEditRequest(slug, !!user && v.readable && !v.secretUnlocked && !encrypted && v.ownerKnown && !isOwner);
  // The page's properties (front matter): icon, cover, width, text size, font.
  const pageProps = isPage ? readPageProps(displayContent) : null;
  const pageLayout = pageProps
    ? [pageProps.fullWidth && "pb-wide", pageProps.smallText && "pb-small", pageProps.font !== "default" && `pb-font-${pageProps.font}`].filter(Boolean).join(" ")
    : "";
  const resolvePageAsset = (src: string) => {
    const id = assetId(src);
    return id ? page?.assets?.[id]?.url ?? "" : src;
  };
  // View mode first, Edit on demand. A page opens for reading, for everyone: links, mentions,
  // embeds and sub-pages open on a click. The people who can edit it get Edit (E) in the bar; the
  // editor loads behind the page and takes its place when it's ready (the same frame, so nothing
  // moves), and Done saves and comes back. Straight into Edit: ?edit=1 (a page just made from New
  // page, Add a sub-page, a template, Duplicate…), Analytics' "Apply in page", and an empty page.
  const canEditPage = isPage && secretUnlocked && readable;
  // (`from`: the address it had before a rename while open in Edit, so the editor stays up until
  // the view follows it to the new one.)
  const [pageMode, setPageMode] = useState<{ slug: string; mode: "view" | "edit"; from?: string } | null>(null);
  const modeHere = pageMode?.slug === slug || pageMode?.from === slug;
  const editMode = modeHere && pageMode?.mode === "edit";
  const pageBodyEmpty = isPage && !withoutFrontMatter(displayContent).trim();
  useEffect(() => {
    if (!canEditPage || !v.flagsReady || modeHere) return;
    const apply = new URLSearchParams(window.location.search).get("apply") === "insight";
    // (`editing`: they asked for the editor before it could open, e.g. ⋯ › Edit and the edit secret.)
    setPageMode({ slug, mode: v.startInEdit || apply || pageBodyEmpty || editing ? "edit" : "view" });
  }, [canEditPage, v.flagsReady, slug, modeHere, v.startInEdit, pageBodyEmpty, editing]);
  const pageEditable = canEditPage && editMode && !showRaw;
  const [editorReady, setEditorReady] = useState(false);
  useEffect(() => {
    if (!pageEditable) setEditorReady(false);
  }, [pageEditable]);
  // The editor's text, for comment highlights while editing (found once it's on screen).
  useEffect(() => {
    if (!pageEditable || !editorReady) { setEditEl(null); return; }
    let raf = 0;
    let tries = 0;
    const find = () => {
      const el = document.querySelector<HTMLElement>(".pb-live .ProseMirror");
      if (el) setEditEl(el);
      else if (tries++ < 40) raf = requestAnimationFrame(find);
    };
    find();
    return () => cancelAnimationFrame(raf);
  }, [pageEditable, editorReady]);
  // The edit flow (⋯ › Edit, which asks for the edit secret) just unlocked the page: edit it.
  const editRise = useRef(editing);
  useEffect(() => {
    const rose = editing && !editRise.current;
    editRise.current = editing;
    if (rose && canEditPage && !editorReady) setPageMode({ slug, mode: "edit" });
  }, [editing, canEditPage, editorReady, slug]);
  // View mode: the editor's code comes down while the page is read, so Edit is quick.
  useEffect(() => {
    if (!canEditPage || editMode) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    const t = window.setTimeout(() => (w.requestIdleCallback ?? ((cb: () => void) => cb()))(() => void import("@/components/pages/PageEditor")), 1500);
    return () => window.clearTimeout(t);
  }, [canEditPage, editMode]);
  const enterEdit = useCallback((how: "click" | "key" | "insert") => {
    setPageMode({ slug, mode: "edit" });
    track("page_edit_mode", { via: how });
    focusPageMode("done");
  }, [slug]);
  // Done (PageEditor saved what was pending and let go of the lock): back to reading, showing the
  // page as it stood in the editor; a fresh read follows (images uploaded there, someone's edit).
  const leaveEdit = (latest: { title: string; content: string }) => {
    v.setDisplayContent(latest.content);
    v.setDisplayTitle(latest.title || null);
    setPageMode({ slug, mode: "view" });
    const q = new URLSearchParams(window.location.search);
    if (q.get("edit") === "1") {
      q.delete("edit");
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${q.size ? `?${q}` : ""}${window.location.hash}`);
    }
    pagesApi()
      .then((m) => m.getPage(slug))
      .then((doc) => {
        v.setPage(pageFieldsOf(doc as unknown as Record<string, unknown>));
        if (typeof doc.content === "string") v.setDisplayContent(doc.content);
        if (typeof doc.rev === "number") v.setDocRev(doc.rev);
      })
      .catch(() => {});
    focusPageMode("edit");
  };
  // View mode, for people who can edit: a checklist's box ticks and saves at once (lock, save on
  // the rev this view shows, let go). Not on a locked page they can't edit, nor while someone else
  // is editing; a refusal puts the box back and says why.
  const tickBusy = useRef(false);
  const toggleTask = async (offset: number) => {
    if (tickBusy.current) return;
    const before = displayContent;
    // (The renderer's offsets are in the body: the front matter comes first.)
    const at = before.length - withoutFrontMatter(before).length + offset;
    const m = /^((?:[-*+]|\d{1,9}[.)])[ \t]+)\[([ xX])\]/.exec(before.slice(at));
    if (!m) {
      toast.info("Press Edit to change this one.");
      return;
    }
    const pos = at + m[1].length + 1;
    const next = before.slice(0, pos) + (m[2] === " " ? "x" : " ") + before.slice(pos + 1);
    tickBusy.current = true;
    v.setDisplayContent(next);
    const api = await pagesApi();
    const secret = v.secretInput || null;
    let locked = false;
    try {
      await api.lockPage(slug, secret, { intent: "edit" });
      locked = true;
      const doc = await api.savePage(slug, { title: displayTitle, content: next, baseRev: v.docRev }, secret);
      if (typeof doc.rev === "number") v.setDocRev(doc.rev);
      if (typeof doc.content === "string") v.setDisplayContent(doc.content);
      pendingRevalidate.current = true;
      revalidate();
    } catch (e) {
      v.setDisplayContent(before);
      const status = api.pagesErrorStatus(e);
      toast.error(
        status === 423 ? (api.lockHolder(e) ? `${api.lockHolder(e)} is editing this page. Try again when they're done.` : "Someone else is editing this page. Try again when they're done.")
          : status === 409 ? "This page changed since you opened it. Reload to see the latest, then tick it again."
          : e instanceof Error && e.message ? e.message : "Couldn't save that. Try again.",
      );
    } finally {
      if (locked) void api.unlockPage(slug, { secret }).catch(() => {});
      tickBusy.current = false;
    }
  };
  // E: Edit (single-key rule: not while typing, not in a dialog, shortcuts on).
  useEffect(() => {
    if (!canEditPage || editMode || showRaw) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "e" || e.key === "E") && !e.shiftKey && singleKeyAllowed(e)) {
        e.preventDefault();
        enterEdit("key");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEditPage, editMode, showRaw, enterEdit]);
  // While the page's editor is on screen it follows the live socket itself; the viewer stops
  // re-reading on every save (useDocumentViewer ignores `changed` while editing).
  const setViewerEditing = v.setEditing;
  useEffect(() => {
    if (!editorReady) return;
    setViewerEditing(true);
    return () => setViewerEditing(false);
  }, [editorReady, setViewerEditing]);
  // A reader's full screen (F) isn't offered for pages.
  const toggleImmersive = v.toggleImmersive;
  useEffect(() => {
    if (isPage && showImmersive) toggleImmersive(false);
  }, [isPage, showImmersive, toggleImmersive]);
  // A classic document that was a page opens framed for its editors (the way back is in the chrome:
  // the banner and ⋯), unless they asked for full screen themselves.
  const askedFullScreen = v.askedFullScreen;
  useEffect(() => {
    if (wasPage && secretUnlocked && showImmersive && !askedFullScreen.current) toggleImmersive(false);
  }, [wasPage, secretUnlocked, showImmersive, toggleImmersive, askedFullScreen]);
  // The cached anonymous render follows the saves (at most every 20 s, and on leaving).
  const revalidated = useRef(0);
  const revalidate = (force = false) => {
    if (!force && Date.now() - revalidated.current < 20_000) return;
    revalidated.current = Date.now();
    fetch("/api/revalidate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }), keepalive: force }).catch(() => {});
  };
  const pendingRevalidate = useRef(false);
  useEffect(() => {
    const hide = () => {
      if (pendingRevalidate.current) revalidate(true);
    };
    window.addEventListener("pagehide", hide);
    return () => {
      window.removeEventListener("pagehide", hide);
      hide();
    };
  }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [changingLink, setChangingLink] = useState(false);
  // Move to / Duplicate (signed-in editors on markdrop.in, like Add a sub-page).
  const [pageAction, setPageAction] = useState<PageActionRequest | null>(null);
  const [aiStatus, setAiStatus] = useState<PageAiStatus | null>(null);
  // Page AI's status, for Translate… in an editor's ⋯ menu (asking is Ask Markdrop's: ✦ Ask, ⌘J).
  const aiStatusFor = v.readable && !!v.user && v.page?.editor === "blocks" && !v.encrypted ? slug : null;
  useEffect(() => {
    setAiStatus(null);
    if (!aiStatusFor) return;
    let live = true;
    void fetchPageAiStatus(aiStatusFor).then((s) => { if (live) setAiStatus(s); });
    return () => { live = false; };
  }, [aiStatusFor]);
  const [translating, setTranslating] = useState(false);
  const [historyOpen, setHistoryOpen] = useState<boolean | null>(null); // null: never opened (not loaded)
  const [treeKey, setTreeKey] = useState(0);
  const [kidsKey, setKidsKey] = useState(0);
  const pagePathSlugs = page?.page_path ?? [];
  const movable = {
    slug,
    title: displayTitle,
    workspaceId: page?.workspace_id ?? null,
    parent: page?.parent?.slug ?? pagePathSlugs[pagePathSlugs.length - 1] ?? null,
    parentTitle: page?.parent?.title ?? null,
    childrenCount: page?.children_count ?? 0,
    folderPath: page?.folder_path ?? [],
  };
  // This page's place changed (moved, or an ancestor moved) or its sub-pages did: read its
  // breadcrumbs, address and "Pages inside" again. The tree redraws itself unless asked to.
  const rereadPage = (redrawTree = true, purge = true) => {
    pagesApi()
      .then((m) => m.getPage(slug))
      .then((doc) => {
        v.setPage(pageFieldsOf(doc as unknown as Record<string, unknown>));
        if (redrawTree) setTreeKey((k) => k + 1);
        setKidsKey((k) => k + 1);
        // A move can change who reads it (it inherits from somewhere else now).
        v.loadAccess();
      })
      .catch(() => {});
    // (A live event reaches every open copy: the server already purged what it changed.)
    if (purge) fetch("/api/revalidate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) }).catch(() => {});
  };
  // Someone added, moved or removed a sub-page (the live socket's `children`): "Pages inside" and
  // the tree follow without a reload (fix/collab-audit).
  const rereadRef = useRef(rereadPage);
  rereadRef.current = rereadPage;
  const subscribeLive = v.subscribeLive;
  useEffect(() => {
    if (!isPage) return;
    return subscribeLive((msg) => {
      if (msg.type === "children") rereadRef.current(true, false);
    });
  }, [isPage, subscribeLive]);
  const pageActions = isPage && canManagePage ? (
    <PageActions
      request={pageAction}
      page={movable}
      onClose={() => setPageAction(null)}
      onMoved={() => rereadPage()}
    />
  ) : null;
  const pageExport = isPage && exporting ? (
    <ExportDialog open onClose={() => setExporting(false)} slug={slug} title={displayTitle} content={displayContent} assets={page?.assets ?? null} crumbs={crumbs} childrenCount={page?.children_count ?? 0} canEdit={secretUnlocked} secret={v.secretInput || null} viewer={user?.id ?? null} />
  ) : null;
  const pageHref = (s: string, ancestors: string[]) => pagePath(s, { tenant: addressing.tenant, folderPath: addressing.folderPath, ancestors });
  // The tab shows the page's icon.
  useEffect(() => {
    if (!isPage || !displayTitle) return;
    const icon = pageProps?.icon && !/^(asset:|https?:)/.test(pageProps.icon) ? `${pageProps.icon} ` : "";
    document.title = `${icon}${displayTitle} — Markdrop`;
  }, [isPage, displayTitle, pageProps?.icon]);

  // /new leaves this flag when publishing worked but adding the document to a
  // workspace didn't (REVAMP_PLAN 7.6 "Workspace share failure").
  useEffect(() => {
    if (!isNew) return;
    // Read once after mount, then removed, so a reload doesn't repeat the warning.
    try {
      const key = `md_ws_share_failed:${slug}`;
      if (sessionStorage.getItem(key) !== null) {
        setWsShareFailed(true);
        sessionStorage.removeItem(key);
      }
    } catch { /* storage off */ }
  }, [isNew, slug]);

  // Tell the feedback launcher (and anything else) that the reader is full-bleed.
  useEffect(() => {
    if (!showImmersive) return;
    document.documentElement.setAttribute("data-md-immersive", "");
    return () => document.documentElement.removeAttribute("data-md-immersive");
  }, [showImmersive]);

  // Full screen has no bar: fetch the framed view's while the reader is idle, so "Show details"
  // opens it at once.
  useEffect(() => {
    if (isPage) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number; cancelIdleCallback?: (id: number) => void };
    const load = () => void docTopBar().catch(() => {});
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(load);
      return () => w.cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(load, 1500);
    return () => window.clearTimeout(t);
  }, [isPage]);

  const livePill = useLiveUpdate(v.liveUpdate, displayContent, readRef);
  useAnalyticsDoc(
    artifactDoc
      ? null
      : {
          ref: props.docRef ?? null,
          kind: "document",
          access: encrypted ? "encrypted" : props.isPasswordProtected || props.gate ? "protected" : "public",
        },
  );
  const pct = useReadingProgress();

  // Who's viewing (lib/presence): say which heading this reader is in (throttled by the channel;
  // never for an encrypted document, whose headings the server must not see), and mark where
  // everyone else is: dots in the Contents rail when it's on screen, else in the margin.
  const presence = v.presence;
  const reportSections = v.readable && !encrypted && !v.showRaw && !v.editing;
  const activeSection = useActiveHeading(reportSections ? headings.map((h) => h.id) : []);
  useEffect(() => {
    presence.channel.setSection(reportSections && activeSection ? { h: activeSection } : null);
  }, [presence.channel, reportSections, activeSection]);
  const wideRail = useMediaQuery("(min-width: 1280px)");
  const markers = sectionMarkers(presence.snapshot);

  // ── Ask Markdrop (components/assistant): ✦ Ask in the bar and ⌘J ask about this doc first ──────
  // A readable, unencrypted document or page for someone signed in. A reader's question says which
  // section is in view and what they selected; an editor of a classic document can Insert an answer:
  // the editor opens with it after the section in view (nothing is saved until they save).
  const askable = !!user && readable && !encrypted && !pwdLocked && !pwdFetching && !artifactDoc;
  useAssistantHere(askable ? { page: slug } : null);
  useDocReader(readRef, askable && !editing);
  const classicInsert = useCallback((markdown: string) => {
    v.handleEditClick();
    v.setEditContent(insertAfterSection(displayContent, headingInView(readRef.current), markdown));
    return true;
  }, [v, displayContent, readRef]);
  useAssistantEditor(askable && !isPage && secretUnlocked && !editing && !(encrypted && decryptState === "working") ? classicInsert : null, null);
  // A page in View mode, for someone who can edit it: Insert opens Edit, and the answer goes at the
  // end of the section in view once the editor is up (PageEditor insertOnOpen); it saves like any
  // change. In Edit mode the editor's own Insert (at the caret) takes over.
  const [pageInsert, setPageInsert] = useState<{ markdown: string; heading: string | null } | null>(null);
  const viewInsert = useCallback((markdown: string) => {
    setPageInsert({ markdown, heading: headingInView(readRef.current) });
    enterEdit("insert");
    return true;
  }, [enterEdit, readRef]);
  useAssistantEditor(askable && canEditPage && !showRaw && !editMode ? viewInsert : null, null);

  // Jira (components/jira): chips on linked items, "Create Jira issue" on a meeting's list items, the dialogs.
  const pageJira = usePageJira({
    slug, enabled: readable && !!user && isPage && !!page?.workspace_id && !tenant && !pwdLocked && !pwdFetching && !artifactDoc,
    meeting: !!page?.meeting && page.meeting.role !== "transcript", workspaceId: page?.workspace_id ?? null, rev: v.docRev,
  });

  // ── Artifact discovered behind the password gate ───────────────────────────
  if (artifactDoc) {
    // Its code was fetched before the read was adopted (doc/preload): render it directly.
    const Artifact = preloaded.ArtifactView ?? ArtifactView;
    return (
      <Artifact
        slug={slug}
        title={artifactDoc.title}
        url={url}
        createdAt={artifactDoc.created_at}
        views={artifactDoc.views}
        isPasswordProtected
        mime={artifactDoc.mime ?? "application/octet-stream"}
        renderer={artifactDoc.renderer ?? "download"}
        typeLabel={artifactDoc.type_label ?? "File"}
        sizeBytes={artifactDoc.size_bytes ?? 0}
        originalFilename={artifactDoc.original_filename ?? null}
        artifactUrl={artifactDoc.artifact_url ?? null}
        downloadUrl={artifactDoc.download_url ?? null}
        posterUrl={artifactDoc.poster_url ?? null}
        captionsUrl={artifactDoc.captions_url ?? null}
        docRef={artifactDoc.ref ?? null}
        readTicket={artifactDoc.read_ticket ?? null}
        track={artifactDoc.track ?? null}
        fileVersion={artifactDoc.file_version ?? null}
        workspaceId={artifactDoc.workspace_id ?? null}
        folderPath={artifactDoc.folder_path ?? []}
        viewerChrome={viewerChrome === "none" ? "none" : "full"}
      />
    );
  }

  const gated = pwdLocked || pwdFetching;
  // Comments: on for this reader when the read says so and the item is open in front of them.
  const commentsSummary = readable && !encrypted && !gated && !artifactDoc ? v.docComments : null;
  useEffect(() => {
    const on = () => setShowShare(true);
    window.addEventListener("md:comments-settings", on);
    return () => window.removeEventListener("md:comments-settings", on);
  }, [setShowShare]);
  const gateMode: "password" | "signin" | "denied" = accessDenied ? "denied" : gate === "signin" ? "signin" : "password";
  // A classic document's one bar (the framed view, a gate, the editor); a page has its own (below).
  const docPresence = readable ? <>{<DocPresence presence={presence} signedIn={!!user} />}{commentsSummary && !showRaw && <CommentsButton />}</> : null;
  const docBar = (o: Partial<DocumentTopBarProps> = {}) => (
    <DocumentTopBar
      slug={slug}
      url={url}
      shareUrl={shareUrl}
      title={displayTitle}
      addressing={addressing}
      encrypted={encrypted}
      gated={gated}
      gateBadge={isPasswordProtected ? (gate === "signin" ? "private" : "password") : null}
      // On a workspace's domain the sign-in gate has its own button.
      hideAccount={!!tenant && gated && !pwdFetching && gateMode === "signin"}
      presence={docPresence}
      ask={askable}
      {...o}
    />
  );

  // A page (the block editor) has one screen for readers and editors: its frame, always editable
  // for editors (below). Someone who must type the edit secret first gets the edit flow's prompt.
  const pageScreen = isPage && readable && !gated && !(editing && !secretUnlocked);

  // Open a classic document with blocks, or (it was a page) back in the page editor.
  const toBlocksDialog = (
    <ConfirmDialog
      open={toBlocks}
      onClose={() => !toBlocksBusy && setToBlocks(false)}
      title={wasPage ? "Switch back to the page editor?" : "Open in the block editor?"}
      body={wasPage
        ? "It opens with blocks again: its icon, cover, sub-pages and layout come back. The Markdown is unchanged and the link stays the same."
        : "You'll write this document with blocks: headings, toggles, checklists, callouts, tables, images and embeds of your Markdrop files. The Markdown is unchanged and the link stays the same."}
      confirmLabel={wasPage ? "Switch back" : "Open in block editor"}
      tone="default"
      onConfirm={async () => {
        setToBlocksBusy(true);
        try {
          await (await pagesApi()).setEditor(slug, "blocks", v.secretInput || null);
          v.setPage({ ...(page ?? {}), editor: "blocks" });
          // Asked for the block editor: it opens in Edit mode.
          setPageMode({ slug, mode: "edit" });
          setToBlocks(false);
          track(wasPage ? "page_back_to_blocks" : "page_open_blocks");
          handleEditClick();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Couldn't switch editors. Try again.");
        } finally {
          setToBlocksBusy(false);
        }
      }}
    />
  );
  // Its editors see where it went, and the way back, above the document (and its classic editor).
  const backToPage = wasPage && secretUnlocked && readable ? (
    <Alert
      tone="info"
      icon="layers"
      className="no-print"
      title="This page is open in the classic editor"
      actions={<Button size="sm" variant="primary" onClick={() => setToBlocks(true)}>Switch back to the page editor</Button>}
    >
      It was switched to the Markdown editor. Switch back to write it with blocks again; nothing is lost.
    </Alert>
  ) : null;

  // ── Edit flow ──────────────────────────────────────────────────────────────
  if (editing && !pageScreen) {
    return (
      <>
        {docBar({ title: displayTitle, gated: false, menu: [], shareUrl: "" })}
        <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
          {secretUnlocked && !isPage && backToPage && <div className="mx-auto w-full max-w-reading px-4 pt-4 sm:px-6">{backToPage}</div>}
          {secretUnlocked && !isPage ? (
            <EditorScreen
              v={v}
              slug={slug}
              isPasswordProtected={isPasswordProtected}
              encrypted={encrypted}
              displayTitle={displayTitle}
              displayContent={displayContent}
            />
          ) : (
            <SecretUnlock v={v} />
          )}
        </main>
        {toBlocksDialog}
      </>
    );
  }

  // ── Read mode ──────────────────────────────────────────────────────────────
  const framed = !showImmersive;
  const empty = readable && !displayContent.trim();
  const protection: "private" | "password" | null = isPasswordProtected ? (gate === "signin" ? "private" : "password") : null;
  const tocEntries = readable && !showRaw ? tocHeadings(headings) : [];
  // Markers on the Contents entry a heading falls under (an h4 isn't listed: its parent is).
  const railShown = framed && wideRail && tocEntries.length > 0;
  const tocMarkers: Record<string, { color: string; name: string; away?: boolean }[]> = {};
  if (Object.keys(markers).length && tocEntries.length) {
    const listed = new Set(tocEntries.map((h) => h.id));
    let under: string | null = null;
    for (const h of headings) {
      if (listed.has(h.id)) under = h.id;
      const here = markers[h.id];
      if (here && (under ?? tocEntries[0]?.id)) {
        const key = (under ?? tocEntries[0]!.id);
        (tocMarkers[key] ??= []).push(...here.map((m) => ({ color: viewerColor(m.color), name: m.name, away: m.away })));
      }
    }
  }
  // The stored title, else the document's own leading H1 (most documents carry their title there).
  const shownTitle = displayTitle || (headings[0]?.depth === 1 ? headings[0].text : null);

  function copyLinkEvent() {
    recordEvent(slug, "copy_url", readTicket);
    track("doc_copy_link");
  }
  function exportPdf() {
    recordEvent(slug, "export_pdf", readTicket);
    engageMark("dl", { f: "pdf" });
    track("doc_export_pdf");
    window.print();
  }
  function openReport() {
    setReportReason("");
    v.setReportCategory("");
    v.setReportError("");
    setReportDone(false);
    setShowReport(true);
  }
  // D19: the owner, or a secret holder in this session, gets Edit in the bar;
  // everyone else finds it in More (it opens the secret prompt).
  const editBlocked = encrypted && decryptState === "working";
  const startEdit = () => { if (secretUnlocked) handleEditClick(); else setEditing(true); };
  const canFullScreen = readable && !empty;
  const googleOn = isOwner && gConnected && !pwdLocked && !encrypted;

  const myGrant = !isOwner && !!user && !!v.access?.your_grant;
  const menu: MenuEntry[] = gated ? [] : [
    ...(readable && !empty ? [{ label: showRaw ? "View rendered" : "View raw", icon: "code", onClick: () => setShowRaw(!showRaw) }] : []),
    ...(readable && !isPage ? [{ label: "Export PDF", icon: "printer", onClick: exportPdf }] : []),
    // A page: Markdown, HTML or PDF (components/pages/export); readers only when the page allows it.
    ...(readable && isPage && !empty && (secretUnlocked || pageProps?.allowExport !== false) ? [{ label: "Export…", icon: "download", description: "Markdown, HTML or PDF", onClick: () => setExporting(true) }] : []),
    // An encrypted document's Markdown is saved by this browser (the server can't read it).
    ...(encrypted && readable && !empty ? [{ label: "Download Markdown", icon: "download", onClick: () => void import("@/components/pages/export/exportApi").then((m) => m.downloadMarkdown(displayTitle, displayContent)) }] : []),
    // An encrypted document is copied by this browser (decrypted text, new key); the server
    // can't copy what it can't read.
    ...(!isOwner && !encrypted ? [{ label: "Save a copy", icon: "copy", onClick: requestCopy }] : []),
    ...(encrypted && readable ? [{ label: "Save a copy", icon: "copy", onClick: () => v.setShowEncCopy(true) }] : []),
    ...(encrypted && readable ? [{ label: "How this is protected", icon: "key", onClick: () => v.setShowProtection(true) }] : []),
    ...(googleOn
      ? v.googleDocUrl
        ? [
            { label: "Open in Google Docs", icon: "external", href: v.googleDocUrl, external: true },
            { label: v.gBusy ? "Syncing to Google…" : v.googleDocStale ? "Sync to Google Docs" : "Re-sync to Google Docs", icon: "refresh", busy: v.gBusy, onClick: handleGoogleExport },
          ]
        : [{ label: v.gBusy ? "Publishing…" : "Publish to Google Docs", icon: "google", busy: v.gBusy, onClick: handleGoogleExport }]
      : []),
    // Readers choose whether this browser keeps the key (it never leaves it). A shared or
    // borrowed computer shouldn't keep the key to someone's document.
    ...(encrypted && readable && keyFragment
      ? [deviceKeySaved
          ? {
              label: "Forget key on this device",
              icon: "key",
              description: "The link still works; this browser just stops remembering it.",
              onClick: () => { v.forgetOnDevice(); toast.success("This browser no longer keeps the key."); },
            }
          : {
              label: "Remember key on this device",
              icon: "key",
              description: "Opens here without the link next time. Kept only in this browser.",
              onClick: () => { v.rememberOnDevice(); toast.success("Key kept in this browser. Forget it from this menu any time."); },
            }]
      : []),
    ...(!secretUnlocked ? [{ label: "Edit", icon: "edit", disabled: editBlocked, onClick: startEdit }] : []),
    // Any document that isn't encrypted can be written with blocks; the Markdown stays as it is.
    // One that was a page goes back to the page editor, here or on the workspace's own domain.
    ...(secretUnlocked && readable && !encrypted && !isPage && (wasPage || !tenant)
      ? [wasPage
          ? { label: "Switch back to the page editor", icon: "layers", description: "It was a page. The Markdown is unchanged.", onClick: () => setToBlocks(true) }
          : { label: "Open in block editor", icon: "layers", description: "Write it with blocks. The Markdown is unchanged.", onClick: () => setToBlocks(true) }]
      : []),
    ...(canAddSubPage ? [{ label: "Add a sub-page", icon: "plus", onClick: () => setNewSubPage(true) }] : []),
    ...(canManagePage ? [{ label: "Move to…", icon: "arrowRight", onClick: () => setPageAction({ kind: "move" }) }] : []),
    ...(canManagePage ? [{ label: "Duplicate", icon: "copy", description: "A copy beside it, with its sub-pages", onClick: () => setPageAction({ kind: "duplicate", open: true }) }] : []),
    ...(canAddSubPage ? [{ label: "Version history", icon: "history", description: "See and restore earlier versions", onClick: () => setHistoryOpen(true) }] : []),
    ...(encrypted && secretUnlocked && readable ? [{ label: "Version history", icon: "history", description: "Not kept for end-to-end encrypted documents", disabled: true, onClick: () => {} }] : []),
    ...(canManagePage && !page?.template ? [{ label: "Use as template", icon: "layers", description: "Everyone in the workspace can start pages from it", onClick: () => setPageAction({ kind: "template", icon: pageProps?.icon ?? null }) }] : []),
    ...(isPage && !tenant && (isOwner || v.canEditSettings) ? [{ label: "Change link…", icon: "link", description: "The old link keeps working", onClick: () => setChangingLink(true) }] : []),
    ...(editReq?.canRequest ? [{ label: editReq.pending ? "Edit access requested" : "Request edit access", icon: "edit", description: editReq.pending ? "You'll get an email when they decide" : "Ask the owner to let you edit", disabled: editReq.pending, onClick: () => setRequestingEdit(true) }] : []),
    ...(domainOwner ? [
      // (An external link: the menu draws the ↗ itself.)
      { label: "General access on markdrop.in", icon: "globe", href: onMarkdrop, external: true, separated: true },
      ...(isPage ? [{ label: "Change link on markdrop.in", icon: "link", href: onMarkdrop, external: true }] : []),
      { label: "Delete on markdrop.in", icon: "trash", href: onMarkdrop, external: true },
    ] : []),
    // Someone added by email can take themselves off, even when they can't open Share.
    ...(myGrant ? [{ label: "Remove me", icon: "userX", danger: true, separated: true, onClick: () => setLeaving(true) }] : []),
    ...(!secretUnlocked ? [{ label: "Report", icon: "flag", separated: !myGrant, onClick: openReport }] : []),
  ];

  const google = googleOn ? (
    <GoogleDocsCard
      g={{ url: v.googleDocUrl, stale: v.googleDocStale, busy: v.gBusy, error: null, needsReconnect: false }}
      onExport={handleGoogleExport}
      onReconnect={handleGoogleReconnect}
      onDismissError={() => { v.setGError(null); v.setGNeedsReconnect(false); }}
    />
  ) : undefined;

  const details = (
    <DetailsPanel
      url={url}
      shareUrl={shareUrl}
      encrypted={encrypted}
      readable={readable}
      keyFragment={keyFragment}
      createdAt={displayCreatedAt}
      expiresAt={displayExpiresAt}
      views={displayViews}
      content={displayContent}
      protection={protection}
      onProtection={encrypted && readable ? () => { setDetailsOpen(false); v.setShowProtection(true); } : undefined}
      deviceKeySaved={deviceKeySaved}
      onRemember={encrypted && readable && keyFragment ? v.rememberOnDevice : undefined}
      onForget={encrypted && readable ? v.forgetOnDevice : undefined}
      vscodeSynced={vscodeSynced}
      live={v.live}
      access={v.access}
      canShare={v.canShare && !pwdLocked}
      onShare={() => { setDetailsOpen(false); setShowShare(true); }}
      google={google}
      onReport={!secretUnlocked && !pwdLocked ? () => { setDetailsOpen(false); openReport(); } : undefined}
    />
  );

  const tocFooter = readable && !empty
    ? `${readingMinutes(displayContent)} min read, ${pct}% done`
    : undefined;

  const publishedAccess = gate === "signin" || v.access?.level === "private"
    ? "private" as const
    : v.access?.level === "workspace" ? "workspace" as const
    : isPasswordProtected ? "password" as const : "link" as const;
  const showPanel = isNew && !panelDismissed && !gated;
  // Already in an account: the server render's flag (which a password hides), what the reads made
  // here say, or the signed-in reader is the owner. None of those asks to be saved to an account.
  const owned = isOwned || isOwner || v.docOwned;
  const guardActive = isNew && !!claimSecret && !secretCopied && !panelDismissed && !isOwner;

  const notices = (
    <>
      {backToPage}
      {isPage && page?.template && !tenant && <TemplateNotice template={page.template} title={displayTitle} workspaceId={page.workspace_id} slug={slug} />}
      {showPanel && (
        <PublishedPanel
          url={url}
          shareUrl={shareUrl}
          access={publishedAccess}
          encrypted={encrypted}
          password={v.publishedPassword}
          passwordProtected={v.opened?.mode === "password" || !!v.publishedPassword}
          secret={claimSecret}
          signedIn={!!user}
          isOwner={isOwner}
          onOpenFullScreen={canFullScreen ? () => v.toggleImmersive(true) : undefined}
          onSaveToAccount={user && !owned && !claimed ? handleClaim : undefined}
          secretSaved={claimed}
          signInHref={signInHref}
          workspaceShareFailed={wsShareFailed}
          onDismiss={() => setPanelDismissed(true)}
          onLinkCopied={copyLinkEvent}
          onSecretCopied={() => setSecretCopied(true)}
          className="no-print mb-4"
        />
      )}
      {/* Save to account, for a secret holder who isn't on the
          publish panel (a reload, or ?edit). */}
      {!showPanel && !owned && !claimed && claimSecret && v.ownerKnown && (
        user ? (
          <Alert
            tone="info"
            className="no-print"
            actions={<Button size="sm" variant="secondary" onClick={handleClaim}>Save to my account</Button>}
          >
            Save this document to your account to manage it and see analytics.
          </Alert>
        ) : (
          <Alert tone="info" className="no-print">
            <a href={signInHref} className="font-semibold text-accent-text underline underline-offset-4">Sign in</a>{" "}
            to save this document to your account and track analytics.
          </Alert>
        )
      )}
      {claimMsg && !showPanel && <p className="no-print text-caption text-text-secondary" role="status">{claimMsg}</p>}
      {rotated && <div className="no-print"><RotatedNotice link={rotated} /></div>}
      {v.passwordChange && (
        <Alert
          tone={v.passwordChange === "set" ? "info" : "warning"}
          icon="lock"
          className="no-print"
          onDismiss={() => v.setPasswordChange(null)}
          title={v.passwordChange === "set" ? "New password set" : "Password removed"}
        >
          {v.passwordChange === "set"
            ? "Readers now need the link and the new password — send them separately. Anyone who saved an old copy can still read that copy with the old password."
            : "Anyone with the link can read the current version."}
        </Alert>
      )}
      {keySource === "device" && !rotated && readable && <div className="no-print"><DeviceKeyNotice shareUrl={shareUrl} linkStale={v.linkKeyStale} /></div>}
      {v.gError && (
        <Alert
          tone="danger"
          className="no-print"
          onDismiss={() => { v.setGError(null); v.setGNeedsReconnect(false); }}
          actions={v.gNeedsReconnect ? <Button size="sm" variant="secondary" onClick={handleGoogleReconnect}>Reconnect Google Docs</Button> : undefined}
        >
          {v.gError}
        </Alert>
      )}
    </>
  );

  // ── A page: one frame for readers and editors (components/pages/PageChrome) ──────────
  // No app header: the page's own bar (PageTopBar) is the only one, with the logo and the account
  // in it. The rail (≥1280 px, a drawer below) keeps the page tree (and a reader's contents); the
  // paper beside it carries the page.
  const pageLayoutClass = pageProps
    ? [pageProps.smallText && "pb-small", pageProps.font !== "default" && `pb-font-${pageProps.font}`].filter(Boolean).join(" ")
    : "";
  const pagePresence = readable ? <DocPresence presence={presence} signedIn={!!user} /> : null;
  const pageShare = v.canShare && !pwdLocked ? () => setShowShare(true) : null;
  const detailsItem: MenuEntry = { label: "Details", icon: "info", description: "Published, views, who can open it", onClick: () => setDetailsOpen(true) };
  const copyItem: MenuEntry = { label: "Copy link", icon: "link", onClick: () => void navigator.clipboard?.writeText(shareUrl).then(() => { copyLinkEvent(); toast.success("Link copied"); }, () => toast.error("Couldn't copy")) };
  // A reader's ⋯: the document's menu, with Details (and Copy link when Share takes the bar).
  const readerPageMenu: MenuEntry[] = [...(pageShare ? [copyItem] : []), ...menu, { ...detailsItem, separated: true }];
  // An editor's ⋯ has the page's own options first (PageEditor); these follow them.
  const EDITOR_HAS = new Set(["View raw", "View rendered", "Add a sub-page", "Move to…", "Duplicate", "Edit", "Report", "Save a copy"]);
  const editorDocMenu: MenuEntry[] = [
    ...menu.filter((m) => !("label" in m) || typeof m.label !== "string" || !EDITOR_HAS.has(m.label)).map((m, i) => (i === 0 ? { ...m, separated: true } : m)),
    ...(canManagePage && (aiStatus?.can_write || aiStatus?.reason === "workspace_off") ? [{ label: "Translate…", icon: "globe", description: aiStatus.can_write && aiStatus.enabled ? "A translated copy next to this page" : "AI is off for this workspace", disabled: !(aiStatus.can_write && aiStatus.enabled), onClick: () => setTranslating(true) }] : []),
    detailsItem,
  ];
  // Someone else holds the page's edit lock, as who's viewing says: their editor opens read only.
  const snap = presence.snapshot;
  // (`you` is this person's own entry, all their tabs; without it, their name stands in.)
  const otherEditor = snap?.viewers.find((x) => x.editing && x.id !== snap.you && x.id !== snap.me?.id && !(snap.you == null && !!user?.name && x.name === user.name)) ?? null;
  const othersEditing = otherEditor ? otherEditor.name || (otherEditor.animal ? `Anonymous ${otherEditor.animal}` : "Someone") : null;
  const pageBacklinks = !tenant ? <Backlinks key={user?.id ?? "anon"} slug={slug} addressing={addressing} /> : null;
  // A meeting page (or its transcript): who was there, who can open it, Transcript and Ask.
  const meetingBar = readable && !!user && isPage && page?.meeting && !tenant
    ? <MeetingHeader meetingId={page.meeting.id} role={page.meeting.role} extra={pageJira.bulkButton} /> : null;
  // From meetings in View mode (signed-in members of the page's workspace; the server decides what
  // they see): related decisions and action items for the section in view. Insert, for someone who
  // can edit, opens Edit with it after that section, as Ask Markdrop's Insert does.
  const viewMemory = readable && !!user && isPage && !!page?.workspace_id && !showRaw && !gated ? (
    <MeetingMemory
      slug={slug}
      workspaceId={page.workspace_id}
      title={displayTitle ?? ""}
      editor={null}
      readOnly
      ai={false}
      view={{ root: readRef, content: withoutFrontMatter(displayContent), onInsert: canEditPage && !editMode ? viewInsert : null }}
    />
  ) : null;
  const propsHref = tenant ? undefined : (s: string) => `/${encodeURIComponent(s)}`;
  const readerProps = page?.page_properties ? <PropertiesPanel info={page.page_properties} workspaceId={page.workspace_id ?? null} pageHref={propsHref} /> : null;
  const pageFooter = isPage ? (
    <>
      <SubPages
        slug={slug}
        count={page?.children_count ?? 0}
        ancestors={crumbs.map((c) => c.slug)}
        addressing={addressing}
        onAdd={canAddSubPage ? () => setNewSubPage(true) : null}
        refreshKey={kidsKey}
      />
      {!pageEditable && !empty && <Colophon />}
    </>
  ) : null;
  // In the editor, Contents entries are the editor's own headings, in order (PageEditor onHeadings).
  const toEditorHeading = (id: string) => {
    const n = /^pb-eh-(\d+)$/.exec(id)?.[1];
    if (n === undefined) return;
    const el = document.querySelectorAll<HTMLElement>(".pb-live .ProseMirror :is(h1, h2, h3, h4)")[Number(n)];
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el?.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
  };
  const pageRail = isPage && (tocEntries.length > 0 || crumbs.length > 0 || (page?.children_count ?? 0) > 0);
  const pageMain = pageScreen ? (
    <div className={`pb-shell${pageRail ? " pb-shell--rail" : ""}`}>
      {pageRail && (
        <aside className="pb-rail no-print" aria-label="Pages">
          <div className="pb-rail__in">
            <PageRailHead />
            <PageTree
              key={`${crumbs[0]?.slug ?? slug}:${treeKey}:${user?.id ?? "anon"}`}
              slug={slug}
              title={displayTitle}
              icon={pageProps?.icon ?? null}
              crumbs={crumbs}
              childrenCount={page?.children_count ?? 0}
              addressing={addressing}
              canEdit={canManagePage}
              workspaceId={page?.workspace_id ?? null}
              // The tree's top page is at the top level when every ancestor is readable.
              rootParent={pagePathSlugs.length === crumbs.length ? null : undefined}
              onMoved={(s, from, to) => {
                if (s === slug || crumbs.some((c) => c.slug === s) || from === slug || to === slug) rereadPage(false);
              }}
            />
            {tocEntries.length > 0 && (
              pageEditable
                ? <Toc headings={headings} encrypted={false} activeId={null} onNavigate={toEditorHeading} />
                : <Toc headings={headings} encrypted={false} footer={tocFooter} markers={tocMarkers} />
            )}
          </div>
        </aside>
      )}
      <div className="pb-paper">
        {(!pageEditable || !editorReady) && (
          <PageFrame
            layout={pageLayoutClass}
            full={!!pageProps?.fullWidth}
            innerRef={readRef}
            frameRef={onPageFrame}
            className="ph-no-capture"
            bar={
              <PageTopBar
                crumbs={crumbs}
                title={displayTitle}
                icon={pageProps?.icon ?? null}
                resolve={resolvePageAsset}
                addressing={addressing}
                presence={pagePresence}
                tools={viewMemory || (canEditPage && !showRaw) || commentsSummary ? <>{viewMemory}{commentsSummary && !showRaw && <CommentsButton />}{canEditPage && !showRaw && <PageModeButton mode="edit" busy={pageEditable} onClick={() => enterEdit("click")} />}</> : undefined}
                onShare={pageShare}
                shareUrl={shareUrl}
                onCopied={copyLinkEvent}
                menu={readerPageMenu}
                ask={askable}
              />
            }
            head={<PageHead title={displayTitle} props={pageProps!} resolve={resolvePageAsset} below={<><SignoffSummary slug={slug} />{readerProps}{meetingBar}{pageBacklinks}</>} />}
            footer={pageFooter}
          >
            {notices}
            <div className="hidden print-only">{displayTitle && <h1 className="mb-4 text-h1">{displayTitle}</h1>}</div>
            {empty ? (
              <p className="pb-emptyread">This page is empty.</p>
            ) : showRaw ? (
              <div className="flex flex-col gap-3">
                <CopyButton text={displayContent} label="Copy all" size="sm" variant="secondary" className="no-print self-end" />
                <pre className="whitespace-pre-wrap break-words rounded-xl border border-border bg-surface-inset p-4 font-mono text-code text-text">{displayContent}</pre>
              </div>
            ) : (
              <PageRenderer
                slug={slug}
                content={displayContent}
                assets={page?.assets ?? null}
                signInHref={signInHref}
                onHeadings={setHeadings}
                crumbs={crumbs}
                title={displayTitle}
                href={pageHref}
                viewer={user?.id ?? null}
                subscribeLive={v.subscribeLive}
                onToggleTask={canEditPage && !editMode && !othersEditing && !(pageProps?.locked && !isOwner && !v.access?.can?.edit_locked) ? toggleTask : null}
                jira={pageJira.jira}
              />
            )}
            {pageJira.dialogs}
            {!showRaw && !(wideRail && pageRail && tocEntries.length > 0) && <PresenceMargin root={readRef} markers={markers} left={-14} />}
          </PageFrame>
        )}
        {pageEditable && (
          <div className={editorReady ? "pb-live" : "pb-preload"} aria-hidden={editorReady ? undefined : true}>
            <PageEditor
              slug={slug}
              userId={user?.id ?? null}
              title={displayTitle}
              content={displayContent}
              rev={v.docRev}
              secret={v.secretInput || null}
              workspaceId={page?.workspace_id ?? null}
              crumbs={crumbs}
              assets={page?.assets ?? null}
              addressing={addressing}
              subscribeLive={v.subscribeLive}
              onReady={() => setEditorReady(true)}
              onMoved={(doc) => {
                // Renamed while open in Edit: the new address opens in Edit too (?edit=1, which
                // Done drops), whether or not this view stays mounted across the move.
                setPageMode({ slug: doc.slug, mode: "edit", from: slug });
                const q = new URLSearchParams(window.location.search);
                if (q.get("edit") !== "1") {
                  q.set("edit", "1");
                  window.history.replaceState(window.history.state, "", `${window.location.pathname}?${q}${window.location.hash}`);
                }
                v.followMove(doc);
              }}
              insertOnOpen={editorReady ? pageInsert : null}
              onInserted={() => setPageInsert(null)}
              othersEditing={othersEditing}
              onHeadings={setHeadings}
              coverPending={page?.cover_pending === true}
              coverAuto={page?.cover_auto === true}
              onSaved={(doc) => {
                if (typeof doc.rev === "number") v.setDocRev(doc.rev);
                if (typeof doc.content === "string") v.setDisplayContent(doc.content);
                v.setDisplayTitle(doc.title || null);
                pendingRevalidate.current = true;
                revalidate();
              }}
              onAddSubPage={canAddSubPage ? () => setNewSubPage(true) : null}
              onMoveTo={canManagePage ? () => setPageAction({ kind: "move" }) : null}
              onDuplicate={canManagePage ? () => setPageAction({ kind: "duplicate", open: true }) : null}
              onDelete={!tenant && (isOwner || v.canEditSettings) ? () => setDeleting(true) : null}
              isOwner={isOwner || v.canEditSettings}
              mayEditLocked={!!v.access?.can?.edit_locked}
              url={url}
              updatedAt={null}
              chrome={{
                presence: commentsSummary ? <>{pagePresence}<CommentsButton /></> : pagePresence,
                ask: askable,
                onShare: pageShare,
                shareUrl,
                onCopied: copyLinkEvent,
                menu: editorDocMenu,
                below: meetingBar ? <>{meetingBar}{pageBacklinks}</> : pageBacklinks,
                properties: page?.page_properties ?? null,
                propertiesHref: propsHref,
                footer: pageFooter,
                notices,
                onDone: leaveEdit,
              }}
            />
          </div>
        )}
      </div>
      {!pageEditable && <LiveUpdatePill show={livePill} />}
      {commentsSummary && !showRaw && <CommentLayer root={pageEditable ? editEl : readEl} name={pageEditable ? "md-comments-editor" : "md-comments"} />}
      {readable && !!user && isPage && page?.meeting && !tenant && <MeetingLauncher meetingId={page.meeting.id} role={page.meeting.role} />}
    </div>
  ) : null;
  return (
    <CommentsHost
      slug={slug}
      summary={commentsSummary}
      user={user ? { id: user.id, name: user.name ?? null } : null}
      signInHref={signInHref}
      subscribeLive={v.subscribeLive}
      readPassword={isPasswordProtected ? (typeof window !== "undefined" ? sessionStorage.getItem(`pwd:${slug}`) : null) : null}
    >
    {/* data-md-e2e: third-party analytics (lib/thirdPartyAnalytics) never runs while this is on the page. */}
    <div className={`flex min-w-0 flex-1 flex-col md-comments-host ${showImmersive ? "md-viewer-immersive" : ""}`} data-md-e2e={encrypted ? "" : undefined}>
      {/* First, so its inline script runs before the locked chrome below is parsed (lib/opening). */}
      {(pwdFetching || (opened && pageScreen && !pageFramed)) && <OpeningCover tenant={!!tenant} />}
      {!pageScreen && framed && docBar({
        title: readable ? shownTitle : null,
        onProtection: encrypted && readable ? () => v.setShowProtection(true) : null,
        onCopyLink: copyLinkEvent,
        onEdit: secretUnlocked && !editBlocked ? handleEditClick : null,
        onShare: pageShare,
        onFullScreen: canFullScreen ? () => v.toggleImmersive(true) : null,
        menu: readerPageMenu,
        headings: tocEntries.length ? headings : [],
        rail: !gated,
      })}

      <main id="main" tabIndex={-1} className={pageScreen ? "pb-screen outline-none" : "flex min-w-0 flex-1 flex-col outline-none"}>
        {pageScreen ? pageMain : <>
        {/* Framed reading progress follows the page; the immersive one lives
            inside the layer (its own scroller, and above the page). */}
        {framed && !gated && readable && !empty && <ReadingProgress key="page" />}
        {framed && <LiveUpdatePill show={livePill} />}

        {/* Fixed slots: rails and notices come and go around the one content
            element without ever re-parenting it. */}
        <div
          className={framed
            ? "md-docgrid mx-auto grid w-full max-w-marketing flex-1 grid-cols-1 content-start gap-10 px-4 pb-16 pt-6 sm:px-6 sm:pt-8 xl:grid-cols-[200px_minmax(0,680px)_260px] xl:justify-between"
            : "contents"}
        >
          {framed && (
            <aside className="md-docrail no-print hidden xl:block" aria-label="Contents">
              {(tocEntries.length > 0 || (isPage && readable && (crumbs.length > 0 || (page?.children_count ?? 0) > 0))) && (
                <div className="sticky top-16 flex max-h-[calc(100dvh-5rem)] flex-col gap-6 overflow-y-auto pb-6">
                  {isPage && readable && !gated && (
                    <PageTree
                      key={`${crumbs[0]?.slug ?? slug}:${treeKey}:${user?.id ?? "anon"}`}
                      slug={slug}
                      title={displayTitle}
                      icon={pageProps?.icon ?? null}
                      crumbs={crumbs}
                      childrenCount={page?.children_count ?? 0}
                      addressing={addressing}
                      canEdit={canManagePage}
                      workspaceId={page?.workspace_id ?? null}
                      // The tree's top page is at the top level when every ancestor is readable.
                      rootParent={pagePathSlugs.length === crumbs.length ? null : undefined}
                      onMoved={(s, from, to) => {
                        if (s === slug || crumbs.some((c) => c.slug === s) || from === slug || to === slug) rereadPage(false);
                      }}
                    />
                  )}
                  {tocEntries.length > 0 && <Toc headings={headings} encrypted={encrypted} footer={tocFooter} markers={tocMarkers} />}
                </div>
              )}
            </aside>
          )}

          <div className={framed ? "mx-auto flex w-full min-w-0 max-w-reading flex-col gap-4 xl:mx-0" : "contents"}>
            {framed && notices}

            {/* The loading state wins over the gate, not the other way round. The
                server render is anonymous, so a reader who *does* have access still
                arrives locked and is only let in once the client retries with their
                token — and showing "this isn't public" for that second tells them
                something untrue about a document they can read. */}
            {pwdFetching ? (
              <div className={`flex flex-col gap-3 py-4 ${vs.delayed}`} aria-busy="true">
                <span className="md-visually-hidden" role="status">Opening document</span>
                <Skeleton width="40%" height={28} />
                {[100, 92, 96, 70, 100, 88, 94, 60].map((w, i) => <Skeleton key={i} width={`${w}%`} />)}
              </div>
            ) : pwdLocked ? (
              <div className="py-6 sm:py-12">
                <AccessGate
                  mode={gateMode}
                  signInHref={signInHref}
                  signInLabel={tenant ? `Sign in to read ${tenant.name}` : "Sign in to open"}
                  headingLevel={1}
                  email={user?.email}
                  value={pwdInput}
                  onValue={setPwdInput}
                  onSubmit={handlePasswordUnlock}
                  submitting={pwdUnlocking}
                  error={pwdError}
                  errorKey={v.pwdErrorKey}
                  visible={pwdVisible}
                  onToggleVisible={() => setPwdVisible((x: boolean) => !x)}
                  request={v.deniedInfo ? { slug, ...v.deniedInfo } : null}
                />
              </div>
            ) : (
              /* THE content element: one element in both modes, classes only.
                 The print variants flatten the fixed overlay back into the flow
                 so Export PDF still works from full screen. */
              <div
                ref={layerRef}
                className={
                  showImmersive
                    ? "fixed inset-0 z-(--z-overlay) overflow-y-auto overscroll-contain bg-bg print:static print:overflow-visible"
                    : "relative min-w-0"
                }
              >
                <div
                  ref={readRef}
                  // ph-no-capture: the document (title, body, raw view) is never recorded, and clicks
                  // inside it are never autocaptured with their text.
                  className={`ph-no-capture relative ${vs.column} mx-auto w-full max-w-reading ${
                    showImmersive ? "px-5 pb-32 pt-12 sm:px-8 sm:pt-24 print:p-0" : ""
                  } ${pageLayout}`}
                >
                  <div className="hidden print-only">
                    {displayTitle && <h1 className="mb-4 text-h1">{displayTitle}</h1>}
                  </div>
                  {isPage && readable && !showRaw && (
                    <PageHead
                      title={displayTitle}
                      props={pageProps!}
                      resolve={resolvePageAsset}
                    />
                  )}
                  {isPage && readable && !showRaw && !tenant && (
                    <Backlinks key={user?.id ?? "anon"} slug={slug} addressing={addressing} />
                  )}
                  {!isPage && readable && displayTitle && !showRaw && !empty && !opensWithOwnTitle(displayContent, displayTitle) && (
                    <h1 dir="auto" className="no-print mb-8 break-words text-h1 text-text">
                      {displayTitle}
                    </h1>
                  )}
                  {!readable ? (
                    <EncryptionState
                      url={url}
                      state={decryptState === "nokey" || decryptState === "failed" || decryptState === "unsupported" || decryptState === "password" ? decryptState : "working"}
                      reason={v.decryptReason}
                      onPasteLink={v.applyPastedLink}
                      onPassword={v.submitE2EPassword}
                      passwordError={v.e2ePwdError}
                      passwordErrorKey={v.e2ePwdErrorKey}
                      passwordChecking={v.e2ePwdChecking}
                    />
                  ) : empty ? (
                    <EmptyState icon="doc" title="This document is empty" className="py-16" />
                  ) : showRaw ? (
                    <div className="flex flex-col gap-3">
                      <CopyButton text={displayContent} label="Copy all" size="sm" variant="secondary" className="no-print self-end" />
                      <pre className="whitespace-pre-wrap break-words rounded-xl border border-border bg-surface-inset p-4 font-mono text-code text-text">
                        {displayContent}
                      </pre>
                    </div>
                  ) : isPage ? (
                    <PageRenderer
                      slug={slug}
                      content={displayContent}
                      assets={page?.assets ?? null}
                      signInHref={signInHref}
                      onHeadings={setHeadings}
                      crumbs={crumbs}
                      title={displayTitle}
                      href={pageHref}
                      viewer={user?.id ?? null}
                    />
                  ) : (
                    <MarkdownPreview
                      content={wasPage ? withoutFrontMatter(displayContent) : displayContent}
                      size="reading"
                      anchors={!encrypted}
                      encrypted={encrypted}
                      onHeadings={setHeadings}
                      onCodeCopy={encrypted ? undefined : v.onCodeCopy}
                      remoteImages={encrypted && !v.remoteImagesOk ? "ask" : "allow"}
                      onAllowRemoteImages={v.allowRemoteImages}
                    />
                  )}
                  {isPage && readable && !showRaw && (
                    <SubPages
                      slug={slug}
                      count={page?.children_count ?? 0}
                      ancestors={crumbs.map((c) => c.slug)}
                      addressing={addressing}
                      onAdd={canAddSubPage ? () => setNewSubPage(true) : null}
                      refreshKey={kidsKey}
                    />
                  )}
                  {readable && !empty && <Colophon />}
                  {readable && !showRaw && !railShown && (
                    <PresenceMargin root={readRef} markers={markers} left={showImmersive ? 2 : -14} />
                  )}
                  {!pageScreen && commentsSummary && !showRaw && !editing && <CommentLayer root={readEl} />}
                </div>
                {showImmersive && readable && !empty && <ReadingProgress key="layer" scroller={layerRef} />}
                {showImmersive && readable && !showRaw && <TocTicks headings={headings} encrypted={encrypted} />}
                {showImmersive && <LiveUpdatePill show={livePill} />}
                {showImmersive && readable && (
                  <DocPresence presence={presence} signedIn={!!user} variant="float" hideWhenAlone />
                )}
                {showImmersive && commentsSummary && !showRaw && <CommentsButton className="mdc-floatbtn" />}
                {showImmersive && !(viewerChrome === "none" && !user) && (
                  <ImmersiveExit onExit={() => v.toggleImmersive(false)} />
                )}
              </div>
            )}
          </div>

          {framed && !gated && (
            <aside className="md-docrail no-print hidden xl:block" aria-label="Details">
              <div className="sticky top-16 pb-6">{details}</div>
            </aside>
          )}
        </div>

        {framed && !gated && (
          <DocumentActionBar
            shareUrl={shareUrl}
            onCopyLink={copyLinkEvent}
            onContents={tocEntries.length ? () => setContentsOpen(true) : null}
            onShare={v.canShare && !pwdLocked ? () => setShowShare(true) : null}
            onEdit={secretUnlocked && !editBlocked ? handleEditClick : null}
            menu={menu}
            copyVariant={showPanel ? "secondary" : "primary"}
          />
        )}
        </>}
      </main>

      {/* Details below 1280px: a right drawer, a bottom sheet on phones. */}
      <Drawer
        open={framed && detailsOpen}
        onClose={() => setDetailsOpen(false)}
        title="Details"
        side={phone ? "bottom" : "right"}
        width={360}
      >
        {details}
      </Drawer>
      <Drawer
        open={framed && contentsOpen}
        onClose={() => setContentsOpen(false)}
        title="Contents"
        description={tocFooter}
        side="bottom"
      >
        <Toc headings={headings} encrypted={encrypted} variant="sheet" onNavigate={() => setContentsOpen(false)} markers={tocMarkers} />
      </Drawer>

      <SaveCopyDialog
        open={showCopy}
        onClose={() => { if (!v.copyBusy) setShowCopy(false); }}
        busy={v.copyBusy}
        error={v.copyError}
        gConnected={gConnected}
        onCopy={v.handleCopy}
      />

      {encrypted && (
        <>
          <EncryptedCopyDialog
            open={v.showEncCopy}
            onClose={() => { if (!v.encCopyBusy) v.setShowEncCopy(false); }}
            busy={v.encCopyBusy}
            error={v.encCopyError}
            onCopy={v.handleEncryptedCopy}
            signedIn={!!user}
          />
          <ProtectionDialog
            open={v.showProtection}
            onClose={() => v.setShowProtection(false)}
            sealed={v.sealed}
            keySource={keySource}
            deviceKeySaved={deviceKeySaved}
            onRemember={keyFragment ? v.rememberOnDevice : undefined}
            onForget={v.forgetOnDevice}
          />
        </>
      )}

      {showShare && (
        <ShareDialog
          slug={slug}
          title={shownTitle || slug}
          documentId={v.docId}
          shareUrl={shareUrl}
          onClose={() => setShowShare(false)}
          onChanged={v.loadAccess}
          peopleOnly={tenant ? onMarkdrop : undefined}
        />
      )}

      {toBlocksDialog}

      {newSubPage && (
        <TemplateGallery
          open
          onClose={() => setNewSubPage(false)}
          parent={slug}
          parentTitle={shownTitle}
          // On a workspace's domain a page lives under its folders and ancestors.
          onCreated={tenant ? (c) => router.push(`${pagePath(c.document.slug, { tenant: true, folderPath: c.document.folder_path ?? [] })}?edit=1`) : undefined}
        />
      )}
      {requestingEdit && (
        <RequestEditDialog
          slug={slug}
          open
          onClose={() => setRequestingEdit(false)}
          onSent={() => { setRequestingEdit(false); setEditReq({ canRequest: true, pending: true }); toast.success("Request sent. You'll get an email when they decide."); }}
        />
      )}
      {pageActions}
      {translating && <TranslateDialog open onClose={() => setTranslating(false)} slug={slug} title={displayTitle} onCreated={() => setTreeKey((k) => k + 1)} />}
      {canAddSubPage && historyOpen !== null && (
        <PageHistory open={historyOpen} slug={slug} title={displayTitle} onClose={() => setHistoryOpen(false)} signInHref={signInHref} crumbs={crumbs} href={pageHref} viewer={user?.id ?? null} />
      )}
      {pageExport}
      {changingLink && <ChangeLinkDialog slug={slug} secret={v.secretInput || null} onClose={() => setChangingLink(false)} />}
      {isPage && (
        <DeletePageDialog
          open={deleting}
          onClose={() => setDeleting(false)}
          slug={slug}
          title={shownTitle || null}
          count={page?.children_count ?? null}
          secret={v.secretInput || null}
          workspaceId={page?.workspace_id ?? null}
          onDeleted={() => {
            // The dialog moved it to Trash and toasts Undo (the toast outlives this page).
            setDeleting(false);
            revalidate(true);
            router.push(crumbs.length ? `/${encodeURIComponent(crumbs[crumbs.length - 1].slug)}` : "/dashboard");
          }}
          onRestored={() => router.push(`/${encodeURIComponent(slug)}`)}
        />
      )}

      <ConfirmDialog
        open={leaving}
        onClose={() => setLeaving(false)}
        title={<>Remove yourself from “<span className="ph-sensitive ph-mask">{shownTitle || slug}</span>”?</>}
        body="It leaves Shared with me, and you can't open it with your email any more. If the link is open to more people, it still works for you like it does for them. To get back in, ask the owner to add you again."
        confirmLabel="Remove me"
        onConfirm={async () => {
          await removePerson(slug, v.access?.your_email || user!.email);
          setLeaving(false);
          toast.success(<>You were removed from “<span className="ph-sensitive ph-mask">{shownTitle || slug}</span>”.</>);
          router.push("/shared");
        }}
      />

      <ReportDialog
        open={showReport}
        onClose={() => setShowReport(false)}
        done={v.reportDone}
        busy={v.reportBusy}
        error={v.reportError}
        category={v.reportCategory}
        onCategory={v.setReportCategory}
        reason={v.reportReason}
        onReason={setReportReason}
        onSubmit={v.submitReport}
      />

      {claimSecret && (
        <LeaveGuard active={guardActive} secret={claimSecret} onCopied={() => setSecretCopied(true)} />
      )}
      {commentsSummary && !showRaw && <CommentsPanel />}
    </div>
    </CommentsHost>
  );
}
