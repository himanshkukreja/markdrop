"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import CopyButton from "@/components/CopyButton";
import Modal from "@/components/Modal";
import Spinner from "@/components/Spinner";
import ArtifactBadge, { formatBytes } from "@/components/ArtifactBadge";
import { useAuth } from "@/contexts/AuthContext";
import {
  getToken,
  changeSlug,
  deleteDocument,
  getDocument,
  recordEvent,
  replaceArtifactFile,
  reportDocument,
  updateArtifactSettings,
  type ArtifactRenderer,
  type ExpiresIn,
} from "@/lib/api";

/**
 * Viewer for kind="artifact" documents.
 *
 * The file itself renders inside an iframe pointed at the artifact origin — a
 * different registrable site from markdrop.in. That's what stops user-authored
 * HTML from reading the session token out of localStorage. `allow-same-origin`
 * looks alarming but is correct here: it means same-origin with the *artifact*
 * host, not with us, so the viewers can fetch their own bytes while remaining
 * unable to touch anything of ours.
 */
const SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads";

interface Props {
  slug: string;
  title: string | null;
  url: string;
  createdAt: string;
  views?: number;
  isPasswordProtected?: boolean;
  mime: string;
  renderer: ArtifactRenderer;
  typeLabel: string;
  sizeBytes: number;
  originalFilename: string | null;
  artifactUrl: string | null;
  downloadUrl: string | null;
}





export default function ArtifactView({
  slug,
  title: initialTitle,
  url,
  createdAt,
  views: initialViews,
  isPasswordProtected = false,
  renderer: initialRenderer,
  typeLabel: initialTypeLabel,
  sizeBytes: initialSize,
  originalFilename,
  artifactUrl: initialArtifactUrl,
  downloadUrl: initialDownloadUrl,
}: Props) {
  const router = useRouter();
  const { user } = useAuth();
  // Client-side so the document route stays edge-cacheable (see page.tsx).
  const params = useSearchParams();
  const isNew = params.get("new") === "1";
  const wantsFull = params.get("full") === "1";

  const [title, setTitle] = useState(initialTitle);
  const [artifactUrl, setArtifactUrl] = useState(initialArtifactUrl);
  const [downloadUrl, setDownloadUrl] = useState(initialDownloadUrl);
  const [renderer, setRenderer] = useState(initialRenderer);
  const [typeLabel, setTypeLabel] = useState(initialTypeLabel);
  const [sizeBytes, setSizeBytes] = useState(initialSize);
  const [views, setViews] = useState(initialViews);
  const [isOwner, setIsOwner] = useState(false);
  const [ownerChecked, setOwnerChecked] = useState(false);
  // Immersive mode: the artifact fills the viewport with all app chrome hidden,
  // so a published page reads as the content itself rather than something in a
  // box. Escape exits, and body scroll is locked while it's open.
  const [immersive, setImmersive] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Owner settings panel
  const [showEdit, setShowEdit] = useState(false);
  const [eTitle, setETitle] = useState("");
  const [eSlug, setESlug] = useState("");
  const [ePassword, setEPassword] = useState("");
  const [eRemovePwd, setERemovePwd] = useState(false);
  const [eExpiry, setEExpiry] = useState<ExpiresIn | "">("");
  const [eFile, setEFile] = useState<File | null>(null);
  const [eProgress, setEProgress] = useState(0);
  const [eBusy, setEBusy] = useState(false);
  const [eError, setEError] = useState("");
  const [protectedNow, setProtectedNow] = useState(isPasswordProtected);
  const replaceInput = useRef<HTMLInputElement>(null);

  function openEdit() {
    setETitle(title || "");
    setESlug(slug);
    setEPassword("");
    setERemovePwd(false);
    setEExpiry("");
    setEFile(null);
    setEProgress(0);
    setEError("");
    setShowEdit(true);
  }

  async function saveEdit() {
    setEBusy(true);
    setEError("");
    try {
      // File first: if it fails there's no point renaming anything.
      if (eFile) {
        const doc = await replaceArtifactFile(slug, eFile, setEProgress);
        applyDoc(doc);
      }
      const changedSettings =
        eTitle !== (title || "") || !!ePassword || eRemovePwd || !!eExpiry;
      if (changedSettings) {
        const doc = await updateArtifactSettings(slug, {
          title: eTitle,
          readPassword: ePassword || undefined,
          removePassword: eRemovePwd,
          expiresIn: eExpiry || undefined,
        });
        applyDoc(doc);
        setProtectedNow(!!doc.is_password_protected);
      }
      // Slug last — it changes the URL, so everything else must already be saved.
      if (eSlug && eSlug !== slug) {
        await changeSlug(slug, eSlug);
        router.replace(`/${eSlug}`);
        return;
      }
      setShowEdit(false);
    } catch (err) {
      setEError(err instanceof Error ? err.message : "Could not save changes");
    } finally {
      setEBusy(false);
      setEProgress(0);
    }
  }


  // Password gate
  const [locked, setLocked] = useState(isPasswordProtected && !initialArtifactUrl);
  const [pwdInput, setPwdInput] = useState("");
  const [pwdError, setPwdError] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  // Owner + abuse actions
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportDone, setReportDone] = useState(false);

  const beaconSent = useRef(false);

  function applyDoc(doc: Awaited<ReturnType<typeof getDocument>>) {
    setTitle(doc.title);
    setArtifactUrl(doc.artifact_url ?? null);
    setDownloadUrl(doc.download_url ?? null);
    if (doc.renderer) setRenderer(doc.renderer);
    if (doc.type_label) setTypeLabel(doc.type_label);
    if (doc.size_bytes) setSizeBytes(doc.size_bytes);
    setViews(doc.views);
    setLocked(false);
  }

  // Count the view from the browser so the real visitor IP drives geo, matching
  // how markdown documents are counted.
  useEffect(() => {
    if (beaconSent.current || locked) return;
    beaconSent.current = true;
    recordEvent(slug, "view");
  }, [slug, locked]);

  // Cached password from a previous unlock in this tab.
  useEffect(() => {
    if (!isPasswordProtected || !locked) return;
    const cached = sessionStorage.getItem(`pwd:${slug}`);
    if (!cached) return;
    getDocument(slug, cached)
      .then(applyDoc)
      .catch(() => sessionStorage.removeItem(`pwd:${slug}`));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Owner detection — reveals delete, and refreshes the signed URL for a
  // protected artifact the owner is allowed to see without the password.
  useEffect(() => {
    if (!user) {
      setIsOwner(false);
      setOwnerChecked(true);
      return;
    }
    let cancelled = false;
    getDocument(slug)
      .then((doc) => {
        if (cancelled) return;
        setIsOwner(!!doc.is_owner);
        if (doc.is_owner && doc.artifact_url) applyDoc(doc);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setOwnerChecked(true); });
    return () => {
      cancelled = true;
    };
  }, [user, slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // Visitors get the artifact full-bleed by default — they came for the content,
  // not for Markdrop's chrome. Owners never do: their controls live in the
  // framed view and hiding them behind Esc every visit would be hostile.
  //
  // Ownership isn't known at SSR (the server render is always anonymous), so a
  // signed-out viewer — the common case — is decided synchronously from the
  // absence of a token, with no flash. A signed-in viewer waits the one fetch
  // it takes to learn whether they own it.
  const autoImmersed = useRef(false);
  useEffect(() => {
    if (autoImmersed.current || !artifactUrl || locked) return;
    if (wantsFull) {
      autoImmersed.current = true;
      setImmersive(true);
      return;
    }
    if (!getToken()) {
      autoImmersed.current = true;
      setImmersive(true);
      return;
    }
    if (ownerChecked) {
      autoImmersed.current = true;
      if (!isOwner) setImmersive(true);
    }
  }, [wantsFull, artifactUrl, locked, ownerChecked, isOwner]);

  useEffect(() => {
    if (!immersive) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setImmersive(false);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [immersive]);

  async function handleUnlock(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!pwdInput.trim()) return;
    setUnlocking(true);
    setPwdError("");
    try {
      const doc = await getDocument(slug, pwdInput);
      sessionStorage.setItem(`pwd:${slug}`, pwdInput);
      applyDoc(doc);
    } catch (err) {
      setPwdError(
        err instanceof Error && err.message === "WRONG_PASSWORD"
          ? "Incorrect password"
          : "Something went wrong. Try again."
      );
    } finally {
      setUnlocking(false);
    }
  }

  async function handleDownload() {
    // download_url, not artifact_url: the latter is a viewer *page* for PDFs,
    // sheets and docs, so downloading it would save the HTML wrapper.
    const src = downloadUrl || artifactUrl;
    if (!src) return;
    setDownloading(true);
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = originalFilename || slug;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Last resort: open it rather than silently doing nothing.
      window.open(src, "_blank", "noopener");
    } finally {
      setDownloading(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteDocument(slug);
      router.push("/dashboard");
    } catch {
      setDeleting(false);
      setShowDelete(false);
    }
  }

  async function submitReport() {
    setReportBusy(true);
    try {
      await reportDocument(slug, reportReason.trim() || undefined);
      setReportDone(true);
    } catch {
      /* ignore */
    } finally {
      setReportBusy(false);
    }
  }

  const btn =
    "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] transition-colors text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]";

  return (
    <div className="w-full space-y-3">
      {isNew && (
        <div className="px-3 py-2 rounded-lg border border-emerald-300 dark:border-emerald-700/50 bg-emerald-50 dark:bg-emerald-950/30 text-xs text-emerald-700 dark:text-emerald-400">
          Published. Anyone with this link can view it.
        </div>
      )}

      {/* Header */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4]">
          {title || originalFilename || slug}
        </h1>
        <ArtifactBadge renderer={renderer} label={typeLabel} />
        <span className="text-xs text-gray-400 dark:text-gray-500">
          {typeLabel} · {formatBytes(sizeBytes)}
          {typeof views === "number" && ` · ${views} view${views === 1 ? "" : "s"}`}
          {` · ${new Date(createdAt).toLocaleDateString()}`}
        </span>
      </div>

      {/* Actions */}
      <div className="no-print flex flex-wrap items-center gap-2">
        <CopyButton text={url} label="Copy link" />
        {artifactUrl && (
          <>
            <button onClick={() => setImmersive(true)} className={btn}>
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
              Full screen
            </button>
            {/* Fetched as a blob rather than linked. The download attribute is
                ignored cross-origin, so an <a href> here would navigate to the
                artifact origin — and a top-level visit there trips Chrome's
                lookalike-domain interstitial. */}
            <button onClick={handleDownload} disabled={downloading} className={btn}>
              {downloading ? "Preparing…" : "Download"}
            </button>
          </>
        )}
        {isOwner && (
          <button onClick={openEdit} className={btn}>
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" />
            </svg>
            Settings
          </button>
        )}
        {isOwner && (
          <button
            onClick={() => setShowDelete(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-red-300 dark:border-red-800 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 transition-colors"
          >
            Delete
          </button>
        )}
        {!isOwner && !locked && (
          <button
            onClick={() => {
              setReportReason("");
              setReportDone(false);
              setShowReport(true);
            }}
            className="ml-auto px-2 py-1.5 text-xs text-gray-400 hover:text-red-500 transition-colors"
          >
            ⚑ Report
          </button>
        )}
      </div>

      {/* Content */}
      {locked ? (
        <div className="border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] rounded-lg p-10 flex flex-col items-center gap-3 bg-[#252526] dark:bg-gray-900/50">
          <svg className="w-8 h-8 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z"
              clipRule="evenodd"
            />
          </svg>
          <p className="text-sm text-gray-400">This artifact is password protected</p>
          <form onSubmit={handleUnlock} className="flex flex-col items-center gap-2 w-full max-w-xs">
            <div className="flex w-full gap-2">
              <input
                type="password"
                value={pwdInput}
                onChange={(e) => setPwdInput(e.target.value)}
                placeholder="Enter password"
                autoFocus
                className="flex-1 text-sm bg-[#2d2d2d] dark:bg-gray-900 border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] rounded-lg px-3 py-1.5 outline-none focus:border-blue-500 text-gray-200"
              />
              <button
                type="submit"
                disabled={unlocking || !pwdInput.trim()}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors"
              >
                {unlocking ? "…" : "Unlock"}
              </button>
            </div>
            {pwdError && <p className="text-xs text-red-500 self-start">{pwdError}</p>}
          </form>
        </div>
      ) : artifactUrl ? (
        <div className="border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] rounded-lg overflow-hidden bg-white dark:bg-[#0b1220]">
          <iframe
            src={artifactUrl}
            sandbox={SANDBOX}
            // No referrer: the artifact origin never needs to know which
            // markdrop.in page framed it.
            referrerPolicy="no-referrer"
            title={title || slug}
            className="w-full border-0 bg-white"
            style={{ height: "min(78vh, 900px)" }}
          />
        </div>
      ) : (
        <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-10 text-center text-sm text-gray-400">
          <Spinner className="w-5 h-5 mx-auto mb-2" />
          Preparing this artifact…
        </div>
      )}

      {immersive && artifactUrl && (
        <div className="fixed inset-0 z-[100] bg-white dark:bg-[#0b1220]">
          <iframe
            src={artifactUrl}
            sandbox={SANDBOX}
            referrerPolicy="no-referrer"
            title={title || slug}
            className="w-full h-full border-0 bg-white"
          />
          {/* One control, bottom-right. Top-right is where PDF.js, SheetJS and
              plenty of user pages put their own toolbars, so anchoring here
              keeps it clear of the rendered content. Fades back until hovered. */}
          <button
            onClick={() => setImmersive(false)}
            aria-label="Show document details"
            className="fixed bottom-4 right-4 z-[101] inline-flex items-center gap-2 rounded-full bg-black/60 hover:bg-black/85 backdrop-blur px-3.5 py-2 text-xs font-medium text-white/85 hover:text-white shadow-lg opacity-45 hover:opacity-100 focus:opacity-100 transition-all"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M9 21H5a2 2 0 0 1-2-2v-4M15 21h4a2 2 0 0 0 2-2v-4" />
            </svg>
            Show details
            <kbd className="hidden sm:inline rounded border border-white/25 px-1 text-[10px] leading-4">Esc</kbd>
          </button>
        </div>
      )}

      {showEdit && (
        <Modal title="Artifact settings" onClose={() => !eBusy && setShowEdit(false)}>
          <div className="space-y-4">
            {/* Replace the file — same link, new content */}
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">
                File
              </label>
              <input
                ref={replaceInput}
                type="file"
                hidden
                onChange={(e) => setEFile(e.target.files?.[0] ?? null)}
              />
              <button
                onClick={() => replaceInput.current?.click()}
                disabled={eBusy}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left rounded-lg border border-dashed border-gray-300 dark:border-gray-700 hover:border-blue-400 disabled:opacity-50 transition-colors"
              >
                <ArtifactBadge renderer={renderer} label={typeLabel} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-gray-900 dark:text-gray-100 truncate">
                    {eFile ? eFile.name : originalFilename || "Current file"}
                  </span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                    {eFile
                      ? `${formatBytes(eFile.size)} · will replace the current file`
                      : `${formatBytes(sizeBytes)} · click to replace, the link stays the same`}
                  </span>
                </span>
              </button>
              {eBusy && eProgress > 0 && eProgress < 100 && (
                <div className="mt-2 h-1 w-full bg-gray-200 dark:bg-gray-800 rounded overflow-hidden">
                  <div className="h-full bg-blue-500 transition-all" style={{ width: `${eProgress}%` }} />
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">Title</label>
              <input
                type="text"
                value={eTitle}
                onChange={(e) => setETitle(e.target.value)}
                maxLength={200}
                placeholder="Untitled"
                className="w-full text-sm bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">Link</label>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-400 shrink-0">markdrop.in/</span>
                <input
                  type="text"
                  value={eSlug}
                  onChange={(e) => /^[a-zA-Z0-9_-]*$/.test(e.target.value) && setESlug(e.target.value)}
                  maxLength={50}
                  className="flex-1 min-w-0 text-sm font-mono bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 outline-none focus:border-blue-500 transition-colors"
                />
              </div>
              {eSlug !== slug && (
                <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                  The old link will stop working. Views and analytics carry over.
                </p>
              )}
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">
                  Password
                </label>
                {protectedNow && !ePassword ? (
                  <label className="flex items-center gap-2 h-[38px] px-3 rounded-lg border border-gray-200 dark:border-gray-700 cursor-pointer select-none">
                    <input type="checkbox" checked={eRemovePwd} onChange={(e) => setERemovePwd(e.target.checked)} className="accent-red-500" />
                    <span className="text-xs text-gray-600 dark:text-gray-300">Remove password</span>
                  </label>
                ) : (
                  <input
                    type="password"
                    value={ePassword}
                    onChange={(e) => setEPassword(e.target.value)}
                    maxLength={100}
                    placeholder={protectedNow ? "New password" : "Add a password"}
                    className="w-full text-sm bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 outline-none focus:border-blue-500 transition-colors"
                  />
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">Expiry</label>
                <select
                  value={eExpiry}
                  onChange={(e) => setEExpiry(e.target.value as ExpiresIn | "")}
                  className="w-full text-sm bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 outline-none focus:border-blue-500 cursor-pointer transition-colors"
                >
                  <option value="">Leave unchanged</option>
                  <option value="never">Never expires</option>
                  <option value="1d">1 day</option>
                  <option value="7d">7 days</option>
                  <option value="30d">30 days</option>
                </select>
              </div>
            </div>

            {eError && <p className="text-xs text-red-500">{eError}</p>}

            <div className="flex items-center justify-between gap-2 pt-1">
              <button
                onClick={() => { setShowEdit(false); setShowDelete(true); }}
                disabled={eBusy}
                className="text-xs text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
              >
                Delete artifact
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowEdit(false)}
                  disabled={eBusy}
                  className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={saveEdit}
                  disabled={eBusy}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition-colors"
                >
                  {eBusy && <Spinner className="w-4 h-4" />}
                  {eBusy ? (eProgress > 0 && eProgress < 100 ? `Uploading ${eProgress}%` : "Saving…") : "Save changes"}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {showDelete && (
        <Modal title="Delete this artifact?" onClose={() => !deleting && setShowDelete(false)}>
          <div className="space-y-4">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              The file and its link are removed permanently, and the storage is freed from your
              quota. This can&apos;t be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowDelete(false)}
                disabled={deleting}
                className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-4 py-2 text-sm rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-medium transition-colors"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showReport && (
        <Modal
          title={reportDone ? "Report submitted" : "Report this artifact"}
          onClose={() => setShowReport(false)}
        >
          {reportDone ? (
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
                Thanks — our team will review this artifact.
              </p>
              <div className="flex justify-end">
                <button
                  onClick={() => setShowReport(false)}
                  className="px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Report phishing, malware or abusive content. Optionally tell us why:
              </p>
              <textarea
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder="Reason (optional)"
                className="w-full bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 resize-none"
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowReport(false)}
                  className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                >
                  Cancel
                </button>
                <button
                  onClick={submitReport}
                  disabled={reportBusy}
                  className="px-4 py-2 text-sm rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-medium transition-colors"
                >
                  {reportBusy ? "Submitting…" : "Submit report"}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
