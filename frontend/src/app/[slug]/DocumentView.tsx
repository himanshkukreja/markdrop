"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import MarkdownPreview from "@/components/MarkdownPreview";
import CopyButton from "@/components/CopyButton";
import MarkdownToolbar from "@/components/MarkdownToolbar";
import { updateDocument, deleteDocument, getDocument, claimDocument, recordEvent, reportDocument, getGoogleDocsStatus, connectGoogleDocs, exportToGoogleDocs, copyDocument, API_BASE } from "@/lib/api";
import { MAX_CHARS } from "@/lib/limits";
import { useAuth } from "@/contexts/AuthContext";
import Modal from "@/components/Modal";
import Spinner from "@/components/Spinner";
import AuthModal from "@/components/AuthModal";

type ViewMode = "write" | "split" | "preview";

function GoogleDocIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" fill="#4285F4" />
      <path d="M14 2v6h6z" fill="#A1C2FA" />
      <path d="M8 12h8M8 15h8M8 18h5" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** Two overlapping pages — "duplicate / save a copy". */
function CopyDocIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/** Circular refresh arrow; spins while a sync is in flight. */
function ReloadIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      className={`w-3.5 h-3.5${spinning ? " animate-spin" : ""}`}
      viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

interface Props {
  slug: string;
  title: string | null;
  content: string;
  url: string;
  createdAt: string;
  expiresAt: string | null;
  views?: number;
  isNew?: boolean;
  editSecret?: string;
  isPasswordProtected?: boolean;
  isOwned?: boolean;
  startInEdit?: boolean;
  startCopy?: boolean;
  startGoogleSync?: boolean;
}

function ExpiryBadge({ expiresAt }: { expiresAt: string }) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return null;
  const hours = Math.ceil(ms / 3_600_000);
  const days = Math.ceil(ms / 86_400_000);
  const label =
    hours <= 24
      ? hours === 1
        ? "Expires in 1 hour"
        : `Expires in ${hours} hours`
      : days === 1
      ? "Expires in 1 day"
      : `Expires in ${days} days`;
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
      {label}
    </span>
  );
}

export default function DocumentView({
  slug,
  title: initialTitle,
  content: initialContent,
  url,
  createdAt: initialCreatedAt,
  expiresAt: initialExpiresAt,
  views: initialViews,
  isNew,
  editSecret: initialSecret,
  isPasswordProtected = false,
  isOwned = false,
  startInEdit = false,
  startCopy = false,
  startGoogleSync = false,
}: Props) {
  const router = useRouter();
  const { user } = useAuth();

  // Claim-to-account state
  const [claimSecret, setClaimSecret] = useState<string | null>(initialSecret || null);
  const [claimed, setClaimed] = useState(false);
  const [claimMsg, setClaimMsg] = useState("");
  const viewBeaconSent = useRef(false);
  const editOpened = useRef(false);

  // Google Docs sync state — populated once we confirm the viewer owns this doc
  const [isOwner, setIsOwner] = useState(false);
  const [docId, setDocId] = useState<string | null>(null);
  const [gConnected, setGConnected] = useState(false);
  const [googleDocUrl, setGoogleDocUrl] = useState<string | null>(null);
  const [googleDocStale, setGoogleDocStale] = useState(false);
  const [gBusy, setGBusy] = useState(false);
  const [gError, setGError] = useState<string | null>(null);
  const [gNeedsReconnect, setGNeedsReconnect] = useState(false);

  // "Save a copy" (import someone else's doc into your account) state
  const [showCopy, setShowCopy] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [copyBusy, setCopyBusy] = useState<null | "plain" | "google">(null);
  const [copyError, setCopyError] = useState("");

  // Abuse report state
  const [showReport, setShowReport] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportDone, setReportDone] = useState(false);

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

  // Source the edit secret from sessionStorage (set by the publish flow) rather
  // than the URL — so it never leaks via history/referrer/server logs. Seeds the
  // editor unlock and, for password-protected docs, bypasses the read-password gate.
  useEffect(() => {
    if (claimSecret || typeof window === "undefined") return;
    const stored = sessionStorage.getItem(`secret:${slug}`);
    if (!stored) return;
    setClaimSecret(stored);
    setSecretInput(stored);
    setSecretUnlocked(true);
    if (isPasswordProtected) {
      getDocument(slug, undefined, stored)
        .then((doc) => {
          setDisplayTitle(doc.title);
          setDisplayContent(doc.content);
          setDisplayCreatedAt(doc.created_at);
          setDisplayExpiresAt(doc.expires_at);
          setDisplayViews(doc.views);
          setPwdLocked(false);
        })
        .catch(() => {})
        .finally(() => setPwdFetching(false));
    }
  }, [slug, claimSecret, isPasswordProtected]);

  async function handleClaim() {
    if (!claimSecret) return;
    setClaimMsg("");
    try {
      await claimDocument(slug, claimSecret);
      setClaimed(true);
      setClaimMsg("Saved to your account.");
    } catch (e) {
      setClaimMsg(e instanceof Error ? e.message : "Could not claim");
    }
  }

  async function handleGoogleExport() {
    if (!docId) return;
    setGBusy(true);
    setGError(null);
    setGNeedsReconnect(false);
    try {
      const result = await exportToGoogleDocs(docId);
      setGoogleDocUrl(result.google_doc_url);
      setGoogleDocStale(false);
    } catch (err) {
      if (err instanceof Error && err.name === "ReconnectRequired") {
        setGNeedsReconnect(true);
        setGError(err.message);
      } else {
        setGError(err instanceof Error ? err.message : "Export to Google Docs failed");
      }
    } finally {
      setGBusy(false);
    }
  }

  function requestCopy() {
    if (!user) {
      // Not signed in: open the sign-in modal right here (no page nav). Email
      // sign-in resumes the copy in-place; Google redirects and resumes on
      // return via ?copy=1.
      setShowAuth(true);
      return;
    }
    setCopyError("");
    setShowCopy(true);
  }

  async function handleCopy(withGoogle: boolean) {
    setCopyBusy(withGoogle ? "google" : "plain");
    setCopyError("");
    try {
      // Pass the unlocked password so the server can read a protected source;
      // the copy itself is always created without a password.
      const cachedPwd = isPasswordProtected
        ? sessionStorage.getItem(`pwd:${slug}`) || undefined
        : undefined;
      const copy = await copyDocument(slug, cachedPwd);

      if (withGoogle && !gConnected) {
        // Not connected yet: start the opt-in Google connect flow, returning to
        // the new (owned) copy with ?gsync=1 so the export fires automatically
        // once connected (no manual "Sync" click needed).
        await connectGoogleDocs(`/${copy.slug}?gsync=1`);
        return;
      }
      if (withGoogle && copy.id) {
        // Best-effort sync; if it fails (e.g. reconnect needed) the copy still
        // exists, so send them to it — the doc page surfaces the sync/reconnect UI.
        try {
          await exportToGoogleDocs(copy.id);
        } catch {
          /* fall through to the redirect below */
        }
      }
      router.push(`/${copy.slug}`);
    } catch (e) {
      setCopyError(e instanceof Error ? e.message : "Could not save a copy");
      setCopyBusy(null);
    }
  }

  async function handleGoogleReconnect() {
    try {
      await connectGoogleDocs(`/${slug}`);
    } catch (err) {
      setGError(err instanceof Error ? err.message : "Could not start Google reconnect");
    }
  }

  // Live display state
  const [displayTitle, setDisplayTitle] = useState(initialTitle);
  const [displayContent, setDisplayContent] = useState(initialContent);
  const [displayCreatedAt, setDisplayCreatedAt] = useState(initialCreatedAt);
  const [displayExpiresAt, setDisplayExpiresAt] = useState(initialExpiresAt);
  const [displayViews, setDisplayViews] = useState(initialViews);

  // View state
  const [showRaw, setShowRaw] = useState(false);

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [secretInput, setSecretInput] = useState(initialSecret || "");
  const [secretUnlocked, setSecretUnlocked] = useState(!!initialSecret);
  const [secretError, setSecretError] = useState("");

  // Editor state
  const [editTitle, setEditTitle] = useState(initialTitle || "");
  const [editContent, setEditContent] = useState(initialContent);
  const [viewMode, setViewMode] = useState<ViewMode>("write");
  // Edit options: password + expiry
  const [editRemovePassword, setEditRemovePassword] = useState(false);
  const [editNewPassword, setEditNewPassword] = useState("");
  const [editShowPassword, setEditShowPassword] = useState(false);
  const [editExpiresIn, setEditExpiresIn] = useState<import("@/lib/api").ExpiresIn | "">("");
  const [editCustomExpiresAt, setEditCustomExpiresAt] = useState("");

  // Save / delete state
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Password gate state — skip gate immediately if owner has edit secret
  const [pwdLocked, setPwdLocked] = useState(isPasswordProtected && !initialSecret);
  const [pwdFetching, setPwdFetching] = useState(isPasswordProtected && !!initialSecret);
  const [pwdInput, setPwdInput] = useState("");
  const [pwdError, setPwdError] = useState("");
  const [pwdUnlocking, setPwdUnlocking] = useState(false);
  const [pwdVisible, setPwdVisible] = useState(false);

  // Scroll sync refs for split view
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const writeTextareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // Fire a single view beacon from the browser so the real visitor IP (not
  // Vercel's SSR server) drives the view count + geography.
  useEffect(() => {
    if (viewBeaconSent.current) return;
    if (isPasswordProtected && pwdLocked) return; // wait until unlocked
    viewBeaconSent.current = true;
    recordEvent(slug, "view");
  }, [pwdLocked, isPasswordProtected, slug]);

  // If logged in, detect ownership so the owner can edit without the secret
  // (and view their own password-protected doc without the read password). We
  // also capture the doc id + Google Docs link here to drive the sync button.
  useEffect(() => {
    if (!user) {
      // Signed out (or never signed in): drop any owner-only state so the
      // Google Docs actions disappear immediately, without a page reload.
      setIsOwner(false);
      setDocId(null);
      setGoogleDocUrl(null);
      setGoogleDocStale(false);
      return;
    }
    let cancelled = false;
    getDocument(slug)
      .then((doc) => {
        if (cancelled || !doc.is_owner) return;
        setIsOwner(true);
        setDocId(doc.id ?? null);
        setGoogleDocUrl(doc.google_doc_url ?? null);
        setGoogleDocStale(!!doc.google_doc_stale);
        // Only unlock/refresh display state on first detection — don't clobber
        // edits the user may have unlocked via secret.
        if (!secretUnlocked) {
          setSecretUnlocked(true);
          setPwdLocked(false);
          setDisplayTitle(doc.title);
          setDisplayContent(doc.content);
          setDisplayCreatedAt(doc.created_at);
          setDisplayExpiresAt(doc.expires_at);
          setDisplayViews(doc.views);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user, slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // Whether the account has Google Docs connected (gates the sync button).
  useEffect(() => {
    if (!user) { setGConnected(false); return; }
    let cancelled = false;
    getGoogleDocsStatus()
      .then((s) => { if (!cancelled) setGConnected(!!(s.configured && s.connected)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user]);

  // Live updates: refresh the page when the document changes elsewhere (a VS
  // Code sync push or an in-app edit). A lightweight WebSocket receives a
  // "changed" ping, then we refetch through the normal authorized read path.
  // Additive + best-effort: if the socket never connects, the page behaves
  // exactly as before (manual reload). An in-progress edit is never clobbered.
  const editingRef = useRef(editing);
  useEffect(() => { editingRef.current = editing; }, [editing]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isPasswordProtected && pwdLocked) return; // wait until unlocked
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    function connect() {
      try {
        ws = new WebSocket(`${API_BASE.replace(/^http/, "ws")}/ws/docs/${slug}`);
      } catch {
        return;
      }
      ws.onmessage = (ev) => {
        let msg: { type?: string } | null = null;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg?.type !== "changed" || editingRef.current) return;
        const cachedPwd = isPasswordProtected
          ? sessionStorage.getItem(`pwd:${slug}`) || undefined
          : undefined;
        getDocument(slug, cachedPwd, claimSecret || undefined)
          .then((doc) => {
            setDisplayTitle(doc.title);
            setDisplayContent(doc.content);
            setDisplayExpiresAt(doc.expires_at);
            setDisplayViews(doc.views);
            if (doc.is_owner) setGoogleDocStale(!!doc.google_doc_stale);
          })
          .catch(() => {});
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 3000); // reconnect while open
      };
    }
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [slug, isPasswordProtected, pwdLocked, claimSecret]); // eslint-disable-line react-hooks/exhaustive-deps

  // Open the editor directly when arriving via ?edit=1 (owner/secret ready).
  useEffect(() => {
    if (startInEdit && secretUnlocked && !editOpened.current && !pwdLocked) {
      editOpened.current = true;
      handleEditClick();
    }
  }, [startInEdit, secretUnlocked, pwdLocked]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resume "Save a copy" after a sign-in redirect (?copy=1), once we know the
  // viewer isn't the owner and the content is unlocked. Opens the modal once.
  const copyAutoOpened = useRef(false);
  useEffect(() => {
    if (startCopy && user && !isOwner && !pwdLocked && !copyAutoOpened.current) {
      copyAutoOpened.current = true;
      setShowCopy(true);
    }
  }, [startCopy, user, isOwner, pwdLocked]);

  // Resume Google export after the connect redirect (?gsync=1): once we know
  // the viewer owns this (new) doc and Google is connected, and it isn't linked
  // yet, push it to Google Docs automatically — no manual "Sync" click needed.
  const gSyncAuto = useRef(false);
  useEffect(() => {
    if (startGoogleSync && isOwner && gConnected && docId && !googleDocUrl && !gBusy && !gSyncAuto.current) {
      gSyncAuto.current = true;
      handleGoogleExport();
    }
  }, [startGoogleSync, isOwner, gConnected, docId, googleDocUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Set document.title to just the clean name before printing so the
  // save-as filename in the print dialog is "{title}" or "{slug}" rather
  // than the full "{title} — Markdrop" page title.
  useEffect(() => {
    const cleanName = displayTitle || slug;
    const savedTitle = document.title;
    function beforePrint() { document.title = cleanName; }
    function afterPrint()  { document.title = savedTitle; }
    window.addEventListener("beforeprint", beforePrint);
    window.addEventListener("afterprint",  afterPrint);
    return () => {
      window.removeEventListener("beforeprint", beforePrint);
      window.removeEventListener("afterprint",  afterPrint);
    };
  }, [displayTitle, slug]);

  // On mount: auto-unlock if owner (has edit secret) or cached password
  useEffect(() => {
    if (!isPasswordProtected) return;
    // Owner bypass: edit secret skips the read password gate
    if (initialSecret) {
      getDocument(slug, undefined, initialSecret)
        .then((doc) => {
          setDisplayTitle(doc.title);
          setDisplayContent(doc.content);
          setDisplayCreatedAt(doc.created_at);
          setDisplayExpiresAt(doc.expires_at);
          setDisplayViews(doc.views);
        })
        .catch(() => {
          // Secret invalid — fall back to showing the password gate
          setPwdLocked(true);
        })
        .finally(() => {
          setPwdFetching(false);
        });
      return;
    }
    // Returning visitor: try sessionStorage cached password
    const cached = sessionStorage.getItem(`pwd:${slug}`);
    if (cached) {
      getDocument(slug, cached)
        .then((doc) => {
          setDisplayTitle(doc.title);
          setDisplayContent(doc.content);
          setDisplayCreatedAt(doc.created_at);
          setDisplayExpiresAt(doc.expires_at);
          setDisplayViews(doc.views);
          setPwdLocked(false);
        })
        .catch(() => {
          sessionStorage.removeItem(`pwd:${slug}`);
        });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handlePasswordUnlock(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!pwdInput.trim()) return;
    setPwdUnlocking(true);
    setPwdError("");
    try {
      const doc = await getDocument(slug, pwdInput);
      sessionStorage.setItem(`pwd:${slug}`, pwdInput);
      setDisplayTitle(doc.title);
      setDisplayContent(doc.content);
      setDisplayCreatedAt(doc.created_at);
      setDisplayExpiresAt(doc.expires_at);
      setDisplayViews(doc.views);
      setPwdLocked(false);
    } catch (e) {
      if (e instanceof Error && e.message === "WRONG_PASSWORD") {
        setPwdError("Incorrect password");
      } else {
        setPwdError("Something went wrong. Try again.");
      }
    } finally {
      setPwdUnlocking(false);
    }
  }

  function syncScroll() {
    const ta = textareaRef.current;
    const pv = previewRef.current;
    if (!ta || !pv) return;
    const ratio = ta.scrollTop / Math.max(1, ta.scrollHeight - ta.clientHeight);
    pv.scrollTop = ratio * (pv.scrollHeight - pv.clientHeight);
  }

  function handleEditClick() {
    setEditTitle(displayTitle || "");
    setEditContent(displayContent);
    setViewMode("write");
    setSaveError("");
    setSecretError("");
    setEditRemovePassword(false);
    setEditNewPassword("");
    setEditShowPassword(false);
    setEditExpiresIn("");
    setEditCustomExpiresAt("");
    setEditing(true);
  }

  function handleCancelEdit() {
    setEditing(false);
    setShowDeleteConfirm(false);
    setSaveError("");
    setSecretError("");
    if (!initialSecret) {
      setSecretUnlocked(false);
      setSecretInput("");
    }
  }

  function handleUnlock(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!secretInput.trim()) {
      setSecretError("Enter your edit secret.");
      return;
    }
    setSecretError("");
    setSecretUnlocked(true);
    handleEditClick();
  }

  async function handleSave() {
    if (!editContent.trim()) return;
    setSaving(true);
    setSaveError("");
    try {
      const doc = await updateDocument(slug, editTitle, editContent, secretInput, {
        readPassword: editNewPassword || undefined,
        removePassword: editRemovePassword,
        expiresIn: editExpiresIn || undefined,
        customExpiresAt: editExpiresIn === "custom" ? editCustomExpiresAt : undefined,
      });
      setDisplayTitle(editTitle || null);
      setDisplayContent(editContent);
      setDisplayExpiresAt(doc.expires_at);
      setEditing(false);
      // The edit bumped the document's rev, so any linked Google Doc is now
      // behind — flip the sync affordance to "Sync changes" without a reload.
      if (googleDocUrl) setGoogleDocStale(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setSaveError("");
    try {
      await deleteDocument(slug, secretInput);
      router.push("/new");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to delete");
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }

  const remaining = MAX_CHARS - editContent.length;
  const activeTextareaRef = viewMode === "split" ? textareaRef : writeTextareaRef;

  // ── Secret unlock screen ───────────────────────────────────────────────────
  if (editing && !secretUnlocked) {
    return (
      <div className="w-full space-y-4">
        <button onClick={handleCancelEdit} className="no-print text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 vscode:hover:text-[#d4d4d4] transition-colors">
          ← Back
        </button>
        <div className="w-full max-w-xs mx-auto mt-12 space-y-4">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4]">Enter your edit secret</h2>
          <form onSubmit={handleUnlock} className="space-y-3">
            <input
              type="text"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              placeholder="Paste your edit secret…"
              autoFocus
              className="w-full font-mono text-sm bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg px-3 py-2 outline-none focus:border-blue-500 transition-colors text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] placeholder-gray-400"
            />
            {secretError && <p className="text-red-500 text-xs">{secretError}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
              >
                Unlock
              </button>
              <button
                type="button"
                onClick={handleCancelEdit}
                className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] transition-colors text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // ── Edit mode ──────────────────────────────────────────────────────────────
  if (editing && secretUnlocked) {
    const btnBase = "px-3 py-1.5 text-xs border rounded-lg transition-colors";
    const btnGhost = `${btnBase} border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]`;
    const btnDanger = `${btnBase} border-red-300 dark:border-red-800 vscode:border-red-900 hover:bg-red-50 dark:hover:bg-red-900/20 vscode:hover:bg-red-900/30 text-red-600 dark:text-red-400 vscode:text-red-400`;
    const inputBase = "bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] outline-none focus:border-blue-500 transition-colors";

    return (
      <div className="flex flex-col flex-1 min-h-0 gap-3">

        {/* Title */}
        <div className="no-print shrink-0">
          <input
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            placeholder="Document title (optional)"
            maxLength={200}
            className="w-full bg-transparent border-b border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] focus:border-blue-500 outline-none py-1 text-base sm:text-lg font-semibold text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] placeholder-gray-400 dark:placeholder-gray-600 transition-colors"
          />
        </div>

        {/* Edit options: password + expiry */}
        <div className="no-print flex flex-wrap items-center gap-2 shrink-0">
          {/* Password: remove (if protected) or set new */}
          {isPasswordProtected ? (
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={editRemovePassword}
                onChange={(e) => setEditRemovePassword(e.target.checked)}
                className="accent-red-500"
              />
              <span className="text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">Remove password</span>
            </label>
          ) : (
            <div className={`flex items-center gap-1.5 rounded-lg px-2 py-1 ${inputBase} focus-within:border-blue-500`}>
              <svg className="w-3 h-3 text-gray-400 dark:text-gray-500 vscode:text-[#9d9d9d] shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
              </svg>
              <input
                type={editShowPassword ? "text" : "password"}
                value={editNewPassword}
                onChange={(e) => setEditNewPassword(e.target.value)}
                placeholder="Add password"
                maxLength={100}
                className="bg-transparent outline-none text-xs w-28 placeholder-gray-400 dark:placeholder-gray-600"
              />
              {editNewPassword && (
                <button type="button" tabIndex={-1} onClick={() => setEditShowPassword(v => !v)}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 vscode:hover:text-[#d4d4d4] shrink-0">
                  {editShowPassword
                    ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  }
                </button>
              )}
            </div>
          )}
          {/* Expiry update */}
          <select
            value={editExpiresIn}
            onChange={(e) => setEditExpiresIn(e.target.value as import("@/lib/api").ExpiresIn | "")}
            className={`text-xs rounded-lg px-2 py-1 cursor-pointer ${inputBase}`}
          >
            <option value="">Expiry: no change</option>
            <option value="never">Remove expiry</option>
            <option value="1d">Expire in 1 day</option>
            <option value="7d">Expire in 7 days</option>
            <option value="30d">Expire in 30 days</option>
            <option value="custom">Custom expiry…</option>
          </select>
          {editExpiresIn === "custom" && (
            <input
              type="datetime-local"
              value={editCustomExpiresAt}
              onChange={(e) => setEditCustomExpiresAt(e.target.value)}
              className={`text-xs rounded-lg px-2 py-1 ${inputBase}`}
            />
          )}
        </div>

        {/* Action bar */}
        <div className="no-print flex items-center justify-between gap-2 shrink-0">
          <span className={`text-xs tabular-nums shrink-0 ${remaining < 1000 ? "text-amber-500" : "text-gray-400 dark:text-gray-500 vscode:text-[#9d9d9d]"}`}>
            {remaining.toLocaleString()} left
          </span>
          {showDeleteConfirm ? (
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <span className="text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] shrink-0">Delete permanently?</span>
              <button onClick={handleDelete} disabled={deleting}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-xs rounded-lg transition-colors">
                {deleting ? "Deleting…" : "Yes, delete"}
              </button>
              <button onClick={() => setShowDeleteConfirm(false)} className={btnGhost}>Cancel</button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button onClick={() => setShowDeleteConfirm(true)} className={btnDanger}>Delete</button>
              <button onClick={handleCancelEdit} className={btnGhost}>Cancel</button>
              <button onClick={handleSave} disabled={saving || !editContent.trim()}
                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-xs font-medium text-white transition-colors">
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          )}
        </div>

        {/* Mode tabs */}
        <div className="no-print flex items-center gap-1 border-b border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] shrink-0">
          {(["write", "split", "preview"] as ViewMode[]).map((m) => (
            <button key={m} onClick={() => setViewMode(m)}
              className={`${m === "split" ? "hidden sm:block" : ""} px-3 sm:px-4 py-2 text-sm transition-colors border-b-2 -mb-px ${
                viewMode === m
                  ? "border-blue-500 text-blue-500 dark:text-blue-400"
                  : "border-transparent text-gray-500 dark:text-gray-500 vscode:text-[#9d9d9d] hover:text-gray-700 dark:hover:text-gray-300 vscode:hover:text-[#d4d4d4]"
              }`}>
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        {/* Toolbar */}
        {viewMode !== "preview" && (
          <div className="no-print shrink-0 rounded-t-lg overflow-hidden border border-b-0 border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c]">
            <MarkdownToolbar textareaRef={activeTextareaRef} onChange={setEditContent} />
          </div>
        )}

        {/* Write */}
        {viewMode === "write" && (
          <textarea
            ref={writeTextareaRef}
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            autoFocus
            maxLength={MAX_CHARS}
            className="flex-1 min-h-0 w-full bg-gray-50 dark:bg-gray-900 vscode:bg-[#1e1e1e] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-b-lg rounded-t-none p-3 sm:p-4 font-mono text-sm text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] placeholder-gray-400 resize-none focus:outline-none focus:border-blue-500 transition-colors"
          />
        )}

        {/* Split */}
        {viewMode === "split" && (
          <div className="flex gap-3 flex-1 min-h-0">
            <textarea
              ref={textareaRef}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              onScroll={syncScroll}
              autoFocus
              maxLength={MAX_CHARS}
              className="w-1/2 h-full bg-gray-50 dark:bg-gray-900 vscode:bg-[#1e1e1e] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-b-lg rounded-t-none p-4 font-mono text-sm text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] resize-none focus:outline-none focus:border-blue-500 transition-colors overflow-y-auto"
            />
            <div ref={previewRef}
              className="w-1/2 h-full overflow-y-auto bg-gray-50/50 dark:bg-gray-900/50 vscode:bg-[#252526] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg p-5">
              {editContent.trim()
                ? <MarkdownPreview content={editContent} />
                : <p className="text-gray-400 dark:text-gray-600 vscode:text-[#9d9d9d] text-sm">Preview will appear here.</p>}
            </div>
          </div>
        )}

        {/* Preview */}
        {viewMode === "preview" && (
          <div className="flex-1 min-h-0 overflow-y-auto bg-gray-50/50 dark:bg-gray-900/50 vscode:bg-[#252526] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg p-3 sm:p-6">
            {editContent.trim()
              ? <MarkdownPreview content={editContent} />
              : <p className="text-gray-400 dark:text-gray-600 vscode:text-[#9d9d9d] text-sm">Nothing to preview yet.</p>}
          </div>
        )}

        {saveError && <p className="shrink-0 text-red-500 text-sm">{saveError}</p>}
      </div>
    );
  }

  // ── Read mode ──────────────────────────────────────────────────────────────
  return (
    <div className="w-full space-y-4">

      {/* Secret notice — shown once after publish */}
      {isNew && claimSecret && (
        <div className="no-print flex items-start gap-3 px-3 py-2 rounded-md border border-gray-200 dark:border-gray-700/60 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-gray-900/40 vscode:bg-[#252526] text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
          <span className="text-green-500 mt-0.5 shrink-0">✓</span>
          <div className="min-w-0">
            <span>Published. Save your edit secret — shown once:</span>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <code className="font-mono text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] select-all break-all">
                {claimSecret}
              </code>
              <CopyButton text={claimSecret} label="Copy" />
            </div>
          </div>
        </div>
      )}

      {/* Claim / save-to-account bar */}
      {!isOwned && !claimed && claimSecret && (
        user ? (
          <div className="no-print flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-blue-200 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/30 text-xs">
            <span className="text-blue-700 dark:text-blue-300">Save this document to your account to manage it and see analytics.</span>
            <button onClick={handleClaim} className="shrink-0 px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors">
              Save to my account
            </button>
          </div>
        ) : (
          <div className="no-print px-3 py-2 rounded-md border border-gray-200 dark:border-gray-700/60 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-gray-900/40 vscode:bg-[#252526] text-xs text-gray-500 dark:text-gray-400">
            <a href={`/login?next=/${slug}`} className="text-blue-500 hover:underline">Log in</a> to save this document to your account and track analytics.
          </div>
        )
      )}
      {claimMsg && <p className="no-print text-xs text-gray-500 dark:text-gray-400">{claimMsg}</p>}

      {/* Document header */}
      <div className="flex flex-col gap-2 no-print">
        <div className="space-y-1 min-w-0">
          {displayTitle && !pwdLocked && (
            <h1 className="text-lg sm:text-xl font-semibold text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4] break-words">{displayTitle}</h1>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-xs text-gray-400 dark:text-gray-500">/{slug}</span>
            {!pwdLocked && (
              <>
                <span className="text-xs text-gray-400 dark:text-gray-600">
                  {new Date(displayCreatedAt).toLocaleDateString()}
                </span>
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  {(displayViews ?? 0).toLocaleString()} {(displayViews ?? 0) === 1 ? "view" : "views"}
                </span>
                {displayExpiresAt && <ExpiryBadge expiresAt={displayExpiresAt} />}
              </>
            )}
            {isPasswordProtected && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 vscode:bg-[#2d2d2d] vscode:text-[#9d9d9d]">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
                </svg>
                Protected
              </span>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          <CopyButton text={url} onCopy={() => recordEvent(slug, "copy_url")} />
          {!pwdLocked && (
            <>
              <button
                onClick={() => setShowRaw(!showRaw)}
                className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] transition-colors text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]"
              >
                {showRaw ? "Rendered" : "Raw"}
              </button>
              <button
                onClick={() => { recordEvent(slug, "export_pdf"); window.print(); }}
                className="hidden sm:inline-flex px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] transition-colors text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]"
              >
                Export PDF
              </button>
            </>
          )}
          <button
            onClick={() => {
              if (secretUnlocked) {
                handleEditClick();
              } else {
                setEditing(true);
              }
            }}
            className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] transition-colors text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]"
          >
            Edit
          </button>

          {/* Save a copy — any viewer who isn't the owner (logged out → sign in first) */}
          {!isOwner && !pwdLocked && (
            <button
              onClick={requestCopy}
              title="Save your own editable copy of this document"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] transition-colors text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]"
            >
              <CopyDocIcon /> Save a copy
            </button>
          )}

          {/* Google Docs sync — owner + connected only */}
          {isOwner && gConnected && !pwdLocked && (
            googleDocUrl ? (
              <>
                <a
                  href={googleDocUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] transition-colors text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]"
                >
                  <GoogleDocIcon /> Open Doc
                </a>
                {googleDocStale ? (
                  <button
                    onClick={handleGoogleExport}
                    disabled={gBusy}
                    title="This document changed since the last sync — push the latest content to Google Docs"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border transition-colors disabled:opacity-50 border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20 vscode:border-[#665c33] vscode:bg-[#3a3320] vscode:text-[#e2c08d] vscode:hover:bg-[#4a4126]"
                  >
                    <ReloadIcon spinning={gBusy} /> {gBusy ? "Syncing to Google…" : "Sync to Google Docs"}
                  </button>
                ) : (
                  <button
                    onClick={handleGoogleExport}
                    disabled={gBusy}
                    title="Up to date with Google Docs — click to re-sync"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border transition-colors disabled:opacity-50 border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700/50 dark:text-emerald-400 dark:hover:bg-emerald-950/30 vscode:border-[#2e4034] vscode:text-[#4ec9b0] vscode:hover:bg-[#26332b]"
                  >
                    {gBusy ? <><ReloadIcon spinning /> Syncing to Google…</> : <><GoogleDocIcon /> Synced to Google</>}
                  </button>
                )}
              </>
            ) : (
              <button
                onClick={handleGoogleExport}
                disabled={gBusy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] disabled:opacity-50 transition-colors text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]"
              >
                {gBusy ? <Spinner /> : <GoogleDocIcon />} {gBusy ? "Publishing…" : "Publish to Google Docs"}
              </button>
            )
          )}

          {!secretUnlocked && !pwdLocked && (
            <button
              onClick={() => { setReportReason(""); setReportDone(false); setShowReport(true); }}
              title="Report this document"
              className="ml-auto px-2 py-1.5 text-xs text-gray-400 hover:text-red-500 transition-colors"
            >
              ⚑ Report
            </button>
          )}
        </div>

        {gError && (
          <div className="flex items-center justify-between gap-3 flex-wrap px-3 py-2 rounded-md border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-600 dark:text-red-400">
            <span>{gError}</span>
            <div className="flex items-center gap-3 shrink-0">
              {gNeedsReconnect && (
                <button onClick={handleGoogleReconnect} className="font-medium underline hover:no-underline">Reconnect Google Docs →</button>
              )}
              <button onClick={() => { setGError(null); setGNeedsReconnect(false); }} className="text-red-400 hover:text-red-600">✕</button>
            </div>
          </div>
        )}
      </div>

      {showAuth && (
        <AuthModal
          title="Sign in to save a copy"
          message="Saving a copy adds this document to your Markdrop account so you can edit it, track views, and sync it to Google Docs. Sign in or create a free account to continue."
          next={`/${slug}?copy=1`}
          onClose={() => setShowAuth(false)}
          onSuccess={() => { setShowAuth(false); setCopyError(""); setShowCopy(true); }}
        />
      )}

      {showCopy && (
        <Modal title="Save a copy to your account" onClose={() => { if (!copyBusy) setShowCopy(false); }}>
          <div className="space-y-4">
            <p className="text-sm text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
              This creates your own editable copy on Markdrop with a new link. The
              copy has <span className="font-medium">no password</span> and{" "}
              <span className="font-medium">no expiry</span>.
            </p>
            <div className="space-y-2">
              <button
                onClick={() => handleCopy(false)}
                disabled={!!copyBusy}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left rounded-lg border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] hover:border-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-950/20 disabled:opacity-50 transition-colors"
              >
                {copyBusy === "plain"
                  ? <Spinner className="w-5 h-5 shrink-0 text-blue-500" />
                  : <CopyDocIcon className="w-5 h-5 shrink-0 text-blue-500" />}
                <span>
                  <span className="block text-sm font-medium text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4]">
                    {copyBusy === "plain" ? "Creating copy…" : "Copy to Markdrop"}
                  </span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
                    A new document in your dashboard.
                  </span>
                </span>
              </button>
              <button
                onClick={() => handleCopy(true)}
                disabled={!!copyBusy}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left rounded-lg border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] hover:border-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-950/20 disabled:opacity-50 transition-colors"
              >
                {copyBusy === "google"
                  ? <Spinner className="w-5 h-5 shrink-0 text-blue-500" />
                  : <GoogleDocIcon className="w-5 h-5 shrink-0" />}
                <span>
                  <span className="block text-sm font-medium text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4]">
                    {copyBusy === "google"
                      ? "Working…"
                      : gConnected
                        ? "Copy & sync to Google Docs"
                        : "Copy & connect Google Docs"}
                  </span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
                    {gConnected
                      ? "Also export the copy to a new Google Doc."
                      : "You'll be asked to connect Google Docs first."}
                  </span>
                </span>
              </button>
            </div>
            {copyError && <p className="text-xs text-red-500">{copyError}</p>}
            <div className="flex justify-end">
              <button
                onClick={() => setShowCopy(false)}
                disabled={!!copyBusy}
                className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showReport && (
        <Modal title={reportDone ? "Report submitted" : "Report this document"} onClose={() => setShowReport(false)}>
          {reportDone ? (
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">Thanks — our team will review this document.</p>
              <div className="flex justify-end">
                <button onClick={() => setShowReport(false)} className="px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Close</button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-gray-500 dark:text-gray-400">Report spam, phishing, or abusive content. Optionally tell us why:</p>
              <textarea
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder="Reason (optional)"
                className="w-full bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition-colors resize-none"
              />
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowReport(false)} className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
                <button onClick={submitReport} disabled={reportBusy} className="px-4 py-2 text-sm rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-medium transition-colors">
                  {reportBusy ? "Submitting…" : "Submit report"}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}

      {/* Print-only header */}
      <div className="hidden print-only">
        {displayTitle && <h1 className="text-2xl font-bold mb-4">{displayTitle}</h1>}
      </div>

      {/* Content — password gate or actual content */}
      {pwdLocked ? (
        <div className="relative border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] rounded-lg overflow-hidden">
          {/* Blurred skeleton */}
          <div className="blur-sm select-none pointer-events-none p-6 space-y-3 bg-[#252526] dark:bg-gray-900/50 vscode:bg-[#252526]" aria-hidden>
            {[...Array(6)].map((_, i) => (
              <div
                key={i}
                className={`h-3 bg-gray-200 dark:bg-gray-700 vscode:bg-[#3c3c3c] rounded ${
                  i % 3 === 0 ? "w-3/4" : i % 3 === 1 ? "w-full" : "w-5/6"
                }`}
              />
            ))}
          </div>
          {/* Overlay */}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#1e1e1e]/80 dark:bg-gray-950/70 vscode:bg-[#1e1e1e]/80 backdrop-blur-sm">
            <svg className="w-8 h-8 text-gray-400 dark:text-gray-500 vscode:text-[#9d9d9d]" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
            </svg>
            <p className="text-sm font-medium text-gray-600 dark:text-gray-400 vscode:text-[#9d9d9d]">This document is password protected</p>
            <form onSubmit={handlePasswordUnlock} className="flex flex-col items-center gap-2 w-full max-w-xs px-4">
              <div className="flex w-full gap-2">
                <div className="flex flex-1 items-center bg-[#2d2d2d] dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] rounded-lg overflow-hidden focus-within:border-blue-500 transition-colors">
                  <input
                    type={pwdVisible ? "text" : "password"}
                    value={pwdInput}
                    onChange={(e) => setPwdInput(e.target.value)}
                    placeholder="Enter password"
                    autoFocus
                    className="flex-1 text-sm bg-transparent px-3 py-1.5 outline-none text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] placeholder-gray-400"
                  />
                  {pwdInput && (
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => setPwdVisible((v) => !v)}
                      className="px-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 vscode:hover:text-[#d4d4d4] shrink-0"
                      aria-label={pwdVisible ? "Hide password" : "Show password"}
                    >
                      {pwdVisible ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                          <line x1="1" y1="1" x2="23" y2="23"/>
                        </svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                          <circle cx="12" cy="12" r="3"/>
                        </svg>
                      )}
                    </button>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={pwdUnlocking || !pwdInput.trim()}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors shrink-0"
                >
                  {pwdUnlocking ? "…" : "Unlock"}
                </button>
              </div>
              {pwdError && <p className="text-xs text-red-500 self-start">{pwdError}</p>}
            </form>
          </div>
        </div>
      ) : pwdFetching ? (
        <div className="border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] rounded-lg p-6 space-y-3 bg-[#252526] dark:bg-gray-900/50 vscode:bg-[#252526]">
          {[...Array(6)].map((_, i) => (
            <div
              key={i}
              className={`h-3 bg-gray-100 dark:bg-gray-800 vscode:bg-[#2d2d2d] rounded animate-pulse ${
                i % 3 === 0 ? "w-3/4" : i % 3 === 1 ? "w-full" : "w-5/6"
              }`}
            />
          ))}
        </div>
      ) : (
        <div className="relative border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] rounded-lg p-3 sm:p-6 bg-[#252526] dark:bg-gray-900/50 vscode:bg-[#252526] print:border-0 print:p-0 print:bg-white overflow-hidden">
          {showRaw ? (
            <>
              <CopyButton text={displayContent} label="Copy all" className="no-print absolute top-3 right-3" />
              <pre className="font-mono text-xs sm:text-sm text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] whitespace-pre-wrap break-words">
                {displayContent}
              </pre>
            </>
          ) : (
            <MarkdownPreview content={displayContent} />
          )}
        </div>
      )}
    </div>
  );
}
