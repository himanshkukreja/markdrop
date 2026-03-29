"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import MarkdownPreview from "@/components/MarkdownPreview";
import CopyButton from "@/components/CopyButton";
import MarkdownToolbar from "@/components/MarkdownToolbar";
import { updateDocument, deleteDocument, getDocument } from "@/lib/api";

type ViewMode = "write" | "split" | "preview";

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
}

const MAX_CHARS = 20_000;

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
}: Props) {
  const router = useRouter();

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
      router.push("/");
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
      {isNew && initialSecret && (
        <div className="no-print flex items-start gap-3 px-3 py-2 rounded-md border border-gray-200 dark:border-gray-700/60 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-gray-900/40 vscode:bg-[#252526] text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
          <span className="text-green-500 mt-0.5 shrink-0">✓</span>
          <div className="min-w-0">
            <span>Published. Save your edit secret — shown once:</span>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <code className="font-mono text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] select-all break-all">
                {initialSecret}
              </code>
              <CopyButton text={initialSecret} label="Copy" />
            </div>
          </div>
        </div>
      )}

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
          <CopyButton text={url} />
          {!pwdLocked && (
            <>
              <button
                onClick={() => setShowRaw(!showRaw)}
                className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] transition-colors text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]"
              >
                {showRaw ? "Rendered" : "Raw"}
              </button>
              <button
                onClick={() => window.print()}
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
        </div>
      </div>

      {/* Print-only header */}
      <div className="hidden print-only">
        {displayTitle && <h1 className="text-2xl font-bold mb-4">{displayTitle}</h1>}
      </div>

      {/* Content — password gate or actual content */}
      {pwdLocked ? (
        <div className="relative border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] rounded-lg overflow-hidden">
          {/* Blurred skeleton */}
          <div className="blur-sm select-none pointer-events-none p-6 space-y-3 bg-white dark:bg-gray-900/50 vscode:bg-[#252526]" aria-hidden>
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
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white/70 dark:bg-gray-950/70 vscode:bg-[#1e1e1e]/80 backdrop-blur-sm">
            <svg className="w-8 h-8 text-gray-400 dark:text-gray-500 vscode:text-[#9d9d9d]" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
            </svg>
            <p className="text-sm font-medium text-gray-600 dark:text-gray-400 vscode:text-[#9d9d9d]">This document is password protected</p>
            <form onSubmit={handlePasswordUnlock} className="flex flex-col items-center gap-2 w-full max-w-xs px-4">
              <div className="flex w-full gap-2">
                <div className="flex flex-1 items-center bg-white dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] rounded-lg overflow-hidden focus-within:border-blue-500 transition-colors">
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
        <div className="border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] rounded-lg p-6 space-y-3 bg-white dark:bg-gray-900/50 vscode:bg-[#252526]">
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
        <div className="relative border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] rounded-lg p-3 sm:p-6 bg-white dark:bg-gray-900/50 vscode:bg-[#252526] print:border-0 print:p-0 print:bg-white overflow-hidden">
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
