"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import CopyButton from "@/components/CopyButton";
import Modal from "@/components/Modal";
import Spinner from "@/components/Spinner";
import ArtifactBadge, { formatBytes } from "@/components/ArtifactBadge";
import { useAuth } from "@/contexts/AuthContext";
import {
  deleteDocument,
  getDocument,
  recordEvent,
  reportDocument,
  type ArtifactRenderer,
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
}: Props) {
  const router = useRouter();
  const { user } = useAuth();
  // Client-side so the document route stays edge-cacheable (see page.tsx).
  const params = useSearchParams();
  const isNew = params.get("new") === "1";
  const wantsFull = params.get("full") === "1";

  const [title, setTitle] = useState(initialTitle);
  const [artifactUrl, setArtifactUrl] = useState(initialArtifactUrl);
  const [renderer, setRenderer] = useState(initialRenderer);
  const [typeLabel, setTypeLabel] = useState(initialTypeLabel);
  const [sizeBytes, setSizeBytes] = useState(initialSize);
  const [views, setViews] = useState(initialViews);
  const [isOwner, setIsOwner] = useState(false);
  // Immersive mode: the artifact fills the viewport with all app chrome hidden,
  // so a published page reads as the content itself rather than something in a
  // box. Escape exits, and body scroll is locked while it's open.
  const [immersive, setImmersive] = useState(false);
  const [downloading, setDownloading] = useState(false);

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
      return;
    }
    let cancelled = false;
    getDocument(slug)
      .then((doc) => {
        if (cancelled || !doc.is_owner) return;
        setIsOwner(true);
        if (doc.artifact_url) applyDoc(doc);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user, slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // ?full=1 lands directly in immersive mode — lets an owner share a link that
  // opens as the page itself, with no Markdrop chrome around it.
  useEffect(() => {
    if (wantsFull && artifactUrl && !locked) setImmersive(true);
  }, [wantsFull, artifactUrl, locked]);

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
    if (!artifactUrl) return;
    setDownloading(true);
    try {
      const res = await fetch(artifactUrl);
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
      window.open(artifactUrl, "_blank", "noopener");
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
          {/* Floating exit — the only chrome, and it fades back until hovered
              so it never competes with the content it sits on. */}
          <button
            onClick={() => setImmersive(false)}
            aria-label="Exit full screen"
            className="group fixed top-3 right-3 z-[101] inline-flex items-center gap-1.5 rounded-full bg-black/55 hover:bg-black/80 backdrop-blur px-3 py-1.5 text-xs font-medium text-white/80 hover:text-white opacity-40 hover:opacity-100 transition-all"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
            Exit
            <kbd className="hidden sm:inline ml-0.5 rounded border border-white/25 px-1 text-[10px] leading-4">Esc</kbd>
          </button>
        </div>
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
