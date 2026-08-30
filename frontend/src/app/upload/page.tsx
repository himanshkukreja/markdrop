"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Spinner from "@/components/Spinner";
import { slugifyFilename, titleFromFilename } from "@/lib/slugify";
import ArtifactPreview from "./ArtifactPreview";
import { useAuth } from "@/contexts/AuthContext";
import {
  getArtifactStatus,
  pasteHtmlArtifact,
  uploadArtifact,
  type ArtifactStatus,
  type ExpiresIn,
} from "@/lib/api";

type Tab = "paste" | "upload";

const ACCEPT =
  ".html,.htm,.pdf,.docx,.csv,.xlsx,.xls,.json,.txt,.zip,.png,.jpg,.jpeg,.gif,.webp,.svg";
const SLUG_PATTERN = /^[a-zA-Z0-9_-]*$/;

// Shown in the empty dropzone. Colours mirror components/ArtifactBadge.tsx so
// the promise here matches the badge on the published page.
const FILE_KINDS = [
  { label: "HTML", cls: "bg-orange-500/10 text-orange-600 dark:text-orange-400 ring-orange-500/25" },
  { label: "PDF", cls: "bg-red-500/10 text-red-600 dark:text-red-400 ring-red-500/25" },
  { label: "Excel", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-emerald-500/25" },
  { label: "Word", cls: "bg-blue-500/10 text-blue-600 dark:text-blue-400 ring-blue-500/25" },
  { label: "CSV", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-emerald-500/25" },
  { label: "Images", cls: "bg-violet-500/10 text-violet-600 dark:text-violet-400 ring-violet-500/25" },
  { label: ".zip site", cls: "bg-teal-500/10 text-teal-600 dark:text-teal-400 ring-teal-500/25" },
];

/** How a chosen file will be presented, so the dropzone can say so up front. */
function describeFile(f: File): string {
  const ext = f.name.toLowerCase().split(".").pop() || "";
  if (["html", "htm"].includes(ext)) return "a live page";
  if (ext === "pdf") return "a readable PDF";
  if (["xlsx", "xls", "csv"].includes(ext)) return "a spreadsheet";
  if (ext === "docx") return "a document";
  if (ext === "zip") return "a multi-file site";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "an image";
  return "";
}

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
  const [slugTouched, setSlugTouched] = useState(false);
  const [titleTouched, setTitleTouched] = useState(false);
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
    // Prefill from the filename so the published link reads like the file
    // instead of a random slug — but never overwrite something typed by hand.
    if (!titleTouched) setTitle(titleFromFilename(f.name));
    if (!slugTouched) {
      const derived = slugifyFilename(f.name);
      // Under 3 chars the server would reject it; leave it blank and let the
      // server pick instead of showing an error on a field they never touched.
      setCustomSlug(derived.length >= 3 ? derived : "");
      setSlugError("");
    }
  }

  function handleSlug(v: string) {
    if (!SLUG_PATTERN.test(v)) return;
    setSlugTouched(true);
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
    "w-full text-sm bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg px-3 py-2 text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] outline-none focus:border-blue-500 transition-colors";
  const labelClass = "block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5";

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
    <div className="max-w-3xl mx-auto w-full space-y-5 pb-10">
      {/* Header */}
      <div className="text-center sm:text-left">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-orange-600 dark:text-orange-400 ring-1 ring-orange-500/25">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-orange-500" />
          </span>
          Artifacts
        </span>
        <h1 className="mt-3 text-2xl sm:text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4]">
          Publish a file, get a page
        </h1>
        <p className="mt-2 text-sm sm:text-base text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] max-w-xl mx-auto sm:mx-0">
          Drop in a PDF, spreadsheet, Word doc or a zipped site — or paste raw HTML.
          You get one link that <span className="text-gray-800 dark:text-gray-200 font-medium">renders</span> it,
          instead of downloading it.
        </p>
      </div>

      {/* Mode switch — a segmented control reads as a choice, where the old
          underlined tabs read as navigation away from the page. */}
      <div className="inline-flex w-full sm:w-auto p-1 rounded-xl bg-gray-100/80 dark:bg-gray-900/60 vscode:bg-[#1e1e1e]">
        {([
          { id: "upload" as Tab, label: "Upload a file", d: "M12 16V4m0 0L8 8m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" },
          { id: "paste" as Tab, label: "Paste HTML", d: "M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2M9 4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1H9z" },
        ]).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
            className={`flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-all ${
              tab === t.id
                ? "bg-white dark:bg-gray-800 vscode:bg-[#2d2d2d] text-gray-900 dark:text-gray-100 shadow-sm"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
            }`}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d={t.d} />
            </svg>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "paste" ? (
        <div className="grid lg:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] overflow-hidden bg-gray-50 dark:bg-[#0d1526] vscode:bg-[#1e1e1e]">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-white/60 dark:bg-white/[0.02]">
            <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
            <span className="ml-2 text-[11px] font-mono text-gray-400">index.html</span>
            <span className="ml-auto text-[11px] tabular-nums text-gray-400">
              {formatBytes(new Blob([html]).size)}
            </span>
          </div>
          <textarea
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            placeholder={"<!doctype html>\n<html>\n  <body>\n    <h1>Hello</h1>\n  </body>\n</html>"}
            spellCheck={false}
            className="w-full h-72 font-mono text-xs bg-transparent p-4 outline-none text-gray-800 dark:text-gray-200 resize-none placeholder:text-gray-400/70"
          />
          {!html && (
            <div className="px-4 pb-3 -mt-2">
              <button onClick={() => setHtml(SAMPLE)} className="text-xs text-blue-500 hover:underline">
                Insert a sample page
              </button>
            </div>
          )}
        </div>
        <ArtifactPreview html={html} />
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
          onClick={() => !file && fileInput.current?.click()}
          className={`relative rounded-2xl border-2 border-dashed transition-all ${
            dragging
              ? "border-blue-500 bg-blue-50/60 dark:bg-blue-950/25 scale-[1.01]"
              : file
              ? "border-emerald-400/60 bg-emerald-50/40 dark:bg-emerald-950/15"
              : "border-gray-300 dark:border-gray-700 vscode:border-[#3c3c3c] hover:border-blue-400 hover:bg-blue-50/30 dark:hover:bg-blue-950/10 cursor-pointer"
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
            /* Selected state: confirm what was picked and how it will render,
               so there's no doubt before publishing. */
            <div className="p-5 sm:p-6 flex items-start gap-4">
              <div className="shrink-0 grid place-items-center w-12 h-12 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-gray-900 dark:text-gray-100 truncate">{file.name}</p>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {formatBytes(file.size)}
                  {describeFile(file) && <> · will render as <span className="font-medium">{describeFile(file)}</span></>}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={(e) => { e.stopPropagation(); fileInput.current?.click(); }}
                    className="px-2.5 py-1 text-xs rounded-md border border-gray-300 dark:border-gray-600 hover:bg-white dark:hover:bg-gray-800 transition-colors"
                  >
                    Choose another
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setFile(null); }}
                    className="px-2.5 py-1 text-xs rounded-md text-gray-500 hover:text-red-500 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="px-6 py-12 flex flex-col items-center text-center">
              <div className={`grid place-items-center w-14 h-14 rounded-2xl mb-4 transition-colors ${
                dragging ? "bg-blue-500/15 text-blue-500" : "bg-gray-100 dark:bg-gray-800 vscode:bg-[#2d2d2d] text-gray-400"
              }`}>
                <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 16V4m0 0L8 8m4-4 4 4" />
                  <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                </svg>
              </div>
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
                {dragging ? "Drop it here" : "Drag a file here, or click to browse"}
              </p>
              <p className="mt-1 text-xs text-gray-400">
                {status ? `Up to ${formatBytes(status.max_file_bytes)}` : "\u00a0"}
              </p>

              <div className="mt-5 flex flex-wrap justify-center gap-1.5">
                {FILE_KINDS.map((k) => (
                  <span key={k.label} className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${k.cls}`}>
                    {k.label}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "upload" && file && <ArtifactPreview file={file} />}

      {/* Options */}
      <div className="rounded-2xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] p-4 sm:p-5 space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => { setTitleTouched(true); setTitle(e.target.value); }}
              placeholder="Untitled"
              maxLength={200}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Link</label>
            <div className="flex items-center rounded-lg border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] focus-within:border-blue-500 transition-colors overflow-hidden">
              <span className="pl-3 pr-0.5 text-xs text-gray-400 shrink-0 select-none">markdrop.in/</span>
              <input
                type="text"
                value={customSlug}
                onChange={(e) => handleSlug(e.target.value)}
                placeholder="auto"
                maxLength={50}
                className="flex-1 min-w-0 bg-transparent py-2 pr-3 text-sm font-mono outline-none text-gray-700 dark:text-gray-300"
              />
            </div>
            {slugError && <p className="mt-1 text-[11px] text-red-500">{slugError}</p>}
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Expiry</label>
            <select
              value={expiresIn}
              onChange={(e) => setExpiresIn(e.target.value as ExpiresIn)}
              className={`${inputClass} cursor-pointer`}
            >
              <option value="never">Never expires</option>
              <option value="1d">Delete after 1 day</option>
              <option value="7d">Delete after 7 days</option>
              <option value="30d">Delete after 30 days</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>
              Password <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              type="password"
              value={readPassword}
              onChange={(e) => setReadPassword(e.target.value)}
              placeholder="Anyone with the link can view"
              maxLength={100}
              className={inputClass}
            />
          </div>
        </div>
      </div>

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

      <div className="sticky bottom-0 -mx-4 sm:mx-0 px-4 sm:px-0 py-3 bg-gradient-to-t from-white via-white dark:from-gray-950 dark:via-gray-950 vscode:from-[#1e1e1e] vscode:via-[#1e1e1e] to-transparent">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={publish}
            disabled={busy || !canPublish}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl text-sm font-semibold text-white transition-colors shadow-sm shadow-blue-600/20"
          >
            {busy && <Spinner className="w-4 h-4" />}
            {busy
              ? progress > 0 && progress < 100
                ? `Uploading ${progress}%`
                : "Publishing…"
              : "Publish"}
            {!busy && (
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                <path fillRule="evenodd" d="M7.3 14.7a1 1 0 0 1 0-1.4L10.58 10 7.3 6.7a1 1 0 1 1 1.4-1.4l4 4a1 1 0 0 1 0 1.4l-4 4a1 1 0 0 1-1.4 0z" clipRule="evenodd" />
              </svg>
            )}
          </button>
          <p className="text-xs text-gray-400 max-w-xs">
            Rendered on a separate domain, so a published page can never reach your account.
          </p>
        </div>
      </div>
    </div>
  );
}
