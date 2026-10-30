"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import MarkdownPreview from "@/components/MarkdownPreview";
import ImmersiveExit from "@/components/ImmersiveExit";
import AccessGate from "@/components/access/AccessGate";
import { Alert, Button, CopyButton, Drawer, EmptyState, Skeleton, type MenuEntry } from "@/components/ui";
import { SiteHeader } from "@/components/shell/SiteHeader";
import { TenantHeader, useTenant } from "@/components/tenant";
import { PHONE_QUERY, useMediaQuery } from "@/components/kit/publish-utils";
import { ReadingProgress, Toc, TocTicks, tocHeadings, useReadingProgress, type Heading } from "@/components/reading";
import * as e2e from "@/lib/e2e";
import { recordEvent } from "@/lib/api";
import { track } from "@/lib/track";
import { useAnalyticsDoc } from "@/lib/useAnalyticsDoc";
import { useDocumentViewer } from "./doc/useDocumentViewer";
import type { DocumentViewProps } from "./doc/types";
import { DocumentActionBar, DocumentBar } from "./doc/DocumentBar";
import { DetailsPanel, readingMinutes } from "./doc/DetailsPanel";
import { DeviceKeyNotice, EncryptionState, RotatedNotice } from "./doc/EncryptionState";
import { LeaveGuard } from "./doc/LeaveGuard";
import { LiveUpdatePill, useLiveUpdate } from "./doc/LiveUpdate";
import { Colophon } from "./doc/Colophon";
import vs from "./doc/viewer.module.css";

// Code that only runs after an interaction or in a specific state loads on demand, so a reader's first
// load carries the reading view only (REVAMP_BUILD §8.5 budget for /[slug]). Each still renders on the
// server when the state calls for it (dynamic() keeps SSR), so artifact pages and gates are unchanged.
const ArtifactView = dynamic(() => import("./ArtifactView"));
const ShareDialog = dynamic(() => import("@/components/access/ShareDialog"));
const PublishedPanel = dynamic(() => import("@/components/kit/PublishedPanel").then((m) => m.PublishedPanel));
const GoogleDocsCard = dynamic(() => import("./doc/GoogleDocsCard").then((m) => m.GoogleDocsCard));
const EditorScreen = dynamic(() => import("./doc/EditorScreen").then((m) => m.EditorScreen));
const SecretUnlock = dynamic(() => import("./doc/EditorScreen").then((m) => m.SecretUnlock));
const ReportDialog = dynamic(() => import("./doc/ReportDialog").then((m) => m.ReportDialog));
const SaveCopyDialog = dynamic(() => import("./doc/SaveCopyDialog").then((m) => m.SaveCopyDialog));

/**
 * Does the document already open with a heading that says what the title says?
 *
 * Full screen hides the chrome, so the stored title has to be drawn into the
 * reading column or a document whose markdown starts with prose loses it
 * entirely. But most documents *do* lead with their own H1, and printing ours
 * above it just says the same thing twice in two different sizes.
 */
function opensWithOwnTitle(content: string, title: string | null): boolean {
  if (!title) return true;
  const firstLine = content.split("\n").find((l) => l.trim());
  const heading = firstLine?.match(/^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/)?.[1];
  if (!heading) return false;
  const norm = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(heading) === norm(title);
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
 *  - **Framed**: SiteHeader (TenantHeader on a workspace domain), the sticky
 *    DocumentBar, Contents rail · reading column · Details rail at ≥1280px; a
 *    Contents dropdown and a Details drawer below that; bottom sheets and a
 *    bottom action bar on phones.
 *  - **Gates**, **encryption states**, **edit flow**, **?new=1** PublishedPanel.
 *
 * One content element serves both reading modes — immersive only swaps its
 * classes. Rendering a second copy into an overlay would tear the subtree down
 * and remount it on every toggle, re-running every Mermaid diagram and KaTeX
 * block inside it. Everything around it sits in fixed slots so React never
 * re-parents it.
 */
export default function DocumentView(props: DocumentViewProps) {
  const { slug, url, isPasswordProtected = false, gate = null, isOwned = false, encrypted = false, viewerChrome = "full" } = props;
  const v = useDocumentViewer(props);
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
  const pathname = usePathname();
  const phone = useMediaQuery(PHONE_QUERY);
  const layerRef = useRef<HTMLDivElement>(null);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [contentsOpen, setContentsOpen] = useState(false);
  const [panelDismissed, setPanelDismissed] = useState(false);
  const [secretCopied, setSecretCopied] = useState(false);
  const [wsShareFailed, setWsShareFailed] = useState(false);

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

  const livePill = useLiveUpdate(v.liveUpdate, displayContent, readRef);
  useAnalyticsDoc(
    artifactDoc
      ? null
      : {
          ref: props.docRef ?? null,
          kind: "document",
          access: props.encrypted ? "encrypted" : props.isPasswordProtected || props.gate ? "protected" : "public",
        },
  );
  const pct = useReadingProgress();

  // ── Artifact discovered behind the password gate ───────────────────────────
  if (artifactDoc) {
    return (
      <ArtifactView
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
        docRef={artifactDoc.ref ?? null}
        readTicket={artifactDoc.read_ticket ?? null}
        fileVersion={artifactDoc.file_version ?? null}
        viewerChrome={viewerChrome === "none" ? "none" : "full"}
      />
    );
  }

  const gated = pwdLocked || pwdFetching;
  const gateMode: "password" | "signin" | "denied" = accessDenied ? "denied" : gate === "signin" ? "signin" : "password";
  const header = tenant
    ? <TenantHeader returnPath={pathname || undefined} hideAuth={gated && !pwdFetching && gateMode === "signin"} />
    : <SiteHeader />;

  // ── Edit flow ──────────────────────────────────────────────────────────────
  if (editing) {
    return (
      <>
        {header}
        <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
          {secretUnlocked ? (
            <EditorScreen
              v={v}
              isPasswordProtected={isPasswordProtected}
              encrypted={encrypted}
              displayTitle={displayTitle}
              displayContent={displayContent}
            />
          ) : (
            <SecretUnlock v={v} />
          )}
        </main>
      </>
    );
  }

  // ── Read mode ──────────────────────────────────────────────────────────────
  const framed = !showImmersive;
  const empty = readable && !displayContent.trim();
  const protection: "private" | "password" | null = isPasswordProtected ? (gate === "signin" ? "private" : "password") : null;
  const tocEntries = readable && !showRaw ? tocHeadings(headings) : [];
  // The stored title, else the document's own leading H1 (most documents carry their title there).
  const shownTitle = displayTitle || (headings[0]?.depth === 1 ? headings[0].text : null);

  function copyLinkEvent() {
    recordEvent(slug, "copy_url", readTicket);
    track("doc_copy_link");
  }
  function exportPdf() {
    recordEvent(slug, "export_pdf", readTicket);
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

  const menu: MenuEntry[] = gated ? [] : [
    ...(readable && !empty ? [{ label: showRaw ? "View rendered" : "View raw", icon: "code", onClick: () => setShowRaw(!showRaw) }] : []),
    ...(readable ? [{ label: "Export PDF", icon: "printer", onClick: exportPdf }] : []),
    // Hidden for encrypted documents: the copy happens server-side, which would
    // duplicate ciphertext under a slug whose link carries no key.
    ...(!isOwner && !encrypted ? [{ label: "Save a copy", icon: "copy", onClick: requestCopy }] : []),
    ...(googleOn
      ? v.googleDocUrl
        ? [
            { label: "Open in Google Docs", icon: "external", href: v.googleDocUrl, external: true },
            { label: v.gBusy ? "Syncing to Google…" : v.googleDocStale ? "Sync to Google Docs" : "Re-sync to Google Docs", icon: "refresh", busy: v.gBusy, onClick: handleGoogleExport },
          ]
        : [{ label: v.gBusy ? "Publishing…" : "Publish to Google Docs", icon: "google", busy: v.gBusy, onClick: handleGoogleExport }]
      : []),
    // A shared or borrowed computer shouldn't keep the key to someone's document.
    ...(encrypted && deviceKeySaved
      ? [{
          label: "Forget key on this device",
          icon: "key",
          description: "The link still works; this browser just stops remembering it.",
          onClick: () => { e2e.forgetKey(slug); setDeviceKeySaved(false); },
        }]
      : []),
    ...(!secretUnlocked ? [{ label: "Edit", icon: "edit", disabled: editBlocked, onClick: startEdit }] : []),
    ...(!secretUnlocked ? [{ label: "Report", icon: "flag", separated: true, onClick: openReport }] : []),
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

  return (
    <div className={`flex min-w-0 flex-1 flex-col ${showImmersive ? "md-viewer-immersive" : ""}`}>
      {framed && header}

      <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
        {framed && (
          <DocumentBar
            slug={slug}
            url={url}
            shareUrl={shareUrl}
            title={readable ? shownTitle : null}
            gated={gated}
            gateBadge={protection}
            encrypted={encrypted}
            onCopyLink={copyLinkEvent}
            onEdit={secretUnlocked && !editBlocked ? handleEditClick : null}
            onShare={v.canShare && !pwdLocked ? () => setShowShare(true) : null}
            onFullScreen={canFullScreen ? () => v.toggleImmersive(true) : null}
            onDetails={() => setDetailsOpen(true)}
            menu={menu}
            headings={tocEntries.length ? headings : []}
            copyVariant={showPanel ? "secondary" : "primary"}
          />
        )}

        {/* Framed reading progress follows the page; the immersive one lives
            inside the layer (its own scroller, and above the page). */}
        {framed && !gated && readable && !empty && <ReadingProgress key="page" />}
        {framed && <LiveUpdatePill show={livePill} />}

        {/* Fixed slots: rails and notices come and go around the one content
            element without ever re-parenting it. */}
        <div
          className={framed
            ? "mx-auto grid w-full max-w-marketing flex-1 grid-cols-1 content-start gap-10 px-4 pb-16 pt-6 sm:px-6 sm:pt-8 xl:grid-cols-[200px_minmax(0,680px)_260px] xl:justify-between"
            : "contents"}
        >
          {framed && (
            <aside className="no-print hidden xl:block" aria-label="Contents">
              {tocEntries.length > 0 && (
                <div className="sticky top-32 max-h-[calc(100dvh-9rem)] overflow-y-auto pb-6">
                  <Toc headings={headings} encrypted={encrypted} footer={tocFooter} />
                </div>
              )}
            </aside>
          )}

          <div className={framed ? "mx-auto flex w-full min-w-0 max-w-reading flex-col gap-4 xl:mx-0" : "contents"}>
            {framed && (
              <>
                {showPanel && (
                  <PublishedPanel
                    url={url}
                    shareUrl={shareUrl}
                    access={publishedAccess}
                    encrypted={encrypted}
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
                {keySource === "device" && !rotated && readable && <div className="no-print"><DeviceKeyNotice shareUrl={shareUrl} /></div>}
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
            )}

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
                  // ph-no-capture: clicks inside a document are never autocaptured with their text.
                  className={`ph-no-capture ${vs.column} mx-auto w-full max-w-reading ${
                    showImmersive ? "px-5 pb-32 pt-12 sm:px-8 sm:pt-24 print:p-0" : ""
                  }`}
                >
                  <div className="hidden print-only">
                    {displayTitle && <h1 className="mb-4 text-h1">{displayTitle}</h1>}
                  </div>
                  {readable && displayTitle && !showRaw && !empty && !opensWithOwnTitle(displayContent, displayTitle) && (
                    <h1 dir="auto" className="no-print mb-8 break-words text-h1 text-text">
                      {displayTitle}
                    </h1>
                  )}
                  {!readable ? (
                    <EncryptionState
                      url={url}
                      state={decryptState === "nokey" || decryptState === "failed" || decryptState === "unsupported" ? decryptState : "working"}
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
                  ) : (
                    <MarkdownPreview
                      content={displayContent}
                      size="reading"
                      anchors={!encrypted}
                      encrypted={encrypted}
                      onHeadings={setHeadings}
                      onCodeCopy={encrypted ? undefined : v.onCodeCopy}
                    />
                  )}
                  {readable && !empty && <Colophon />}
                </div>
                {showImmersive && readable && !empty && <ReadingProgress key="layer" scroller={layerRef} />}
                {showImmersive && readable && !showRaw && <TocTicks headings={headings} encrypted={encrypted} />}
                {showImmersive && <LiveUpdatePill show={livePill} />}
                {showImmersive && !(viewerChrome === "none" && !user) && (
                  <ImmersiveExit onExit={() => v.toggleImmersive(false)} />
                )}
              </div>
            )}
          </div>

          {framed && !gated && (
            <aside className="no-print hidden xl:block" aria-label="Details">
              <div className="sticky top-32 pb-6">{details}</div>
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
        <Toc headings={headings} encrypted={encrypted} variant="sheet" onNavigate={() => setContentsOpen(false)} />
      </Drawer>

      <SaveCopyDialog
        open={showCopy}
        onClose={() => { if (!v.copyBusy) setShowCopy(false); }}
        busy={v.copyBusy}
        error={v.copyError}
        gConnected={gConnected}
        onCopy={v.handleCopy}
      />

      {showShare && (
        <ShareDialog
          slug={slug}
          title={shownTitle || slug}
          documentId={v.docId}
          shareUrl={shareUrl}
          onClose={() => setShowShare(false)}
          onChanged={v.loadAccess}
        />
      )}

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
    </div>
  );
}
