"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import MarkdownPreview from "@/components/MarkdownPreview";
import CopyButton from "@/components/CopyButton";
import MarkdownToolbar from "@/components/MarkdownToolbar";
import { updateDocument, deleteDocument } from "@/lib/api";

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
}

const MAX_CHARS = 20_000;

function ExpiryBadge({ expiresAt }: { expiresAt: string }) {
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return null;
  const label = days === 1 ? "Expires in 1 day" : `Expires in ${days} days`;
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
  createdAt,
  expiresAt,
  views: initialViews,
  isNew,
  editSecret: initialSecret,
}: Props) {
  const router = useRouter();

  // Live display state (updated on save without needing a server round-trip)
  const [displayTitle, setDisplayTitle] = useState(initialTitle);
  const [displayContent, setDisplayContent] = useState(initialContent);

  // View state
  const [showRaw, setShowRaw] = useState(false);

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [secretInput, setSecretInput] = useState(initialSecret || "");
  const [secretUnlocked, setSecretUnlocked] = useState(!!initialSecret);
  const [secretError, setSecretError] = useState("");

  // Editor state (initialised when entering edit mode)
  const [editTitle, setEditTitle] = useState(initialTitle || "");
  const [editContent, setEditContent] = useState(initialContent);
  const [viewMode, setViewMode] = useState<ViewMode>("write");

  // Save / delete state
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Scroll sync refs for split view
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const writeTextareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

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

  function handleUnlock(e: React.FormEvent) {
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
      await updateDocument(slug, editTitle, editContent, secretInput);
      setDisplayTitle(editTitle || null);
      setDisplayContent(editContent);
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
        <button onClick={handleCancelEdit} className="no-print text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
          ← Back
        </button>
        <div className="w-full max-w-xs mx-auto mt-12 space-y-4">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-200">Enter your edit secret</h2>
          <form onSubmit={handleUnlock} className="space-y-3">
            <input
              type="text"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              placeholder="Paste your edit secret…"
              autoFocus
              className="w-full font-mono text-sm bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 outline-none focus:border-blue-500 transition-colors text-gray-800 dark:text-gray-200 placeholder-gray-400"
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
                className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-gray-700 dark:text-gray-300"
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
    return (
      <div className="flex flex-col flex-1 min-h-0 gap-3">

        {/* Top bar */}
        <div className="no-print flex flex-col gap-2 shrink-0">
          <input
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            placeholder="Document title (optional)"
            maxLength={200}
            className="w-full bg-transparent border-b border-gray-200 dark:border-gray-700 focus:border-blue-500 dark:focus:border-blue-500 outline-none py-1 text-base sm:text-lg font-semibold text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 transition-colors"
          />
          <div className="flex items-center justify-between gap-2">
            <span className={`text-xs tabular-nums shrink-0 ${remaining < 1000 ? "text-amber-500" : "text-gray-400 dark:text-gray-500"}`}>
              {remaining.toLocaleString()} left
            </span>
            {showDeleteConfirm ? (
              <div className="flex items-center gap-2 flex-wrap justify-end">
                <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">Delete permanently?</span>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="px-3 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-xs rounded-lg transition-colors"
                >
                  {deleting ? "Deleting…" : "Yes, delete"}
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-gray-700 dark:text-gray-300"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="px-3 py-1.5 text-xs border border-red-300 dark:border-red-800 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-red-600 dark:text-red-400"
                >
                  Delete
                </button>
                <button
                  onClick={handleCancelEdit}
                  className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-gray-700 dark:text-gray-300"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving || !editContent.trim()}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-xs font-medium text-white transition-colors"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Mode tabs */}
        <div className="no-print flex items-center gap-1 border-b border-gray-200 dark:border-gray-800 shrink-0">
          {(["write", "split", "preview"] as ViewMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={`${m === "split" ? "hidden sm:block" : ""} px-3 sm:px-4 py-2 text-sm transition-colors border-b-2 -mb-px ${
                viewMode === m
                  ? "border-blue-500 text-blue-500 dark:text-blue-400"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              }`}
            >
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        {/* Toolbar */}
        {viewMode !== "preview" && (
          <div className="no-print shrink-0 rounded-t-lg overflow-hidden border border-b-0 border-gray-200 dark:border-gray-700">
            <MarkdownToolbar
              textareaRef={activeTextareaRef}
              onChange={setEditContent}
            />
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
            className="flex-1 min-h-0 w-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-b-lg rounded-t-none p-3 sm:p-4 font-mono text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 resize-none focus:outline-none focus:border-blue-500 transition-colors"
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
              className="w-1/2 h-full bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-b-lg rounded-t-none p-4 font-mono text-sm text-gray-800 dark:text-gray-200 resize-none focus:outline-none focus:border-blue-500 transition-colors overflow-y-auto"
            />
            <div
              ref={previewRef}
              className="w-1/2 h-full overflow-y-auto bg-gray-50/50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-5"
            >
              {editContent.trim()
                ? <MarkdownPreview content={editContent} />
                : <p className="text-gray-400 dark:text-gray-600 text-sm">Preview will appear here.</p>
              }
            </div>
          </div>
        )}

        {/* Preview */}
        {viewMode === "preview" && (
          <div className="flex-1 min-h-0 overflow-y-auto bg-gray-50/50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-3 sm:p-6">
            {editContent.trim()
              ? <MarkdownPreview content={editContent} />
              : <p className="text-gray-400 dark:text-gray-600 text-sm">Nothing to preview yet.</p>
            }
          </div>
        )}

        {saveError && (
          <p className="shrink-0 text-red-500 text-sm">{saveError}</p>
        )}
      </div>
    );
  }

  // ── Read mode ──────────────────────────────────────────────────────────────
  return (
    <div className="w-full space-y-4">

      {/* Secret notice — shown once after publish */}
      {isNew && initialSecret && (
        <div className="no-print flex items-start gap-3 px-3 py-2 rounded-md border border-gray-200 dark:border-gray-700/60 bg-gray-50 dark:bg-gray-900/40 text-xs text-gray-500 dark:text-gray-400">
          <span className="text-green-500 mt-0.5 shrink-0">✓</span>
          <div className="min-w-0">
            <span>Published. Save your edit secret — shown once:</span>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <code className="font-mono text-gray-700 dark:text-gray-300 select-all break-all">
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
          {displayTitle && (
            <h1 className="text-lg sm:text-xl font-semibold text-gray-900 dark:text-gray-100 break-words">{displayTitle}</h1>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-xs text-gray-400 dark:text-gray-500">/{slug}</span>
            <span className="text-xs text-gray-400 dark:text-gray-600">
              {new Date(createdAt).toLocaleDateString()}
            </span>
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {(initialViews ?? 0).toLocaleString()} {(initialViews ?? 0) === 1 ? "view" : "views"}
            </span>
            {expiresAt && <ExpiryBadge expiresAt={expiresAt} />}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          <CopyButton text={url} />
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-gray-700 dark:text-gray-300"
          >
            {showRaw ? "Rendered" : "Raw"}
          </button>
          <button
            onClick={() => window.print()}
            className="hidden sm:inline-flex px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-gray-700 dark:text-gray-300"
          >
            Export PDF
          </button>
          <button
            onClick={() => {
              if (secretUnlocked) {
                handleEditClick();
              } else {
                setEditing(true);
              }
            }}
            className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-gray-700 dark:text-gray-300"
          >
            Edit
          </button>
        </div>
      </div>

      {/* Print-only header */}
      <div className="hidden print-only">
        {displayTitle && <h1 className="text-2xl font-bold mb-4">{displayTitle}</h1>}
      </div>

      {/* Content */}
      <div className="relative border border-gray-200 dark:border-gray-800 rounded-lg p-3 sm:p-6 bg-white dark:bg-gray-900/50 print:border-0 print:p-0 print:bg-white overflow-hidden">
        {showRaw ? (
          <>
            <CopyButton text={displayContent} label="Copy all" className="no-print absolute top-3 right-3" />
            <pre className="font-mono text-xs sm:text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words">
              {displayContent}
            </pre>
          </>
        ) : (
          <MarkdownPreview content={displayContent} />
        )}
      </div>
    </div>
  );
}
