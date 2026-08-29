"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Spinner from "@/components/Spinner";
import { useAuth } from "@/contexts/AuthContext";
import {
  getArtifactStatus,
  pasteHtmlArtifact,
  uploadArtifact,
  type ArtifactStatus,
  type ExpiresIn,
} from "@/lib/api";

type Tab = "paste" | "upload";

const ACCEPT = ".html,.htm,.pdf,.csv,.xlsx,.xls,.json,.txt,.png,.jpg,.jpeg,.gif,.webp,.svg";
const SLUG_PATTERN = /^[a-zA-Z0-9_-]*$/;

const SAMPLE = `<!doctype html>
<html>
  <head><style>body{font-family:system-ui;padding:3rem;background:#0b1220;color:#e5e7eb}</style></head>
  <body><h1>Hello from Markdrop</h1><p>Paste any HTML here and publish it.</p></body>
</html>`;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function UploadArtifactPage() {
  const router = useRouter();
  const { user, openAuthModal } = useAuth();

  const [tab, setTab] = useState<Tab>("paste");
  const [status, setStatus] = useState<ArtifactStatus | null>(null);
  const [html, setHtml] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [title, setTitle] = useState("");
  const [customSlug, setCustomSlug] = useState("");
  const [slugError, setSlugError] = useState("");
  const [expiresIn, setExpiresIn] = useState<ExpiresIn>("never");
  const [readPassword, setReadPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getArtifactStatus().then(setStatus).catch(() => {});
  }, [user]);

  function pickFile(f: File | null) {
    if (!f) return;
    if (status && f.size > status.max_file_bytes) {
      setError(`That file is ${formatBytes(f.size)} — the limit is ${formatBytes(status.max_file_bytes)}.`);
      return;
    }
    setError("");
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
  }

  function handleSlug(v: string) {
    if (!SLUG_PATTERN.test(v)) return;
    setCustomSlug(v);
    setSlugError(v && v.length < 3 ? "Minimum 3 characters" : "");
  }

  async function publish() {
    if (!user) {
      openAuthModal({
        title: "Sign in to publish an artifact",
        message:
          "Artifacts are stored against your account so you can manage and delete them, and so we can keep quotas fair. Sign in or create a free account to continue.",
        next: "/upload",
      });
      return;
    }
    if (customSlug && customSlug.length < 3) return setSlugError("Minimum 3 characters");

    setBusy(true);
    setError("");
    setProgress(0);
    const opts = {
      customSlug: customSlug || undefined,
      expiresIn,
      readPassword: readPassword || undefined,
    };
    try {
      const doc =
        tab === "paste"
          ? await pasteHtmlArtifact(html, title, opts)
          : await uploadArtifact(file!, title, { ...opts, onProgress: setProgress });
      sessionStorage.setItem(`secret:${doc.slug}`, doc.edit_secret);
      router.push(`/${doc.slug}?new=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setBusy(false);
    }
  }

  const canPublish = tab === "paste" ? html.trim().length > 0 : !!file;
  const inputClass =
    "text-xs bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-md px-2 py-1 text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] outline-none focus:border-blue-500 transition-colors";

  if (status && !status.configured) {
    return (
      <div className="max-w-lg mx-auto mt-16 text-center space-y-3">
        <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Artifacts aren&apos;t enabled yet</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Artifact hosting is still being set up on this server. Markdown publishing works as normal
          in the meantime.
        </p>
        <a href="/new" className="inline-block text-sm text-blue-500 hover:underline">
          Publish markdown instead →
        </a>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto w-full space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4]">
          Publish an artifact
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Paste an HTML page or upload a PDF or spreadsheet — get a shareable link that renders it.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c]">
        {(["paste", "upload"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px transition-colors ${
              tab === t
                ? "border-blue-500 text-blue-500"
                : "border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
            }`}
          >
            {t === "paste" ? "Paste HTML" : "Upload a file"}
          </button>
        ))}
      </div>

      {tab === "paste" ? (
        <div className="space-y-2">
          <textarea
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            placeholder="Paste your HTML here…"
            spellCheck={false}
            className="w-full h-72 font-mono text-xs bg-gray-50 dark:bg-gray-900 vscode:bg-[#1e1e1e] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg p-3 outline-none focus:border-blue-500 transition-colors text-gray-800 dark:text-gray-200 resize-none"
          />
          <div className="flex items-center justify-between text-xs text-gray-400">
            <span>{formatBytes(new Blob([html]).size)}</span>
            {!html && (
              <button onClick={() => setHtml(SAMPLE)} className="text-blue-500 hover:underline">
                Insert a sample page
              </button>
            )}
          </div>
        </div>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            pickFile(e.dataTransfer.files?.[0] ?? null);
          }}
          onClick={() => fileInput.current?.click()}
          className={`h-72 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed cursor-pointer transition-colors ${
            dragging
              ? "border-blue-500 bg-blue-50/50 dark:bg-blue-950/20"
              : "border-gray-300 dark:border-gray-700 vscode:border-[#3c3c3c] hover:border-blue-400"
          }`}
        >
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <>
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{file.name}</p>
              <p className="text-xs text-gray-400">{formatBytes(file.size)} · click to change</p>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-600 dark:text-gray-300">
                Drop a file here, or click to browse
              </p>
              <p className="text-xs text-gray-400">
                HTML, PDF, Excel, CSV, JSON, images
                {status && ` · up to ${formatBytes(status.max_file_bytes)}`}
              </p>
            </>
          )}
        </div>
      )}

      {/* Options */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (optional)"
          maxLength={200}
          className={`${inputClass} flex-1 min-w-[12rem]`}
        />
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-400">markdrop.in/</span>
          <input
            type="text"
            value={customSlug}
            onChange={(e) => handleSlug(e.target.value)}
            placeholder="custom-url"
            maxLength={50}
            className={`${inputClass} w-32`}
          />
        </div>
        <select
          value={expiresIn}
          onChange={(e) => setExpiresIn(e.target.value as ExpiresIn)}
          className={`${inputClass} cursor-pointer`}
        >
          <option value="never">Never expires</option>
          <option value="1d">Expires in 1 day</option>
          <option value="7d">Expires in 7 days</option>
          <option value="30d">Expires in 30 days</option>
        </select>
        <input
          type="password"
          value={readPassword}
          onChange={(e) => setReadPassword(e.target.value)}
          placeholder="Password (optional)"
          maxLength={100}
          className={`${inputClass} w-40`}
        />
      </div>
      {slugError && <p className="text-xs text-red-500">{slugError}</p>}

      {status && status.quota_bytes > 0 && (
        <p className="text-xs text-gray-400">
          {formatBytes(status.used_bytes)} of {formatBytes(status.quota_bytes)} storage used
        </p>
      )}

      {error && (
        <div className="px-3 py-2 rounded-md border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {busy && tab === "upload" && progress > 0 && progress < 100 && (
        <div className="h-1 w-full bg-gray-200 dark:bg-gray-800 rounded overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all duration-200"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={publish}
          disabled={busy || !canPublish}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-medium text-white transition-colors"
        >
          {busy && <Spinner className="w-4 h-4" />}
          {busy ? (progress > 0 && progress < 100 ? `Uploading ${progress}%` : "Publishing…") : "Publish"}
        </button>
        <p className="text-xs text-gray-400">
          Rendered on a separate domain, so a page can never touch your Markdrop account.
        </p>
      </div>
    </div>
  );
}
